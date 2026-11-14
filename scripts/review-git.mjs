// Reads the files a behavior review needs from a git revision (or the working tree) of a robot repo.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isReviewFile, isRobotCode, WORKTREE } from "../app/src/suite/core/review/report.ts";

const run = promisify(execFile);
const git = async (repo, args) => (await run("git", ["-C", repo, ...args], { maxBuffer: 64 << 20 })).stdout;

/** Git blob ids of files on disk, as `git hash-object` gives them (the same ids a commit of them would have). */
function hashFiles(repo, paths) {
  return new Promise((resolve, reject) => {
    if (!paths.length) return resolve({});
    const child = spawn("git", ["-C", repo, "hash-object", "--stdin-paths"], { cwd: repo });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) return reject(new Error(`git hash-object exited with ${code}`));
      const ids = Buffer.concat(chunks).toString().split("\n");
      resolve(Object.fromEntries(paths.map((p, i) => [p, ids[i]])));
    });
    child.stdin.end(paths.map((p) => `${p}\n`).join(""));
  });
}

/**
 * `{ rev, label, files, code }` for a revision; `WORKTREE` reads tracked and new files from disk.
 * `files` are the texts the review reads; `code` is a content id for every file that ends up on
 * the robot, so the review can say that code it does not read changed.
 */
export async function gitSnapshot(repo, rev) {
  if (rev === WORKTREE) {
    const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
    // -z: paths with spaces or non-ASCII characters come back unquoted.
    const listed = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    const files = {};
    for (const path of listed.filter(isReviewFile)) {
      try {
        files[path] = await readFile(join(root, path), "utf8");
      } catch {
        // Deleted but not yet committed.
      }
    }
    const code = await hashFiles(root, [...new Set(listed)].filter((p) => isRobotCode(p) && existsSync(join(root, p))));
    return { rev, label: "This computer (not committed)", files, code };
  }
  const sha = (await git(repo, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  const subject = (await git(repo, ["log", "-1", "--format=%s", sha])).trim();
  const paths = [];
  const code = {};
  for (const entry of (await git(repo, ["ls-tree", "-r", "-z", "--full-tree", sha])).split("\0")) {
    // "<mode> <type> <id>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, id] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type !== "blob") continue;
    if (isReviewFile(path)) paths.push(path);
    if (isRobotCode(path)) code[path] = id;
  }
  return { rev: sha, label: `${rev === sha ? sha.slice(0, 7) : rev} · ${subject}`, files: await catFiles(repo, sha, paths), code };
}

/** Many blobs in one `git cat-file --batch`. */
function catFiles(repo, sha, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"]);
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) return reject(new Error(`git cat-file exited with ${code}`));
      const all = Buffer.concat(chunks);
      const files = {};
      let at = 0;
      for (const path of paths) {
        const header = all.indexOf(10, at);
        const [, type, size] = all.subarray(at, header).toString().split(" ");
        if (type !== "blob") {
          at = header + 1;
          continue;
        }
        const length = Number(size);
        files[path] = all.subarray(header + 1, header + 1 + length).toString("utf8");
        at = header + 1 + length + 1;
      }
      resolve(files);
    });
    child.stdin.end(paths.map((p) => `${sha}:${p}\n`).join(""));
  });
}
