import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
// Exercise the real worker/parser with a deterministic WPILOG, never mocked worker results.
// @ts-expect-error JavaScript fixture generator has no declaration file.
import { demoLog } from "../../scripts/make-demo-log.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Competition robot", exact: true })).toBeVisible();
});

test("authors an auto, previews it, exports it and reopens it in a new browser", async ({ page, browser }, info) => {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByLabel("New project name").fill("Practice robot");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  await page.getByRole("button", { name: "Create routine", exact: true }).click();
  const field = page.getByLabel("Autonomous field editor");
  await field.click({ position: { x: 220, y: 220 } });
  await expect(page.getByRole("button", { name: "1 Pose 1", exact: true })).toBeVisible();
  await page.getByLabel("State name").fill("Drive to pickup");
  await page.getByLabel("State name").press("Tab");
  await expect(page.getByRole("button", { name: "1 Drive to pickup", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Play simulation", exact: true }).click();
  await expect(page.getByText("Preview completed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Switch project" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export project", exact: true }).click();
  const download = await downloadEvent;
  const path = info.outputPath("authored.mayhem.json");
  await download.saveAs(path);
  const exported = JSON.parse(await readFile(path, "utf8"));
  expect(exported.name).toBe("Practice robot");
  expect(exported.routines.some((r: { nodes: { name: string }[] }) => r.nodes.some(n => n.name === "Drive to pickup"))).toBe(true);
  const routine = exported.routines.find((r: { nodes: { name: string }[] }) => r.nodes.some(n => n.name === "Drive to pickup"));
  await page.reload();
  await page.getByRole("button", { name: routine.name, exact: true }).click();
  await expect(page.getByRole("button", { name: "1 Drive to pickup", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("button", { name: /Competition robot.*1 routines/ }).click();
  await expect(page.getByRole("button", { name: "Collect & score", exact: true })).toBeVisible();
  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await reopened.goto("/");
    await reopened.getByLabel("Import project file").setInputFiles(path);
    await expect(reopened.getByRole("button", { name: "Switch project" })).toContainText("Practice robot");
    await reopened.getByRole("button", { name: "Autonomous", exact: true }).click();
    // Imported projects select the first routine; choose the newly authored one.
    await reopened.getByRole("button", { name: routine.name, exact: true }).click();
    await expect(reopened.getByRole("button", { name: "1 Drive to pickup", exact: true })).toBeVisible();
  } finally { await fresh.close(); }
});

test("imports WPILOG through its worker, persists it and replays it", async ({ page }) => {
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bring in your first log" })).toBeVisible();
  await page.getByLabel("Import recording").first().setInputFiles({ name: "practice.wpilog", mimeType: "application/octet-stream", buffer: demoLog() });
  await expect(page.getByRole("button", { name: "Play log playback" })).toBeVisible();
  await expect(page.getByText(/Min battery/)).toContainText("V");
  await page.getByRole("button", { name: "Signals", exact: true }).click();
  await expect(page.getByLabel("Graph signal")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Play log playback" }).click();
  await expect(page.getByRole("button", { name: "Pause log playback" })).toBeVisible();
  await page.reload();
  const saved = page.getByRole("complementary", { name: "Recordings" }).getByRole("button", { name: /^practice / });
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(page.getByRole("button", { name: "Play log playback" })).toBeVisible();
});

test("simulates state inputs and keeps offline setup across all pages and themes", async ({ page }) => {
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.getByRole("button", { name: /Intake state machine/ }).click();
  await expect(page.locator(".mx-state.is-active")).toContainText("Idle");
  await page.getByRole("switch", { name: "Intake requested" }).click();
  await expect(page.locator(".mx-state.is-active")).toContainText("Acquiring");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".mx-state.is-active")).toContainText("Idle");
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await page.getByLabel("Team number").fill("254");
  await expect(page.getByText(/roborio-254-frc.local/).first()).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("button", { name: `Switch to ${theme} mode` }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const name of ["Overview", "Autonomous", "State machines", "Logs", "Robot", "Changes", "Tasks", "Settings"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  }
  await page.reload();
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await expect(page.getByLabel("Team number")).toHaveValue("254");
});
