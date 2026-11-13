// 3D before/after replay with the team's real robot model and sim runs (MAYHEM_REVIEW_REPO).
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { desktop } from "./reviewBridge";

const repo = process.env.MAYHEM_REVIEW_REPO;
test.skip(!repo, "needs a robot repo with sim runs and AdvantageScope assets");

test("replays an auto before and after in 3D", async ({ page }) => {
  test.setTimeout(900_000);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args]).toString().trim();
  await desktop(page, repo!);
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: /Choose robot code folder|robot-demo/ }).first().click();
  await page.getByLabel("Before version").selectOption(git("rev-parse", "mayhem/suite-integration"));
  await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
  await page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Sim proof/ }).click();
  await page.getByRole("button", { name: "Run sim proof" }).click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 800_000 });
  await page.getByRole("button", { name: /^Outpost Trench Sweep\b(?! x2)/ }).click();
  await page.getByRole("group", { name: "Replay view" }).getByRole("button", { name: "3D" }).click();
  await expect(page.locator(".mx-replay-3d canvas")).toBeVisible();
  await expect(page.locator(".mx-replay-3d-status")).toBeHidden({ timeout: 120_000 });
  await page.getByLabel("Replay time").fill("4.4");
  await page.waitForTimeout(800);
  const shots = process.env.MAYHEM_SHOTS;
  if (shots) await page.locator(".mx-replay-proof").screenshot({ path: join(shots, "3d-side.png") });
  await page.getByRole("group", { name: "Before and after" }).getByRole("button", { name: "Overlay" }).click();
  await page.waitForTimeout(500);
  if (shots) await page.locator(".mx-replay-3d").screenshot({ path: join(shots, "3d-overlay.png") });
});
