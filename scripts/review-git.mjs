// Reads the files a behavior review needs from a git revision (or the working tree) of a robot repo.
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isReviewFile, WORKTREE } from "../app/src/suite/core/review/report.ts";

const run = promisify(execFile);
const git = async (repo, args) => (await run("git", ["-C", repo, ...args], { maxBuffer: 64 << 20 })).stdout;

/** `{ rev, label, files }` for a revision; `WORKTREE` reads tracked and new files from disk. */
export async function gitSnapshot(repo, rev) {
  if (rev === WORKTREE) {
    const listed = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n").filter(isReviewFile);
    const files = {};
    for (const path of listed) {
      try {
        files[path] = await readFile(join(repo, path), "utf8");
      } catch {
        // Deleted but not yet committed.
      }
    }
    return { rev, label: "This computer (not committed)", files };
  }
  const sha = (await git(repo, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  const subject = (await git(repo, ["log", "-1", "--format=%s", sha])).trim();
  const paths = (await git(repo, ["ls-tree", "-r", "--name-only", sha])).split("\n").filter(isReviewFile);
  return { rev: sha, label: `${rev === sha ? sha.slice(0, 7) : rev} · ${subject}`, files: await catFiles(repo, sha, paths) };
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
