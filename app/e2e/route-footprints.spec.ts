import { expect, test } from "@playwright/test";

test("the field shows the front's heading along the route and the robot at each pickup", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  // Light chevrons along the route, not overlapping robot outlines.
  await expect.poll(() => page.locator(".mx-heading-chevron").count()).toBeGreaterThan(3);
  // Full outlines only where an event marker fires (the sample route has one pickup event).
  const outlines = page.locator(".mx-footprints .mx-footprint");
  await expect.poll(() => outlines.count()).toBeLessThanOrEqual(3);
  await page.screenshot({ path: info.outputPath("footprints.png") });
});
