import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

/** A pinch as WebKit/Chromium report it: wheel events with ctrlKey, at the cursor. */
async function pinch(page: Page, x: number, y: number, deltaY: number, steps = 6) {
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

test("pinch zooms the state graph around the cursor and two-finger scroll pans it", async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/robot-machines.json", import.meta.url), "utf8"));
  const machine = fixtures.latest.find((m: { id: string }) => m.id === "Superstructure");
  await page.goto("/");
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "s.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
  const zoom = page.getByRole("group", { name: "Zoom" });
  await expect(zoom).toContainText("Fit");
  const card = page.locator(".mx-graph .mx-state", { hasText: "Home" }).first();
  const before = (await card.boundingBox())!;
  const cx = before.x + before.width / 2, cy = before.y + before.height / 2;
  const pageZoom = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  await pinch(page, cx, cy, -20);
  await expect(zoom).toContainText("%");
  const after = (await card.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width * 1.2); // zoomed in
  // The point under the cursor stays put.
  expect(Math.abs(after.x + after.width / 2 - cx)).toBeLessThan(6);
  expect(Math.abs(after.y + after.height / 2 - cy)).toBeLessThan(6);
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageZoom); // the page did not zoom
  // A plain two-finger scroll pans the canvas, not the page.
  const scroller = page.locator(".mx-graph-scroll");
  const top = await scroller.evaluate((e) => e.scrollTop);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(top);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  // Pinching out past the limit clamps; Fit restores.
  await pinch(page, cx, cy, 30, 40);
  await expect(zoom).toContainText("30%");
  await page.getByTitle("Fit the whole graph").click();
  await expect(zoom).toContainText("Fit");
});

test("pinch zooms the field around the cursor and two-finger scroll pans it", async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  const field = page.getByLabel("Autonomous field editor");
  await expect(field).toBeVisible();
  const box = (await field.boundingBox())!;
  const view = async () => (await field.getAttribute("viewBox"))!.split(" ").map(Number);
  // The field point under the cursor, from the viewBox and the element's box.
  const at = (v: number[], x: number, y: number) => {
    const s = Math.min(box.width / v[2], box.height / v[3]);
    const ox = box.x + (box.width - v[2] * s) / 2, oy = box.y + (box.height - v[3] * s) / 2;
    return [v[0] + (x - ox) / s, v[1] + (y - oy) / s];
  };
  const x = box.x + box.width * 0.3, y = box.y + box.height * 0.4;
  const v0 = await view();
  await pinch(page, x, y, -20);
  const v1 = await view();
  expect(v1[2]).toBeLessThan(v0[2] * 0.8); // zoomed in
  const [p0, p1] = [at(v0, x, y), at(v1, x, y)];
  expect(Math.abs(p1[0] - p0[0])).toBeLessThan(0.05);
  expect(Math.abs(p1[1] - p0[1])).toBeLessThan(0.05);
  await page.mouse.wheel(40, 0);
  const v2 = await view();
  expect(v2[0]).toBeGreaterThan(v1[0]); // panned right
  expect(v2[2]).toBeCloseTo(v1[2], 6); // without zooming
});
