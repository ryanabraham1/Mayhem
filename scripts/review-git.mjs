// Reads the files a behavior review needs from a git revision (or the working tree) of a robot repo.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isReviewFile, isRobotCode, WORKTREE } from "../app/src/suite/core/review/report.ts";
import { PROOF_NOTES, parseProofNote, withProof } from "../app/src/suite/core/review/proofs.ts";

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

const ok = (promise) => promise.then(() => true, () => false);
const sha = async (repo, rev) => (await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).catch(() => "")).trim() || undefined;

/** The version a robot repo is reviewed against: `origin/main` when it has been fetched, else `main`. */
export async function mainRef(repo) {
  for (const rev of ["origin/main", "main"]) {
    const id = await sha(repo, rev);
    if (id) return { rev, sha: id };
  }
  return undefined;
}

/**
 * Whether the history of `target` includes the change `base..tip`: as the same commits (a merge
 * or fast-forward), as equivalent commits (a rebase), or as one commit with the same total patch
 * (a squash merge). `undefined` when this clone does not have `target`.
 */
export async function reaches(repo, base, tip, target) {
  const to = await sha(repo, target);
  if (!to) return undefined;
  if (await ok(git(repo, ["merge-base", "--is-ancestor", tip, to]))) return true;
  if (base === tip) return false;
  const rebased = (await git(repo, ["cherry", to, tip, base]).catch(() => "")).split("\n").filter(Boolean);
  if (rebased.length && rebased.every((line) => line.startsWith("-"))) return true;
  // One commit carrying the whole change, as a squash merge makes; never referenced, so git drops it.
  const squashed = (
    await git(repo, ["-c", "user.name=Mayhem", "-c", "user.email=mayhem@localhost", "commit-tree", `${tip}^{tree}`, "-p", base, "-m", "Mayhem: is this change in there?"]).catch(() => "")
  ).trim();
  if (!squashed) return false;
  return (await git(repo, ["cherry", to, squashed, base]).catch(() => "")).split("\n").some((line) => line.startsWith("-"));
}

/** How many of the newest branches are looked at. */
const BRANCHES = 30;

/**
 * Branches of a robot repo as changes to review: each with the commit it left main at (`base`),
 * how many commits it adds, and whether main already has it. Newest first. Main itself, and
 * branches that add nothing main could not already tell apart, are left out.
 */
export async function reviewBranches(repo) {
  const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  const main = await mainRef(root);
  if (!main) return { branches: [] };
  const listed = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)", "refs/heads", "refs/remotes/origin"]);
  const seen = new Set();
  const branches = [];
  for (const line of listed.split("\n").filter(Boolean)) {
    const [ref, tip, date, author, ...subject] = line.split("\t");
    const local = ref.startsWith("refs/heads/");
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
    // The same commits under two names (a local branch and a renamed one on GitHub) are one change.
    if (name === "HEAD" || name === "main" || name === "master" || tip === main.sha || seen.has(name) || seen.has(tip)) continue;
    seen.add(name).add(tip);
    if (branches.length >= BRANCHES) break;
    let base = (await git(root, ["merge-base", main.sha, tip]).catch(() => "")).trim();
    if (!base) continue;
    let merged = false;
    if (base === tip) {
      // Already an ancestor of main. What it changed is known only if a merge commit brought it in.
      const merge = (await git(root, ["rev-list", "--ancestry-path", "--merges", "--reverse", `${tip}..${main.sha}`]).catch(() => "")).split("\n")[0];
      base = merge ? (await git(root, ["merge-base", `${merge}^1`, tip]).catch(() => "")).trim() : "";
      if (!base || base === tip) continue;
      merged = true;
    } else merged = (await reaches(root, base, tip, main.sha)) === true;
    const ahead = Number((await git(root, ["rev-list", "--count", `${base}..${tip}`])).trim());
    branches.push({ name, rev: local ? name : `origin/${name}`, sha: tip, base, ahead, subject: subject.join("\t"), author, date, merged });
  }
  return { main, branches };
}

/** The sim proof notes of `commits`, each as its text or null. */
export async function readProofNotes(repo, commits) {
  return Promise.all(commits.map((commit) => git(repo, ["notes", `--ref=${PROOF_NOTES}`, "show", commit]).catch(() => null)));
}

/** Keeps `proof` on `commit` (a full commit id), next to earlier runs against other versions. */
export async function recordProof(repo, commit, proof) {
  const id = await sha(repo, commit);
  if (!id) throw new Error(`${commit} is not a commit in this repository.`);
  const [current] = await readProofNotes(repo, [id]);
  await git(repo, ["-c", "user.name=Mayhem", "-c", "user.email=mayhem@localhost", "notes", `--ref=${PROOF_NOTES}`, "add", "-f", "-m", withProof(current, proof), id]);
  return parseProofNote((await readProofNotes(repo, [id]))[0]);
}
