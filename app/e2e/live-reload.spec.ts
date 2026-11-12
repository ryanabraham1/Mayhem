import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The desktop bridge, faked: project-file commands read and write a real file on disk, so the
// test can change it underneath the app the way an agent or generator does.
async function desktop(page: Page, file: string) {
  // While frozen, reads return the file as it was when frozen (to order events deterministically).
  const control = { frozen: null as unknown };
  await page.exposeFunction("__mayhemInvoke", (cmd: string, args: Record<string, any>) => {
    if (cmd === "plugin:dialog|open") return file;
    if (cmd === "read_suite_project") return control.frozen ?? JSON.parse(readFileSync(args.path, "utf8"));
    if (cmd === "write_suite_project") {
      const disk = JSON.parse(readFileSync(args.path, "utf8"));
      if (args.expectedRevision !== null && disk.revision !== args.expectedRevision)
        throw new Error(`Project changed on disk (revision ${disk.revision}, expected ${args.expectedRevision})`);
      writeFileSync(args.path, JSON.stringify(args.project, null, 2));
      return null;
    }
    return null;
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => (window as any).__mayhemInvoke(cmd, args),
      transformCallback: () => 0,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
  });
  return {
    freeze: (on: boolean) => (control.frozen = on ? JSON.parse(readFileSync(file, "utf8")) : null),
  };
}
const machine = (states: string[], extra: object = {}) => ({
  format: "mayhem-machine", version: 1, id: "ShotCycle", name: "Shot cycle", initial: states[0],
  states: states.map((id) => ({ id, name: id })),
  inputs: [{ key: "shoot", name: "Shoot", type: "boolean", initial: false, category: "operator" }],
  transitions: states.slice(1).map((to, i) => ({ id: `t${i}`, from: states[i], to, condition: { kind: "signal", key: "shoot", op: "eq", value: true } })),
  ...extra,
});
/** Write like generators do: to a temp file, then rename over the project (atomic). */
const write = (file: string, project: any) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(project, null, 2));
  renameSync(`${file}.tmp`, file);
};

test("the linked project reloads when the file changes on disk, keeping the selection", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  const dir = mkdtempSync(join(tmpdir(), "mayhem-live-"));
  const file = join(dir, "robot.mayhem.json");
  const project = JSON.parse(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
  project.extensions.machines = [machine(["IDLE", "SPIN_UP", "FEED"])];
  write(file, project);
  await desktop(page, file);
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Open project file" }).click();
  await expect(page.locator(".mx-disk-status")).toHaveText("Watching file");

  // Select a machine state, then let a generator replace the machine on disk.
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.getByRole("button", { name: /Shot cycle/ }).first().click();
  await page.locator(".mx-state", { hasText: "SPIN_UP" }).click();
  await expect(page.locator(".mx-inspector h2")).toHaveText("SPIN_UP");
  write(file, { ...project, revision: project.revision + 1, extensions: { ...project.extensions, machines: [machine(["IDLE", "SPIN_UP", "AIM", "FEED"], { name: "Shot cycle v2" })] } });
  await expect(page.locator(".mx-state", { hasText: "AIM" })).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".mx-disk-status")).toHaveText(/^Reloaded from disk · /);
  await expect(page.locator(".mx-inspector h2")).toHaveText("SPIN_UP"); // selection kept
  await expect(page.getByRole("button", { name: /Shot cycle v2/ })).toBeVisible();

  // A broken write keeps the last good version with a visible error, then recovers.
  writeFileSync(file, '{"format": "mayhem-suite", "version": 1, "revision": ');
  await expect(page.getByRole("alert")).toContainText("can't be loaded", { timeout: 5000 });
  await expect(page.locator(".mx-state", { hasText: "AIM" })).toBeVisible();
  write(file, { ...project, revision: project.revision + 2, extensions: { ...project.extensions, machines: [machine(["IDLE", "SPIN_UP", "AIM", "FEED", "DONE"])] } });
  await expect(page.locator(".mx-state", { hasText: "DONE" })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("reloaded.png") });

  // The link survives a relaunch, which picks up whatever was written while the app was closed.
  write(file, { ...project, revision: project.revision + 3, extensions: { ...project.extensions, machines: [machine(["IDLE", "RELAUNCHED"])] } });
  await page.reload();
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.getByRole("button", { name: /Shot cycle/ }).first().click();
  await expect(page.locator(".mx-state", { hasText: "RELAUNCHED" })).toBeVisible({ timeout: 5000 });
});

test("keep mine writes this copy over the changed file", async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  const dir = mkdtempSync(join(tmpdir(), "mayhem-live-"));
  const file = join(dir, "robot.mayhem.json");
  const project = JSON.parse(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
  project.revision = 3;
  write(file, project);
  const bridge = await desktop(page, file);
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Open project file" }).click();
  await expect(page.locator(".mx-disk-status")).toHaveText("Watching file");
  bridge.freeze(true);
  write(file, { ...project, revision: 4, robot: { ...project.robot, name: "Agent robot" } });
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByLabel("Project name").first().fill("Mine wins");
  await page.getByRole("dialog").getByRole("button", { name: "Rename", exact: true }).click();
  bridge.freeze(false);
  const alert = page.getByRole("alert");
  await alert.getByRole("button", { name: "Keep mine" }).click();
  await expect(alert).toHaveCount(0);
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect([disk.name, disk.revision]).toEqual(["Mine wins", 5]);
  await expect(page.locator(".mx-disk-status")).toHaveText("Watching file");
});

test("a disk change while this copy has unsaved edits asks instead of overwriting either", async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  const dir = mkdtempSync(join(tmpdir(), "mayhem-live-"));
  const file = join(dir, "robot.mayhem.json");
  const project = JSON.parse(readFileSync(new URL("../../examples/suite/competition.mayhem.json", import.meta.url), "utf8"));
  project.revision = 10;
  write(file, project);
  const bridge = await desktop(page, file);
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Open project file" }).click();
  await expect(page.locator(".mx-disk-status")).toHaveText("Watching file");
  // An agent rewrites the file while the user renames the project, before the app has read the
  // new file: the app's save is refused (revision moved), so its copy has edits the file lacks.
  bridge.freeze(true);
  write(file, { ...project, revision: 11, robot: { ...project.robot, name: "Agent robot" } });
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByLabel("Project name").first().fill("Renamed here");
  await page.getByRole("dialog").getByRole("button", { name: "Rename", exact: true }).click();
  bridge.freeze(false);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("changed on disk", { timeout: 5000 });
  await alert.getByRole("button", { name: "Show changes" }).click();
  await expect(alert.getByRole("list", { name: "Differences from the file" })).toContainText("Robot setup: changed");
  // The file is untouched until the user chooses.
  expect(JSON.parse(readFileSync(file, "utf8")).robot.name).toBe("Agent robot");
  await alert.getByRole("button", { name: "Load file version" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".mx-toast")).toContainText("Your edits are kept as the project");
});
