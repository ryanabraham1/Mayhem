// Screenshots for the documentation site (not part of the regular run): MAYHEM_DOCS_SHOTS=<folder>
// writes one PNG per workspace. Uses MAYHEM_REVIEW_REPO (a robot repo with robot.mayhem.json; run it on
// a throwaway clone, since tasks and explainer text are written into it) and MAYHEM_DOCS_LOG (a .wpilog).
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execute } from "../../scripts/mayhem.mjs";
import { desktop, dialogPicks, fakeRobot } from "./reviewBridge";

const out = process.env.MAYHEM_DOCS_SHOTS;
const repo = process.env.MAYHEM_REVIEW_REPO;
const log = process.env.MAYHEM_DOCS_LOG;
test.skip(!out || !repo, "docs screenshots only");

test("docs screenshots", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args]).toString().trim();
  fakeRobot.stamp = JSON.stringify({ sha: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: [], builtAt: "2026-11-13T10:00:00-08:00", builtBy: "maya", computer: "pit-laptop" });
  const { tasks } = await execute("list_tasks", { repo, status: ["open", "claimed", "plan", "approved", "review", "done"] });
  if (!tasks.length) {
    await execute("add_feedback", { repo, author: "Maya", kind: "pit-note", text: "Left intake roller rubbing the frame" });
    await execute("add_feedback", { repo, author: "Sam", kind: "comment", title: "Shooter spins up too late in the depot auto", text: "It waits at the hub for almost a second before the first shot." });
  }
  await desktop(page, repo!);
  await page.addInitScript(() => localStorage.setItem("mayhem.theme", "light"));
  await page.goto("/");
  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out!, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole("button", { name, exact: true }).click();

  // The bridge doesn't serve robot.mayhem.json, so import the robot's project as a file.
  await page.locator("#mx-project-import").setInputFiles({ name: "robot.mayhem.json", mimeType: "application/json", buffer: readFileSync(join(repo!, "robot.mayhem.json")) });
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await expect(page.getByRole("region", { name: "How the robot works" })).toBeVisible();
  const toast = page.getByText(/^Opened /);
  if (await toast.isVisible()) await toast.locator("..").getByRole("button").click();
  await shot("overview");

  await nav("Autonomous");
  await page.waitForTimeout(800);
  await shot("autonomous");

  await nav("State machines");
  await page.waitForTimeout(800);
  await shot("state-machines");

  if (log) {
    await nav("Logs");
    dialogPicks.push(log);
    await page.getByRole("button", { name: "Import log" }).first().click();
    await expect(page.getByText(basename(log, ".wpilog")).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot("logs");
  }

  await nav("Robot");
  await page.getByRole("button", { name: "Values", exact: true }).click();
  await shot("robot-values");
  await page.getByRole("button", { name: "On the robot now" }).click();
  await page.getByRole("button", { name: "Check robot" }).click();
  await shot("robot-now");

  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.waitForTimeout(800);
  await shot("tasks");

  await nav("Changes");
  await page.getByLabel("Before version").selectOption(git("rev-parse", "HEAD~6"));
  await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
  await expect(page.locator(".mx-risk-chip")).toBeVisible({ timeout: 60_000 });
  await shot("changes");
  await page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Autos/ }).click();
  await shot("changes-autos");
});
