import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ES module without types
import { bridgeState, createBridge } from "../../scripts/desktop-bridge.mjs";

const NO_FAKE = /has no fake for the desktop command/;

/** Every native command the app's source invokes, and the plugin calls its imports make. */
function commandsInSource(dir = join(process.cwd(), "src")): Set<string> {
  const found = new Set<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) commandsInSource(path).forEach((c) => found.add(c));
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z_]+)["']/g)) found.add(m[1]);
      for (const m of text.matchAll(/["']@tauri-apps\/plugin-(\w+)["']/g)) found.add(`plugin:${m[1]}|`);
      // @tauri-apps/api modules that call into the app (core's invoke is covered above; event is plugin:event).
      if (/["']@tauri-apps\/api\/app["']/.test(text)) found.add("plugin:app|version");
      if (/["']@tauri-apps\/api\/event["']/.test(text)) found.add("plugin:event|listen");
    }
  }
  return found;
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
  return dir;
}

describe("desktop bridge", () => {
  it("fakes every native command the app uses", async () => {
    const commands = [...commandsInSource()];
    expect(commands.length).toBeGreaterThan(30);
    const handle = createBridge(bridgeState(repo()));
    const missing: string[] = [];
    for (const cmd of commands) {
      // Plugins: the calls their JS wrappers make.
      const calls = cmd === "plugin:dialog|" ? ["plugin:dialog|open", "plugin:dialog|save", "plugin:dialog|message"] : cmd === "plugin:shell|" ? ["plugin:shell|open"] : cmd === "plugin:updater|" ? ["plugin:updater|check"] : cmd === "plugin:process|" ? ["plugin:process|restart"] : [cmd];
      for (const call of calls)
        try {
          await handle(call, { path: "/nonexistent", paths: [], targets: [], commits: [], directory: "/nonexistent", token: "" });
        } catch (e) {
          if (NO_FAKE.test(String((e as Error).message))) missing.push(call);
        }
    }
    expect(missing).toEqual([]);
    await expect(handle("made_up_command", {})).rejects.toThrow(NO_FAKE);
  });

  it("saves projects like the desktop app: revisions advance by one and a stale save is refused", async () => {
    const dir = repo();
    const handle = createBridge(bridgeState(dir));
    const path = join(dir, "robot.mayhem.json");
    const project = { format: "mayhem-suite", version: 1, revision: 0 };
    await handle("write_suite_project", { path, project, expectedRevision: null });
    await expect(handle("write_suite_project", { path, project: { ...project, revision: 1 }, expectedRevision: null })).rejects.toThrow(/changed on disk/);
    await expect(handle("write_suite_project", { path, project: { ...project, revision: 2 }, expectedRevision: 0 })).rejects.toThrow(/advance by one/);
    await handle("write_suite_project", { path, project: { ...project, revision: 1 }, expectedRevision: 0 });
    expect((await handle("read_suite_project", { path })).revision).toBe(1);
    expect(await handle("read_suite_project", { path: join(dir, "missing.json"), allowMissing: true })).toBeNull();
    expect(await handle("review_git_root", { path })).toBe(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"]).toString().trim());
  });

  it("moves logs between a fake robot, the library and a fake team site, recording what it opens", async () => {
    const dir = repo();
    const state = bridgeState(dir, join(dir, ".data"));
    const handle = createBridge(state);
    await expect(handle("list_robot_logs", { host: "10.32.56.2", directory: "/home/lvuser/logs" })).rejects.toThrow(/no route to host/);
    state.robot.logs = join(dir, "robot-logs");
    mkdirSync(state.robot.logs);
    writeFileSync(join(state.robot.logs, "match1.wpilog"), "WPILOG bytes");
    const [log] = await handle("list_robot_logs", { host: "10.32.56.2", directory: "/home/lvuser/logs" });
    expect(log).toEqual({ name: "match1.wpilog", path: "/home/lvuser/logs/match1.wpilog", size: 12 });
    const local = await handle("download_robot_log", { host: "10.32.56.2", remote: log.path, expectedSize: 12 });
    const hash = createHash("sha256").update("WPILOG bytes").digest("hex");
    const saved = await handle("archive_log_file", { path: local, expectedHash: hash });
    expect(saved).toBe(join(dir, ".data", "recordings", `${hash}.wpilog`));
    await handle("reveal_log_file", { path: saved });
    expect(state.opened).toEqual([{ kind: "reveal", target: saved }]);
    await expect(handle("list_team_logs", { site: "https://team.example", token: "" })).rejects.toThrow(/device token/);
    await handle("upload_team_log", { path: saved, site: "https://team.example", token: "t", name: "match1.wpilog", expectedHash: hash });
    const page = await handle("list_team_logs", { site: "https://team.example", token: "t" });
    expect(page.logs.map((l: { name: string }) => l.name)).toEqual(["match1.wpilog"]);
    const back = await handle("download_team_log", { site: "https://team.example", token: "t", sha256: hash, name: "match1.wpilog" });
    expect(readFileSync(back, "utf8")).toBe("WPILOG bytes");
    await expect(handle("delete_library_file", { path: local })).rejects.toThrow(/own library folder/);
    await handle("delete_library_file", { path: saved });
    expect(existsSync(saved)).toBe(false);
  });

  it("records merges and main updates instead of doing them", async () => {
    const state = bridgeState(repo());
    const handle = createBridge(state);
    expect(await handle("review_pr_merge", { repo: state.repo, number: 7, method: "squash", head: "a".repeat(40) })).toMatch(/nothing was merged/);
    expect((await handle("review_update_main", { repo: state.repo, keepEdits: true })).status).toBe("updated");
    expect(state.merges).toEqual([{ number: 7, method: "squash", head: "a".repeat(40) }]);
    expect(state.mainUpdates).toEqual([{ keepEdits: true }]);
  });
});
