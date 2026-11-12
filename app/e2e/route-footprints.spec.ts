import { expect, test } from "@playwright/test";

test("the field shows robot footprints with the front along the previewed route", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  const prints = page.locator(".mx-footprints .mx-footprint");
  await expect.poll(() => prints.count()).toBeGreaterThan(3);
  await expect(prints.first().locator(".mx-footprint-front")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("footprints.png") });
});
