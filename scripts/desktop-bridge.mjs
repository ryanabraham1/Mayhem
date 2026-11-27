// The desktop app's native commands (app/src-tauri), implemented in Node so the web build can run
// every page the way the desktop app does: in the browser tests (app/e2e) and the agent's app driver
// (scripts/app.mjs). Files, git and the sim proof are real; the robot, the team website and GitHub
// are fakes held in `state`, so nothing here reaches a real robot, website or pull request.
//
// Every command the app invokes must be handled here: an unknown one throws, and
// app/tests/desktop-bridge.test.ts checks the list against the app's source.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { gitSnapshot, reaches, readProofNotes, reviewBranches } from "./review-git.mjs";
// The sim runner is loaded on first use: it locates its probe file when imported.
const nodeRunner = async (repo) => (await import("./review-sim.mjs")).nodeRunner(repo);

const GENERATED_HEADER = "src/main/include/commands/MayhemProject.h";
const VENDOR_SNAPSHOT = "docs/mayhem/vendor-snapshot.json";
const MAX_PROJECT = 10 * 1024 * 1024;

/**
 * The fakes and recordings a bridge shares with its caller:
 * - `picks`: paths the next file dialogs return, in order (otherwise the repo).
 * - `answers`: buttons the next ask/confirm dialogs click, in order (otherwise the OK one).
 * - `robot`: `stamp` (the build stamp read off the robot; empty = no robot), `deploys` (recorded,
 *   never run) and `logs` (a folder whose .wpilog files the robot "has").
 * - `team`: the team website's library, `{ name, sha256, size, path, uploaded }` each.
 * - `opened`: everything the app asked the computer to open (files, URLs, viewers), recorded.
 * - `merges`, `mainUpdates`: pull request merges and main updates asked for, recorded, not done.
 */
export function bridgeState(repo, dataDir = join(tmpdir(), `mayhem-bridge-${process.pid}`)) {
  return { repo, dataDir, picks: [], answers: [], robot: { stamp: "", deploys: [], logs: "" }, team: [], opened: [], merges: [], mainUpdates: [], opens: [] };
}

/** The app's version from app/package.json (a placeholder where this file isn't on disk, as in unit tests). */
function appVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../app/package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isLog = (path) => /\.(wpilog|json)$/i.test(path);

function readProject(path) {
  if (statSync(path).size > MAX_PROJECT) throw new Error("Project exceeds the current 10 MB limit");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.format !== "mayhem-suite" || value.version !== 1) throw new Error("Expected a Mayhem suite v1 project");
  return value;
}

function localLogs(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`${directory} is not a folder.`);
  const out = [];
  const walk = (folder, depth) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const s = statSync(path);
      if (s.isDirectory() && depth < 1) walk(path, depth + 1);
      else if (s.isFile() && name.endsWith(".wpilog")) out.push({ name, path, size: s.size });
    }
  };
  walk(directory, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** `handle(cmd, args)` for one bridge. `state` from bridgeState(); see it for the fakes. */
export function createBridge(state) {
  const repo = state.repo;
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  const library = join(state.dataDir, "recordings");
  const incoming = join(state.dataDir, "logs");
  return async function handle(cmd, args = {}) {
    // Tauri plugins.
    if (cmd.startsWith("plugin:event|")) return 1;
    if (cmd === "plugin:dialog|open") return state.picks.shift() ?? repo;
    if (cmd === "plugin:dialog|save") return state.picks.shift() ?? process.env.MAYHEM_VIDEO ?? join(tmpdir(), "replay.webm");
    // ask/confirm: the clicked button's label (the OK one unless `answers` says otherwise).
    if (cmd === "plugin:dialog|message" || cmd === "plugin:dialog|ask" || cmd === "plugin:dialog|confirm") {
      const answer = state.answers.shift();
      if (answer !== undefined) return answer;
      return args.buttons?.OkCancelCustom?.[0] ?? args.buttons?.OkCustom ?? "Yes";
    }
    if (cmd === "plugin:shell|open" || cmd === "plugin:opener|open_url") {
      state.opened.push({ kind: "url", target: args.path ?? args.url });
      return null;
    }
    if (cmd === "plugin:updater|check") return null; // no update
    if (cmd === "plugin:app|version") return appVersion();
    if (cmd.startsWith("plugin:process|")) return null;

    // Robot ("On the robot now", deploy, robot logs): a fake roboRIO.
    if (cmd === "robot_build_info") {
      if (!state.robot.stamp) throw new Error("Robot SFTP failed: no route to host");
      return state.robot.stamp;
    }
    if (cmd === "robot_deploy") {
      state.robot.deploys.push({ rev: args.rev, team: args.team });
      state.robot.stamp = JSON.stringify({ sha: git("rev-parse", args.rev), branch: "rollback", dirty: [], builtAt: new Date().toISOString(), builtBy: "mayhem" });
      return "BUILD SUCCESSFUL\nDeployed to roborio-3256-frc.local";
    }
    if (cmd === "list_robot_logs") {
      if (!state.robot.logs) throw new Error("Could not reach the robot: no route to host");
      return localLogs(state.robot.logs).map((l) => ({ ...l, path: `${args.directory}/${l.name}` }));
    }
    if (cmd === "download_robot_log") {
      if (!state.robot.logs) throw new Error("Could not reach the robot: no route to host");
      const source = join(state.robot.logs, basename(args.remote));
      if (statSync(source).size !== args.expectedSize) throw new Error("The log changed during transfer. Wait until recording stops, refresh the list, and retry.");
      mkdirSync(incoming, { recursive: true });
      const target = join(incoming, `${Date.now()}-${basename(args.remote)}`);
      copyFileSync(source, target);
      return target;
    }

    // Project files and the generated header (projects.rs).
    if (cmd === "read_suite_project") {
      if (args.allowMissing && !existsSync(args.path)) return null;
      return readProject(args.path);
    }
    if (cmd === "write_suite_project") {
      const p = args.project;
      if (p?.format !== "mayhem-suite" || p.version !== 1) throw new Error("Invalid project format");
      const actual = existsSync(args.path) ? readProject(args.path).revision : null;
      if ((actual ?? null) !== (args.expectedRevision ?? null))
        throw new Error(`Project changed on disk (revision ${actual === null ? "None" : `Some(${actual})`}). Reopen it before saving to avoid overwriting the other edit.`);
      if (p.revision !== (actual === null ? 0 : actual + 1)) throw new Error("Saved revision must advance by one");
      const text = JSON.stringify(p, null, 2);
      if (text.length > MAX_PROJECT) throw new Error("Project exceeds the current 10 MB limit");
      const temporary = join(dirname(args.path), `.mayhem-${process.hrtime.bigint()}.tmp`);
      writeFileSync(temporary, text);
      renameSync(temporary, args.path);
      return null;
    }
    if (cmd === "generated_header") {
      const header = join(dirname(args.path), GENERATED_HEADER);
      if (!existsSync(header)) return null;
      const snapshot = join(dirname(args.path), VENDOR_SNAPSHOT);
      let pinnedCommit = null;
      if (existsSync(snapshot))
        try {
          pinnedCommit = JSON.parse(readFileSync(snapshot, "utf8")).commit ?? "";
        } catch {
          pinnedCommit = "";
        }
      return { projectText: readFileSync(args.path, "utf8"), headerPath: header, current: readFileSync(header, "utf8"), pinnedCommit };
    }
    if (cmd === "write_generated_header") {
      if (readFileSync(args.path, "utf8") !== args.projectText) return false;
      const header = join(dirname(args.path), GENERATED_HEADER);
      if (existsSync(header) && readFileSync(header, "utf8") === args.code) return true;
      writeFileSync(header, args.code);
      return true;
    }
    if (cmd === "take_opened_projects") return state.opens.splice(0);

    // Git review (review.rs).
    if (cmd === "review_git_root") {
      const dir = existsSync(args.path) && statSync(args.path).isDirectory() ? args.path : dirname(args.path);
      try {
        return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: "pipe" }).toString().trim() || null;
      } catch {
        return null;
      }
    }
    if (cmd === "review_repo")
      return {
        root: repo,
        branch: git("rev-parse", "--abbrev-ref", "HEAD"),
        head: git("rev-parse", "HEAD"),
        dirty: git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3)),
        revisions: [
          ...git("for-each-ref", "--format=%(refname:short)\t%(objectname)\t%(subject)", "refs/heads").split("\n").filter(Boolean).map((l) => {
            const [rev, sha, label] = l.split("\t");
            return { rev, sha, label, kind: "branch", date: "" };
          }),
          ...git("log", "-30", "--format=%H\t%s").split("\n").map((l) => {
            const [sha, subject] = l.split("\t");
            return { rev: sha, sha, label: subject, kind: "commit", date: "" };
          }),
        ],
      };
    if (cmd === "review_snapshot") return gitSnapshot(repo, args.rev);
    if (cmd === "review_branches") {
      const found = await reviewBranches(repo);
      return { main: found.main ?? null, branches: found.branches };
    }
    if (cmd === "review_reaches") return Promise.all(args.targets.map(async (t) => (await reaches(repo, args.base, args.tip, t)) ?? null));
    if (cmd === "review_proofs") return readProofNotes(repo, args.commits);
    if (cmd === "review_proof_save") {
      git("-c", "user.name=Mayhem", "-c", "user.email=mayhem@localhost", "notes", "--ref=refs/notes/mayhem-proof", "add", "-f", "-m", args.text, args.commitId);
      return null;
    }
    if (cmd === "review_history") {
      if (!args.paths.length) return [];
      return git("log", `-${args.limit ?? 8}`, "--format=%H%x1f%s%x1f%an %cr%x1e", "--", ...args.paths).split("\x1e").filter((e) => e.trim()).map((e) => {
        const [sha, subject, body] = e.trim().split("\x1f");
        return { sha, subject, body: body ?? "" };
      });
    }
    if (cmd === "review_commits") {
      const range = `${args.before === "WORKTREE" ? "HEAD" : args.before}..${args.after === "WORKTREE" ? "HEAD" : args.after}`;
      return git("log", "--format=%H%x1f%s%x1f%b%x1e", range).split("\x1e").filter((e) => e.trim()).map((e) => {
        const [sha, subject, body] = e.trim().split("\x1f");
        return { sha, subject, body: body ?? "" };
      });
    }
    if (cmd === "review_write_file") {
      const path = join(repo, args.path);
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== args.expected) throw new Error("changed on disk");
      writeFileSync(path, args.text);
      return null;
    }
    // Sim proof: the CLI's runner (the robot's real Gradle build).
    if (cmd === "review_sim_prepare") return (await nodeRunner(repo)).prepare(args.rev);
    if (cmd === "review_sim_run") return (await nodeRunner(repo)).run(args.dir, args.id, args.scenario);
    // GitHub (github.rs): no pull request unless one is faked; merges and main updates are recorded, not done.
    if (cmd === "review_pr")
      return { kind: "found", prs: state.prs ?? [], repo: { nameWithOwner: "team/robot", mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "MERGE" } };
    if (cmd === "review_pr_merge") {
      state.merges.push({ number: args.number, method: args.method, head: args.head });
      return `Merged pull request #${args.number} (recorded by the test app; nothing was merged).`;
    }
    if (cmd === "review_update_main") {
      state.mainUpdates.push({ keepEdits: args.keepEdits });
      return { status: "updated", message: "On main and up to date (recorded by the test app; nothing was pulled).", edits: [] };
    }

    // Logs: Mayhem's library folder, files on this computer, and the team website (logs.rs).
    if (cmd === "read_log_file" || cmd === "ascope_model") return readFileSync(args.path).toString("base64");
    if (cmd === "list_local_logs") return localLogs(args.directory);
    if (cmd === "archive_log_file") {
      if (!isLog(args.path)) throw new Error("Select a WPILOG or recording JSON file.");
      const bytes = readFileSync(args.path);
      if (sha256(bytes) !== args.expectedHash) throw new Error("Recording changed while being imported. Retry after it finishes writing.");
      mkdirSync(library, { recursive: true });
      const target = join(library, `${args.expectedHash}${extname(args.path)}`);
      if (resolve(args.path) !== target) writeFileSync(target, bytes);
      return target;
    }
    if (cmd === "delete_library_file") {
      if (!existsSync(args.path)) return null;
      if (resolve(dirname(args.path)) !== resolve(library) || !isLog(args.path)) throw new Error("Mayhem only deletes recordings saved in its own library folder.");
      unlinkSync(args.path);
      return null;
    }
    if (cmd === "reveal_log_file" || cmd === "open_log_viewer") {
      if (!existsSync(args.path)) throw new Error("Select a WPILOG or recording JSON file.");
      state.opened.push({ kind: cmd === "reveal_log_file" ? "reveal" : "viewer", target: args.path, ...(args.viewer ? { viewer: args.viewer } : {}) });
      return null;
    }
    if (cmd === "list_team_logs") {
      if (!String(args.token ?? "").trim()) throw new Error("Add a device token to see the team library.");
      return { logs: state.team.map(({ path, ...log }) => log), next: null };
    }
    if (cmd === "upload_team_log") {
      if (!String(args.token ?? "").trim()) throw new Error("Add a device token to share logs with the team.");
      if (!args.path.endsWith(".wpilog")) throw new Error("Cloud sharing currently accepts WPILOG files.");
      const bytes = readFileSync(args.path);
      if (sha256(bytes) !== args.expectedHash) throw new Error("The recording changed while it was being shared.");
      if (!state.team.some((l) => l.sha256 === args.expectedHash))
        state.team.push({ name: args.name, sha256: args.expectedHash, size: bytes.length, path: args.path, uploaded: new Date().toISOString(), device: "this computer" });
      return `${args.site.replace(/\/$/, "")}/logs/${args.expectedHash}`;
    }
    if (cmd === "download_team_log") {
      const log = state.team.find((l) => l.sha256 === args.sha256);
      if (!log) throw new Error("That recording is no longer in the team library.");
      mkdirSync(incoming, { recursive: true });
      const target = join(incoming, `${args.sha256}.wpilog`);
      copyFileSync(log.path, target);
      return target;
    }
    // 3D replay assets: AdvantageScope's folders on this computer.
    if (cmd === "ascope_assets") {
      const base = join(process.env.HOME ?? "", "Library/Application Support/AdvantageScope");
      return ["userAssets", "autoAssets"].flatMap((root) => {
        try {
          return readdirSync(join(base, root))
            .filter((n) => n.startsWith("Robot_") || n.startsWith("Field3d_"))
            .map((n) => {
              const dir = join(base, root, n);
              return { kind: n.startsWith("Robot_") ? "robot" : "field", name: n, dir, config: readFileSync(join(dir, "config.json"), "utf8"), models: readdirSync(dir).filter((f) => /^model.*\.glb$/.test(f)) };
            });
        } catch {
          return [];
        }
      });
    }
    if (cmd === "save_replay_video") {
      writeFileSync(args.path, Buffer.from(args.bytes));
      return null;
    }
    throw new Error(`The test app has no fake for the desktop command "${cmd}". Add it to scripts/desktop-bridge.mjs.`);
  };
}

/** Installs the bridge on a Playwright page: window.__TAURI_INTERNALS__ calls `handle`. */
export async function installBridge(page, handle) {
  await page.exposeFunction("__mayhemInvoke", async (cmd, args) => {
    try {
      return { ok: await handle(cmd, args) };
    } catch (e) {
      return { error: e?.message ?? String(e) };
    }
  });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        const reply = await window.__mayhemInvoke(cmd, args);
        if ("error" in reply) throw reply.error;
        const result = reply.ok;
        // Log bytes cross the fake bridge as base64.
        return cmd === "read_log_file" || cmd === "ascope_model" ? Uint8Array.from(atob(result), (c) => c.charCodeAt(0)).buffer : result;
      },
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
    // listen()'s unlisten calls into the event plugin's own globals.
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
}

/** Removes a bridge's data folder (library, downloads). */
export function clearBridgeData(state) {
  rmSync(state.dataDir, { recursive: true, force: true });
}
