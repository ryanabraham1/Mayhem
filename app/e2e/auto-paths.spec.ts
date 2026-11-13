import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });

test("long pose-chain autos show as a few cards that fit the window, and expand on click", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  const text = await readFile(new URL("../tests/fixtures/robot-project.json", import.meta.url), "utf8");
  const project = JSON.parse(text);
  await page.goto("/");
  await page.locator("#mx-project-import").setInputFiles({ name: "robot.mayhem.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "Machines" });
  for (const routine of project.routines) {
    await rail.getByRole("button", { name: new RegExp(routine.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    const cards = page.locator(".mx-graph .mx-state");
    await expect(cards.first()).toBeVisible();
    // Pass-through points collapse: far fewer cards than steps.
    expect(await cards.count(), routine.name).toBeLessThanOrEqual(Math.ceil(routine.nodes.length / 2));
    await expect(page.locator(".mx-state.is-path").first()).toContainText("Drive path");
    // The whole auto is on screen: no scrolling either way.
    const scroll = await page.locator(".mx-graph-scroll").evaluate((e) => ({ v: e.scrollHeight - e.clientHeight, h: e.scrollWidth - e.clientWidth }));
    expect(scroll.v, `${routine.name} scrolls vertically`).toBeLessThanOrEqual(1);
    expect(scroll.h, `${routine.name} scrolls sideways`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`${routine.id}.png`) });
  }
  // Clicking a path shows its points; a point is then selectable, and "Collapse paths" folds back.
  const path = page.locator(".mx-state.is-path").first();
  const points = Number(/(\d+) points/.exec((await path.textContent())!)![1]);
  const before = await page.locator(".mx-graph .mx-state").count();
  await path.click();
  await expect(page.locator(".mx-graph .mx-state")).toHaveCount(before + points - 1);
  const point = page.locator(".mx-graph .mx-state.is-pose:not(.is-path)").nth(1);
  const name = (await point.locator("strong").textContent())!;
  await point.click();
  await expect(point).toHaveClass(/is-selected/);
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator(".mx-inspector h2")).toHaveText(name);
  await page.getByRole("button", { name: "Collapse paths" }).click();
  await expect(page.locator(".mx-graph .mx-state")).toHaveCount(before);
  // The selected point's path card shows it is selected.
  await expect(page.locator(".mx-state.is-path.is-selected")).toHaveCount(1);
});
