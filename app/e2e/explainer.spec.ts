import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, fixtureRepo } from "./reviewBridge";

const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

test("explains each part of the robot", async ({ page }) => {
  const repo = process.env.MAYHEM_REVIEW_REPO ?? fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  const explainer = page.getByRole("region", { name: "How the robot works" });
  await explainer.getByRole("button", { name: /^Shooter\b/ }).first().click();
  const part = page.getByLabel("Shooter explained");
  await expect(part.getByRole("heading", { name: "Shooter" })).toBeVisible();
  await expect(part.getByText(/CAN 44/)).toBeVisible();
  await part.getByRole("button", { name: /Describe it|Edit/ }).click();
  await part.getByLabel("What Shooter does").fill("Four flywheels launch fuel into the hub. Spins up when you hold A, or by itself in the alliance zone.");
  await part.getByRole("button", { name: "Save" }).click();
  await expect(part.getByText("Four flywheels launch fuel")).toBeVisible();
  await explainer.scrollIntoViewIfNeeded();
  await shot(page, "e1-explainer");
  const saved = JSON.parse(readFileSync(join(repo, "tools/mayhem/explainer.json"), "utf8"));
  expect(saved.parts.Shooter).toMatch(/Four flywheels/);
});
