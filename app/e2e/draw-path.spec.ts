import { expect, test } from "@playwright/test";

test("draws a route freehand and turns it into pass-throughs and a pose", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  const field = page.getByLabel("Autonomous field editor");
  const goals = field.locator(".mx-goal");
  const before = await goals.count();

  await page.keyboard.press("d");
  await expect(page.getByText("Drag along the route")).toBeVisible();
  const box = (await field.boundingBox())!;
  // An L stroke in the open middle of the field.
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.move(...at(0.3, 0.3));
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(...at(0.3 + (0.2 * i) / 30, 0.3));
  await expect(field.locator(".mx-sketch")).toBeVisible();
  for (let i = 1; i <= 30; i++) await page.mouse.move(...at(0.5, 0.3 + (0.3 * i) / 30));
  await page.screenshot({ path: info.outputPath("drawing.png") });
  await page.mouse.up();

  await expect(field.locator(".mx-sketch")).toHaveCount(0);
  const added = (await goals.count()) - before;
  expect(added).toBeGreaterThanOrEqual(2);
  expect(added).toBeLessThanOrEqual(4);
  await expect(page.getByRole("button", { name: /Select goal Pass through/ }).first()).toBeAttached();
  await page.screenshot({ path: info.outputPath("drawn.png") });

  // One undo removes the whole stroke.
  await page.keyboard.press("Meta+z");
  await expect(goals).toHaveCount(before);
  expect(errors).toEqual([]);
});
