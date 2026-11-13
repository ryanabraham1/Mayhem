import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { desktop, fakeRobot, fixtureRepo } from "./reviewBridge";

const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

test("shows what's on the robot, what changed since the last good version, and rolls back", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]).toString().trim();
  const stamp = (rev: string, dirty: string[] = []) =>
    JSON.stringify({ sha: git("rev-parse", rev), branch: "main", dirty, builtAt: "2026-11-13T10:00:00-08:00", builtBy: "maya", computer: "pit-laptop" });
  fakeRobot.stamp = stamp("HEAD~1");
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByRole("button", { name: "Robot", exact: true }).click();
  await page.getByRole("button", { name: "On the robot now" }).click();
  await page.getByRole("button", { name: "Check robot" }).click();
  await expect(page.getByText(git("rev-parse", "--short=7", "HEAD~1"))).toBeVisible();
  await page.getByRole("button", { name: "Mark this version as good" }).click();
  await expect(page.getByText("known good")).toBeVisible();

  // A new deploy, with an uncommitted file.
  fakeRobot.stamp = stamp("HEAD", ["src/main/include/subsystems/shooter/ShooterConstants.h"]);
  await page.getByRole("button", { name: "Check robot" }).click();
  await expect(page.getByText("Deployed with uncommitted changes")).toBeVisible();
  await expect(page.getByText("Agent: shooter tuning")).toBeVisible();
  await shot(page, "r1-robot-now");
  await page.getByRole("button", { name: /^Roll back to/ }).click();
  await expect(page.getByText("known good")).toBeVisible();
  expect(fakeRobot.deploys).toEqual([{ rev: git("rev-parse", "HEAD~1"), team: 3256 }]);
  await shot(page, "r2-rolled-back");
});
