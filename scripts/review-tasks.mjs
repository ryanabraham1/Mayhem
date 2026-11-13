// Feedback/task files in a robot repo (tools/mayhem/review/<id>.json) for the CLI/MCP; same rules
// as the desktop app (app/src-tauri/src/review.rs): ids are plain, writes are atomic and checked.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { REVIEW_DIR, parseItem, serializeItem } from "../app/src/suite/core/review/tasks.ts";

const run = promisify(execFile);
const root = async (repo) => (await run("git", ["-C", repo, "rev-parse", "--show-toplevel"])).stdout.trim();
const plainId = (id) => {
  if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id)) throw new Error(`Bad task id ${id}`);
  return id;
};

export async function listItems(repo) {
  const dir = join(await root(repo), REVIEW_DIR);
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^[\w-]+\.json$/.test(n));
  const items = [];
  for (const name of names) {
    try {
      items.push(parseItem(await readFile(join(dir, name), "utf8")));
    } catch {
      // A malformed or half-written file is skipped, not fatal.
    }
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readItem(repo, id) {
  const text = await readFile(join(await root(repo), REVIEW_DIR, `${plainId(id)}.json`), "utf8").catch(() => {
    throw new Error(`No task ${id}`);
  });
  return { item: parseItem(text), text };
}

/** Writes `item`; `expected` is the file text it was read from (null: must be new). */
export async function saveItem(repo, item, expected) {
  const dir = join(await root(repo), REVIEW_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${plainId(item.id)}.json`);
  const current = await readFile(target, "utf8").catch(() => null);
  if (current !== expected) throw new Error(expected === null ? `${item.id} already exists` : `Task ${item.id} changed meanwhile; read it again.`);
  const temporary = join(dir, `.${item.id}.${process.pid}.tmp`);
  await writeFile(temporary, serializeItem(item));
  try {
    await rename(temporary, target);
  } catch (e) {
    await unlink(temporary).catch(() => {});
    throw e;
  }
  return item;
}
