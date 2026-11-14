import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { desktop, fakeRobot, fixtureRepo } from "./reviewBridge";

const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

test("shows what's on the robot, how it differs from main, and puts main back", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]).toString().trim();
  const stamp = (rev: string, dirty: string[] = []) =>
    JSON.stringify({ sha: git("rev-parse", rev), branch: "agent/shooter", dirty, builtAt: "2026-11-13T10:00:00-08:00", builtBy: "maya", computer: "pit-laptop" });
  // main is one commit behind what was deployed.
  git("checkout", "-q", "-b", "agent/shooter");
  git("branch", "-f", "main", "HEAD~1");
  fakeRobot.stamp = stamp("HEAD", ["src/main/include/subsystems/shooter/ShooterConstants.h"]);
  fakeRobot.deploys.length = 0;
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await page.getByRole("button", { name: "On the robot now" }).click();
  await page.getByRole("button", { name: "Check robot" }).click();
  await expect(page.getByText("Deployed with uncommitted changes")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Different from main" })).toBeVisible();
  await expect(page.getByText("Agent: shooter tuning")).toBeVisible();
  await shot(page, "r1-robot-now");
  await page.getByRole("button", { name: "Put main back on the robot" }).click();
  await expect(page.getByText("same as main")).toBeVisible();
  expect(fakeRobot.deploys).toEqual([{ rev: git("rev-parse", "main"), team: 3256 }]);
});

test("Robot → Values lists every value by kind and part, and edits it in place", async ({ page }) => {
  const repo = fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await page.getByRole("button", { name: "Values", exact: true }).click();
  const kinds = page.getByRole("tablist", { name: "Kind of value" });
  const parts = page.getByRole("tablist", { name: "Part" });
  await kinds.getByRole("tab", { name: /^CAN IDs/ }).click();
  await expect(page.getByRole("region", { name: "CAN IDs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current limits" })).toHaveCount(0);
  await parts.getByRole("tab", { name: /^Shooter/ }).click();
  await expect(page.locator(".mx-spec-card h3")).toHaveText(["Shooter"]);
  await shot(page, "r2-robot-values");
  // Back to everything, then edit a value: the robot code changes on disk.
  await kinds.getByRole("tab", { name: /^All/ }).click();
  await page.getByRole("button", { name: /^Edit Shooter/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
