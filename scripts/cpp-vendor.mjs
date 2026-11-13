// Copy the Mayhem C++ headers into a robot project and record what was copied.
// Used by `node scripts/mayhem.mjs vendor <robot dir>`. No dependencies.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HEADER_SOURCE = "lib-cpp/include/mayhem";
export const DEFAULT_DEST = "src/main/include/mayhem";
export const SNAPSHOT_NAME = "mayhem-vendor.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readMaybe = (path) => readFile(path).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));

/** Header paths under dir ("pose_driver.hpp", "sim/motor.hpp", ...), "/"-separated. */
async function listHeaders(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await listHeaders(join(dir, entry.name), `${prefix}${entry.name}/`)));
    else if (entry.name.endsWith(".hpp")) out.push(prefix + entry.name);
  }
  return out;
}

/** The headers this Mayhem copy ships (including subdirectories such as sim/), sorted, with their version. */
export async function cppHeaders() {
  const dir = join(ROOT, HEADER_SOURCE);
  let names;
  try {
    names = (await listHeaders(dir)).sort();
  } catch (e) {
    if (e.code === "ENOENT")
      throw new Error(`${HEADER_SOURCE} is missing. Run from a Mayhem source checkout or the Mayhem-suite-tools archive.`);
    throw e;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(dir, name));
      return { name, bytes, sha256: sha256(bytes) };
    }),
  );
  const version = /^#define MAYHEM_CPP_VERSION "([^"]+)"/m.exec(
    files.find((f) => f.name === "version.hpp")?.bytes.toString("utf8") ?? "",
  )?.[1];
  if (!version) throw new Error(`${HEADER_SOURCE}/version.hpp does not define MAYHEM_CPP_VERSION.`);
  return { version, files };
}

/** Git provenance of the headers, when this is a checkout. */
function provenance() {
  try {
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commit = git("rev-parse", "HEAD");
    const modified = git("status", "--porcelain", "--", HEADER_SOURCE) !== "";
    return modified ? { commit, modified } : { commit };
  } catch {
    return {};
  }
}

/**
 * Copy (or with check: compare) every header into <robotDir>/<dest> and write a snapshot
 * (version, source commit, sha256 per file). Only files listed in the previous snapshot are
 * ever removed. A check compares file contents only, never the recorded commit.
 */
export async function vendorCpp(robotDir, { dest = DEFAULT_DEST, snapshot, check = false } = {}) {
  if (typeof robotDir !== "string" || !robotDir) throw new Error("A robot project directory is required.");
  const robot = resolve(robotDir);
  const target = resolve(robot, dest);
  const snapshotPath = snapshot ? resolve(robot, snapshot) : join(target, SNAPSHOT_NAME);
  const inside = (p) => p === robot || p.startsWith(robot + sep);
  if (!inside(target) || !inside(snapshotPath))
    throw new Error("The header and snapshot destinations must be inside the robot project.");
  const { version, files } = await cppHeaders();
  const previousText = await readMaybe(snapshotPath);
  let previous = {};
  if (previousText)
    try {
      previous = JSON.parse(previousText.toString("utf8"));
    } catch {
      throw new Error(`${snapshotPath} is not valid JSON.`);
    }
  const current = new Set(files.map((f) => f.name));
  const obsolete = Object.keys(previous.sha256 ?? {}).filter(
    (name) => !current.has(name) && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.hpp$/.test(name),
  );
  const shown = (p) => relative(robot, p).split(sep).join("/");
  if (check) {
    const problems = [];
    for (const f of files) {
      const existing = await readMaybe(join(target, f.name));
      if (!existing) problems.push(`${shown(join(target, f.name))} is missing`);
      else if (sha256(existing) !== f.sha256) problems.push(`${shown(join(target, f.name))} differs from Mayhem ${version}`);
    }
    for (const name of obsolete)
      if (await readMaybe(join(target, name))) problems.push(`${shown(join(target, name))} is no longer part of Mayhem`);
    if (!previousText) problems.push(`${shown(snapshotPath)} is missing`);
    else if (previous.version !== version) problems.push(`${shown(snapshotPath)} records ${previous.version ?? "no version"}, not ${version}`);
    return { upToDate: problems.length === 0, version, problems };
  }
  await mkdir(target, { recursive: true });
  const written = [];
  for (const f of files) {
    const path = join(target, f.name);
    const existing = await readMaybe(path);
    if (existing && sha256(existing) === f.sha256) continue;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, f.bytes);
    await rename(temporary, path);
    written.push(shown(path));
  }
  const removed = [];
  for (const name of obsolete) {
    const path = join(target, name);
    if (await readMaybe(path)) {
      await rm(path);
      removed.push(shown(path));
    }
  }
  const record = {
    format: "mayhem-cpp-vendor",
    version,
    repository: "https://github.com/ryanabraham1/Mayhem",
    source: HEADER_SOURCE,
    ...provenance(),
    note: "Generated by `node scripts/mayhem.mjs vendor`. Do not edit the vendored headers; re-run it to update and `--check` in CI.",
    sha256: Object.fromEntries(files.map((f) => [f.name, f.sha256])),
  };
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(record, null, 2) + "\n");
  return { version, dest: shown(target), snapshot: shown(snapshotPath), written, removed, files: files.map((f) => f.name) };
}
