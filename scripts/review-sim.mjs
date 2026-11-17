// Sim proof runner for the CLI/MCP: the same steps as the desktop app (app/src-tauri/src/review_sim.rs).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

const PROBE_PATH = "src/test/cpp/MayhemReviewProbe.cpp";

/**
 * Copies `paths` (relative to `from`) into `to`, rewriting only files whose content changed so
 * Gradle stays incremental, and deletes files an earlier sync copied that are gone now (`manifest`
 * lists them). Returns whether anything changed; without a manifest, always true.
 */
export async function syncFiles(from, paths, to, manifest) {
  const before = await readFile(manifest, "utf8").catch(() => null);
  let changed = before === null;
  const synced = [];
  for (const path of paths) {
    if (path === PROBE_PATH) continue; // written separately
    const text = await readFile(join(from, path)).catch(() => null);
    if (!text) continue;
    synced.push(path);
    const dest = join(to, path);
    if ((await readFile(dest).catch(() => null))?.equals(text)) continue;
    changed = true;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text);
    await stat(join(from, path)).then((s) => chmod(dest, s.mode), () => {});
  }
  const kept = new Set(synced);
  for (const gone of (before ?? "").split("\0").filter((p) => p && !kept.has(p))) {
    if (await unlink(join(to, gone)).then(() => true, () => false)) changed = true;
  }
  await mkdir(to, { recursive: true });
  await writeFile(manifest, synced.join("\0"));
  return changed;
}

async function writeProbe(src, probe) {
  const path = join(src, PROBE_PATH);
  if ((await readFile(path, "utf8").catch(() => null)) === probe) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, probe);
}

/** Copies a commit's files into `dest`. */
async function exportRevision(root, rev, dest) {
  await mkdir(dest, { recursive: true });
  await new Promise((done, fail) => {
    const archive = spawn("git", ["-C", root, "archive", "--format=tar", rev]);
    const tar = spawn("tar", ["-x", "-C", dest]);
    archive.stdout.pipe(tar.stdin);
    tar.on("close", (code) => (code ? fail(new Error(`Could not export ${rev}`)) : done()));
    archive.on("error", fail);
  });
}

/**
 * Holds `<dir>/lock` while building in a folder the app and the CLI share (creating a folder is
 * atomic); returns the release. A lock older than any build is left over from a crash.
 */
async function lockDir(dir) {
  const STALE = 20 * 60 * 1000, lock = join(dir, "lock"), start = Date.now();
  await mkdir(dir, { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      return () => rmdir(lock).catch(() => {});
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE) await rmdir(lock).catch(() => {});
      else if (Date.now() - start > STALE) throw new Error(`Another sim proof has been building in ${dir} for too long.`);
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function gradleBuild(src, sha) {
  const env = { ...process.env, MAYHEM_BUILD_SHA: sha, MAYHEM_BUILD_BRANCH: "sim proof", ...((await javaHome()) ? { JAVA_HOME: await javaHome() } : {}) };
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  if (!existsSync(join(src, gradlew))) throw new Error(`No Gradle wrapper (${gradlew}) at the top of the robot repository: the sim proof builds from ${src}.`);
  const task = `installFrcUserProgramTest${platform[0]}ReleaseGoogleTestExe`;
  let log = "";
  for (const offline of [true, false]) {
    try {
      const out = await run(gradlew, [task, "-q", ...(offline ? ["--offline"] : [])], { cwd: src, env, maxBuffer: 64 << 20 });
      log = out.stdout + out.stderr;
      if (existsSync(exePath(src))) return;
    } catch (e) {
      log = `${e.stdout ?? ""}${e.stderr ?? e.message}`;
    }
  }
  throw new Error(`The robot code did not build:\n${log.split("\n").slice(-40).join("\n")}`);
}

/** Marks a sim folder as in use now, so a prune elsewhere leaves it alone. */
async function touch(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "used"), "");
}

/**
 * Keeps the sim cache small (same rules as the desktop app): marks `dir` used, keeps the 4 most
 * recently used commit builds, deletes anything unused for 10 days. Folders used in the last two
 * hours are never deleted: another proof (the app or another CLI run) may be building in them.
 */
async function prune(dir) {
  const KEEP = 4, MAX_AGE = 10 * 24 * 3600 * 1000, BUSY = 2 * 3600 * 1000;
  await touch(dir);
  const root = dirname(dir);
  const entries = [];
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name);
    if (path === dir) continue;
    if (!(await stat(path).then((s) => s.isDirectory(), () => false))) continue;
    // A folder without the mark is still being set up: its own age counts.
    const used = await stat(join(path, "used")).catch(() => stat(path)).then((s) => s.mtimeMs, () => 0);
    // One per repo, not per commit: kept until unused for MAX_AGE.
    entries.push({ path, used, worktree: name.startsWith("worktree-") || name.startsWith("build-") });
  }
  entries.sort((a, b) => b.used - a.used);
  let kept = 1;
  for (const e of entries) {
    const age = Date.now() - e.used;
    if (age < BUSY) {
      if (!e.worktree) kept++;
    } else if (age > MAX_AGE || (!e.worktree && kept >= KEEP)) await rm(e.path, { recursive: true, force: true });
    else if (!e.worktree) kept++;
  }
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
      const ready = async () => existsSync(exePath(src)) && (await readFile(stamp, "utf8").catch(() => "")) === hash(probe);
      await touch(dir);
      if (rev === WORKTREE) {
        // Built in place, incrementally. Same files as last time: keep the build and its runs.
        const paths = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
        const changed = await syncFiles(root, paths, src, join(dir, "files"));
        if (!changed && (await ready())) {
          await prune(dir);
          return { dir, cached: true };
        }
        await rm(stamp, { force: true });
        // Earlier runs of the working tree came from other code.
        await rm(join(dir, "runs"), { recursive: true, force: true });
        await writeProbe(src, probe);
        await gradleBuild(src, sha);
        await writeFile(stamp, hash(probe));
        await prune(dir);
        return { dir, cached: false };
      }
      if (await ready()) {
        await prune(dir);
        return { dir, cached: true };
      }
      await rm(stamp, { force: true });
      await exportRevision(root, sha, src);
      // Compile in the repo's one commit build folder, where only the files that differ from the
      // last commit built are recompiled (Gradle's C++ builds track absolute paths, so a fresh
      // folder is a full build), then copy the program next to this commit's files.
      const shared = join(homedir(), ".mayhem/review-sim", `build-${hash(root)}`), sharedSrc = join(shared, "src");
      const release = await lockDir(shared);
      try {
        await touch(shared);
        const paths = (await git(root, ["ls-tree", "-r", "-z", "--name-only", sha])).split("\0").filter(Boolean);
        await syncFiles(src, paths, sharedSrc, join(shared, "files"));
        await writeProbe(sharedSrc, probe);
        await gradleBuild(sharedSrc, sha);
        const install = (s) => join(s, "build/install/frcUserProgramTest");
        await rm(install(src), { recursive: true, force: true });
        await cp(install(sharedSrc), install(src), { recursive: true, mode: constants.COPYFILE_FICLONE });
        // The build stamp the robot logs at boot (written by the build, not committed).
        const buildJson = "src/main/deploy/mayhem-build.json";
        if (existsSync(join(sharedSrc, buildJson))) await copyFile(join(sharedSrc, buildJson), join(src, buildJson)).catch(() => {});
      } finally {
        await release();
      }
      await writeProbe(src, probe);
      await writeFile(stamp, hash(probe));
      await prune(dir);
      return { dir, cached: false };
    },
    async run(dir, id, scenario) {
      const src = join(dir, "src"), out = join(dir, "runs", id), input = join(out, "scenario.json");
      if (!existsSync(exePath(src))) throw new Error(`The sim build in ${dir} is gone (cleaned up by another proof?). Run the sim proof again.`);
      await touch(dir);
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
