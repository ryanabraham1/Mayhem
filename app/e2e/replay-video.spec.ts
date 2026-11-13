// Records a 3D before/after replay with the app's Save video (MAYHEM_REVIEW_REPO, MAYHEM_VIDEO,
// MAYHEM_BEFORE, MAYHEM_ROUTINE).
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { desktop } from "./reviewBridge";

const repo = process.env.MAYHEM_REVIEW_REPO;
const video = process.env.MAYHEM_VIDEO;
test.skip(!repo || !video, "records a replay video on request");

test("records a 3D before/after replay video", async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args]).toString().trim();
  await desktop(page, repo!);
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: /Choose robot code folder/ }).first().click();
  await page.getByLabel("Before version").selectOption(git("rev-parse", process.env.MAYHEM_BEFORE ?? "HEAD~1"));
  await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
  await page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Sim proof/ }).click();
  await page.getByRole("button", { name: "Run sim proof" }).click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 800_000 });
  await page.getByRole("navigation", { name: "Scenarios" }).getByRole("button", { name: new RegExp(`^${process.env.MAYHEM_ROUTINE ?? "Depot Trench Sweep Depot"}`) }).click();
  await page.getByRole("group", { name: "Replay view" }).getByRole("button", { name: "3D" }).click();
  await expect(page.locator(".mx-replay-3d-status")).toBeHidden({ timeout: 180_000 });
  await page.locator(".mx-replay-3d").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Record clip" }).click();
  await expect(page.getByRole("button", { name: "Record clip" })).toBeEnabled({ timeout: 180_000 });
  await expect(page.getByLabel("Recorded clip")).toBeVisible();
  await page.getByRole("button", { name: "Download" }).click();
  await expect.poll(() => (existsSync(video!) ? statSync(video!).size : 0), { timeout: 30_000 }).toBeGreaterThan(100_000);
});
