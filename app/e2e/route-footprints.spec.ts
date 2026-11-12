import { expect, test } from "@playwright/test";

test("the field shows the front's heading along the route and nothing off the waypoints", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  // Light chevrons along the route, not overlapping robot outlines.
  await expect.poll(() => page.locator(".mx-heading-chevron").count()).toBeGreaterThan(3);
  // Nothing but the chevrons: no robot outlines away from waypoints.
  await expect(page.locator(".mx-footprints rect")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("footprints.png") });
});
