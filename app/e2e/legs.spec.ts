import { expect, test } from "@playwright/test";

test("focuses one leg, ghosts the rest and fans out stacked goals", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  const legs = page.getByRole("toolbar", { name: "Route legs" });
  await expect(legs).toBeVisible();
  const chips = legs.getByRole("button");
  expect(await chips.count()).toBeGreaterThan(2);
  const field = page.getByLabel("Autonomous field editor");
  const viewBox = await field.getAttribute("viewBox");

  await chips.nth(2).click();
  await expect(chips.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(field.locator(".mx-ghost-goal").first()).toBeAttached();
  await expect(field).not.toHaveAttribute("viewBox", viewBox!);
  await page.screenshot({ path: info.outputPath("leg-focus.png") });

  await page.keyboard.press("]");
  await expect(chips.nth(2)).toHaveAttribute("aria-pressed", "false");
  await chips.first().click();
  await expect(field.locator(".mx-ghost-goal")).toHaveCount(0);
  await expect(field).toHaveAttribute("viewBox", viewBox!);

  // Duplicating drops the copy right next to the original: one click now spreads both out.
  const goal = field.locator(".mx-goal").first();
  const name = (await goal.getAttribute("aria-label"))!.replace("Select goal ", "");
  await goal.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate goal" }).click();
  await field.getByRole("button", { name: `Select goal ${name}`, exact: true }).first().click({ force: true });
  const fan = field.getByLabel("Stacked goals");
  await expect(fan).toBeVisible();
  expect(await fan.getByRole("button").count()).toBeGreaterThan(1);
  await page.screenshot({ path: info.outputPath("fan.png") });
  await fan.getByRole("button").last().click();
  await expect(fan).toHaveCount(0);
  expect(errors).toEqual([]);
});
