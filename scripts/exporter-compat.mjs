// Which Mayhem commits generate the same robot C++ header as this checkout.
//
// A robot repo pins its exporter to a Mayhem commit (docs/mayhem/vendor-snapshot.json) and its CI
// runs `cpp --check` with that commit. Before the app or save_project rewrites the robot's
// MayhemProject.h with this checkout's exporter, it checks that the pinned commit's exporter
// produces the same output, so it never writes a header the robot's CI would call stale.
//
// "Same output" is measured by running each exporter on a fixed corpus of projects and hashing
// the headers (a fingerprint). That ignores edits elsewhere in files the exporter imports, which
// a source comparison would not. Results per commit never change, so they are cached in the git
// directory.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Fixed inputs. Only ever add to this list together with a cache version bump. */
export const CORPUS = [
  "examples/suite/competition.mayhem.json",
  "examples/suite/example-robot.mayhem.json",
  // A conditional pass-through before a capped step: its path preview changed in 0.14.0 (the
  // look-ahead continues through an open exit).
  "examples/suite/gate.mayhem.json",
];
const CACHE_VERSION = 3;

const run = (cmd, args, opts = {}) =>
  new Promise((done, fail) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (error, stdout, stderr) =>
      error ? fail(Object.assign(error, { stderr })) : done(stdout),
    ),
  );
const git = (root, ...args) => run("git", ["-C", root, ...args]).then((s) => s.trim());

export const fingerprint = (headers) => {
  const hash = createHash("sha256");
  for (const h of headers) hash.update(`${Buffer.byteLength(h)}\n`).update(h);
  return hash.digest("hex");
};

/** The corpus the fingerprint runs on, read from this checkout so every commit gets the same inputs. */
const corpusFiles = (root = ROOT) => CORPUS.map((f) => join(root, f));

/**
 * Fingerprint of the exporter in this checkout's working tree (what this process or build runs).
 * `exporter` (project file text -> header) runs it in process instead of through the CLI.
 */
export async function selfFingerprint(root = ROOT, exporter) {
  const headers = [];
  for (const file of corpusFiles(root))
    headers.push(exporter ? exporter(await readFile(file, "utf8")) : await run(process.execPath, [join(root, "scripts/mayhem.mjs"), "cpp", file]));
  return fingerprint(headers);
}

async function cacheDir(root) {
  const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const dir = join(common, "mayhem-exporter-cache", `v${CACHE_VERSION}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Fingerprint of the exporter at `commit` (null when that commit's exporter can't read the
 * corpus or has no `cpp` command). Throws when git or the commit is unavailable.
 */
export async function commitFingerprint(commit, root = ROOT) {
  const full = await git(root, "rev-parse", "--verify", `${commit}^{commit}`);
  const dir = await cacheDir(root);
  const cached = await readFile(join(dir, full), "utf8").catch(() => undefined);
  if (cached !== undefined) return cached.trim() || null;
  const work = await mkdtemp(join(tmpdir(), "mayhem-exporter-"));
  let result = null;
  try {
    // Only the files mayhem.mjs loads; no install step is needed to run it.
    const archive = join(work, "src.tar");
    await run("git", ["-C", root, "archive", "--format=tar", "-o", archive, full, "scripts", "app/src"]);
    await run("tar", ["-xf", archive, "-C", work]);
    try {
      const headers = [];
      for (const file of corpusFiles(root))
        headers.push(await run(process.execPath, [join(work, "scripts/mayhem.mjs"), "cpp", file], { cwd: work }));
      result = fingerprint(headers);
    } catch {
      result = null;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await writeFile(join(dir, full), result ?? "");
  return result;
}

/**
 * Whether the exporter at `commit` writes the same headers as this checkout:
 * { status: "same" | "different" | "unknown", reason? }.
 */
export async function compareWithCommit(commit, root = ROOT, exporter) {
  try {
    const [self, pinned] = await Promise.all([selfFingerprint(root, exporter), commitFingerprint(commit, root)]);
    return pinned === self ? { status: "same" } : { status: "different" };
  } catch (e) {
    return { status: "unknown", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/**
 * Every release commit (v* tags, plus HEAD when the exporter is unmodified) whose exporter
 * matches this working tree. Built into the desktop app, which has no git at run time.
 */
export async function exporterTable(root = ROOT) {
  const self = await selfFingerprint(root);
  const tags = (await git(root, "tag", "--list", "v*")).split("\n").filter(Boolean);
  const commits = new Set();
  for (const tag of tags) commits.add(await git(root, "rev-parse", `${tag}^{commit}`));
  const compatible = [], known = [];
  for (const commit of commits) {
    known.push(commit);
    if ((await commitFingerprint(commit, root)) === self) compatible.push(commit);
  }
  // HEAD itself when the exporter in the working tree is what HEAD committed.
  const head = await git(root, "rev-parse", "HEAD");
  if (!known.includes(head)) {
    known.push(head);
    if ((await commitFingerprint(head, root)) === self) compatible.push(head);
  }
  return { fingerprint: self, compatible: compatible.sort(), known: known.sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  if (command === "compare" && arg) console.log(JSON.stringify(await compareWithCommit(arg)));
  else if (command === "table") console.log(JSON.stringify(await exporterTable(), null, 2));
  else {
    console.error("Usage: node scripts/exporter-compat.mjs table | compare <commit>");
    process.exitCode = 2;
  }
}
