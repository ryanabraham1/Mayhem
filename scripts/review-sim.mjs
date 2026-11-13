// Sim proof runner for the CLI/MCP: the same steps as the desktop app (app/src-tauri/src/review_sim.rs).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseWPILog } from "../app/src/suite/core/wpilog.ts";
import { WORKTREE } from "../app/src/suite/core/review/report.ts";

const run = promisify(execFile);
const git = async (repo, args) => (await run("git", ["-C", repo, ...args], { maxBuffer: 64 << 20 })).stdout;
export const PROBE = fileURLToPath(new URL("../app/src/suite/core/review/probe.cpp", import.meta.url));
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const platform = process.platform === "darwin" ? ["Osxuniversal", "osxuniversal"] : process.platform === "win32" ? ["Windowsx86-64", "windowsx86-64"] : ["Linuxx86-64", "linuxx86-64"];
const exePath = (src) => join(src, "build/install/frcUserProgramTest", platform[1], "release", process.platform === "win32" ? "frcUserProgramTest.exe" : "frcUserProgramTest");

async function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const years = (await readdir(join(homedir(), "wpilib")).catch(() => [])).sort().reverse();
  return years.map((y) => join(homedir(), "wpilib", y, "jdk")).find(existsSync);
}

async function exportRevision(root, rev, dest) {
  await mkdir(dest, { recursive: true });
  if (rev === WORKTREE) {
    const listed = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (const path of listed) {
      const from = join(root, path), to = join(dest, path);
      const text = await readFile(from).catch(() => null);
      if (!text || (await readFile(to).catch(() => null))?.equals(text)) continue;
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    return;
  }
  await new Promise((done, fail) => {
    const archive = spawn("git", ["-C", root, "archive", "--format=tar", rev]);
    const tar = spawn("tar", ["-x", "-C", dest]);
    archive.stdout.pipe(tar.stdin);
    tar.on("close", (code) => (code ? fail(new Error(`Could not export ${rev}`)) : done()));
    archive.on("error", fail);
  });
}

/** A SimRunner (core/review/simproof.ts) for a robot repo on this computer. */
export async function nodeRunner(repo) {
  const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  const probe = await readFile(PROBE, "utf8");
  return {
    async prepare(rev) {
      const sha = rev === WORKTREE ? WORKTREE : (await git(root, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
      const dir = join(homedir(), ".mayhem/review-sim", rev === WORKTREE ? `worktree-${hash(root)}` : sha);
      const src = join(dir, "src"), stamp = join(dir, "probe.sha");
      if (rev !== WORKTREE && existsSync(exePath(src)) && (await readFile(stamp, "utf8").catch(() => "")) === hash(probe)) return { dir, cached: true };
      await exportRevision(root, rev, src);
      await writeFile(join(src, "src/test/cpp/MayhemReviewProbe.cpp"), probe);
      const env = { ...process.env, ...((await javaHome()) ? { JAVA_HOME: await javaHome() } : {}) };
      const task = `installFrcUserProgramTest${platform[0]}ReleaseGoogleTestExe`;
      let log = "";
      for (const offline of [true, false]) {
        try {
          const out = await run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", [task, "-q", ...(offline ? ["--offline"] : [])], { cwd: src, env, maxBuffer: 64 << 20 });
          log = out.stdout + out.stderr;
          if (existsSync(exePath(src))) break;
        } catch (e) {
          log = `${e.stdout ?? ""}${e.stderr ?? e.message}`;
        }
      }
      if (!existsSync(exePath(src))) throw new Error(`The robot code did not build:\n${log.split("\n").slice(-40).join("\n")}`);
      await writeFile(stamp, hash(probe));
      if (rev === WORKTREE) await rm(join(dir, "runs"), { recursive: true, force: true });
      return { dir, cached: false };
    },
    async run(dir, id, scenario) {
      const src = join(dir, "src"), out = join(dir, "runs", id), input = join(out, "scenario.json");
      const find = async () => (await readdir(out).catch(() => [])).find((f) => f.endsWith(".wpilog"));
      if ((await readFile(input, "utf8").catch(() => null)) === scenario && existsSync(join(out, "done"))) {
        const log = await find();
        return { log: log && join(out, log), result: await readFile(join(out, "result.json"), "utf8").catch(() => null), ok: true, output: "" };
      }
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      await writeFile(input, scenario);
      let output = "", ok = true;
      try {
        const r = await run(exePath(src), ["--gtest_filter=MayhemReviewProbe.*"], {
          cwd: src,
          maxBuffer: 64 << 20,
          env: { ...process.env, ROBOT_DEPLOY_DIR: join(src, "src/main/deploy"), ROBOT_LOG_DIR: out, MAYHEM_SCENARIO: input, MAYHEM_RESULT: join(out, "result.json") },
        });
        output = r.stdout + r.stderr;
        await writeFile(join(out, "done"), "");
      } catch (e) {
        ok = false;
        output = `${e.stdout ?? ""}${e.stderr ?? e.message}`;
      }
      const log = await find();
      return { log: log && join(out, log), result: await readFile(join(out, "result.json"), "utf8").catch(() => null), ok, output: output.split("\n").slice(-30).join("\n") };
    },
    async readLog(path) {
      const buffer = await readFile(path);
      return parseWPILog(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), path.split("/").pop());
    },
  };
}
