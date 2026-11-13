import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, fixtureRepo } from "./reviewBridge";

const tab = (page: Page, name: RegExp) => page.getByRole("group", { name: "Review sections" }).getByRole("button", { name }).click();
const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
};

test("reviews an agent's change and edits a CAN ID into the robot code", async ({ page }) => {
  const repo = process.env.MAYHEM_REVIEW_REPO ?? fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  // The agent's commit against the one before it.
  const sha = (rev: string) => execFileSync("git", ["-C", repo, "rev-parse", rev]).toString().trim();
  await page.getByLabel("Before version").selectOption(sha(process.env.MAYHEM_REVIEW_BEFORE ?? "HEAD~1"));
  await page.getByLabel("After version").selectOption(sha("HEAD"));
  await expect(page.getByRole("status").filter({ hasText: "Safety change" })).toBeVisible();
  await shot(page, "1-summary");

  await tab(page, /^Controls/);
  await expect(page.getByRole("alert").filter({ hasText: "Driver controls changed" })).toBeVisible();
  await shot(page, "2-controls");

  await tab(page, /^State machines/);
  await expect(page.locator(".mx-edge.is-diff-changed").first()).toBeVisible();
  await shot(page, "3-machines");

  await tab(page, /^Values/);
  await shot(page, "4-values");

  if (process.env.MAYHEM_REVIEW_REPO) {
    await tab(page, /^Autos/);
    await shot(page, "5-autos");
  }

  if (process.env.MAYHEM_REVIEW_REPO) {
    test.setTimeout(900_000);
    await tab(page, /^Sim proof/);
    await page.getByRole("button", { name: "Run sim proof" }).click();
    await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 800_000 });
    await page.getByRole("button", { name: /^Outpost Trench Sweep x2/ }).click();
    await page.getByLabel("Replay time").fill("16");
    await shot(page, "9-sim-autos");
    await page.getByRole("button", { name: /^Outpost Trench Sweep\b(?! x2)/ }).click();
    await shot(page, "10-sim-not-regenerated");
    await page.getByRole("button", { name: /^Buttons/ }).click();
    await shot(page, "11-sim-buttons");
  }

  // Edit: the working copy against the last commit; give the shooter's second motor a new CAN ID.
  await page.getByLabel("Before version").selectOption("HEAD");
  await page.getByLabel("After version").selectOption("WORKTREE");
  await tab(page, /^Hardware/);
  await page.getByRole("button", { name: /^Shooter/ }).first().click();
  await shot(page, "6-hardware");
  await page.getByRole("button", { name: "Edit Motor 2 (bottom left) CAN ID" }).or(page.getByRole("button", { name: "Edit Motor 2 (right) CAN ID" })).click();
  const dialog = page.getByRole("dialog", { name: "Edit value" });
  await dialog.getByLabel("New value").fill("39");
  await expect(dialog.getByRole("alert").filter({ hasText: "CAN ID 39 would be used by" })).toBeVisible();
  await shot(page, "7-edit-conflict");
  await dialog.getByLabel("New value").fill("46");
  await expect(dialog.getByText(/^Safety setting/)).toBeVisible();
  await dialog.getByRole("button", { name: "Save to robot code" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".mx-hw-ids i.is-changed", { hasText: "46" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Safety change" })).toBeVisible();
  await shot(page, "8-after-edit");
  const file = readFileSync(join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h"), "utf8");
  expect(file).toMatch(/46,\s+\/\/ (right|bottom left)/);
});
