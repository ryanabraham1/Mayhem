import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type Rect = { x: number; y: number; width: number; height: number; text: string };
const overlap = (a: Rect, b: Rect, slack = 1) =>
  a.x + slack < b.x + b.width && b.x + slack < a.x + a.width && a.y + slack < b.y + b.height && b.y + slack < a.y + a.height;

/** Every label box, state card and the graph bounds, in page coordinates. */
async function boxes(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, text: el.textContent ?? "" };
    };
    return {
      labels: [...document.querySelectorAll(".mx-graph button.mx-edge-label")].map(rect),
      states: [...document.querySelectorAll(".mx-graph .mx-state")].map(rect),
      graph: rect(document.querySelector(".mx-graph")!),
      clipped: [...document.querySelectorAll(".mx-graph button.mx-edge-label")]
        .filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent),
    };
  });
}
async function expectLegible(page: Page, name: string) {
  const { labels, states, graph, clipped } = await boxes(page);
  expect(labels.length, `${name}: labels`).toBeGreaterThan(0);
  expect(clipped, `${name}: clipped labels`).toEqual([]);
  const problems: string[] = [];
  labels.forEach((a, i) => {
    labels.slice(i + 1).forEach((b) => overlap(a, b) && problems.push(`label "${a.text}" overlaps label "${b.text}"`));
    states.forEach((s) => overlap(a, s) && problems.push(`label "${a.text}" overlaps state "${s.text}"`));
    if (a.x < graph.x - 1 || a.y < graph.y - 1 || a.x + a.width > graph.x + graph.width + 1 || a.y + a.height > graph.y + graph.height + 1)
      problems.push(`label "${a.text}" is outside the graph`);
  });
  states.forEach((a, i) => states.slice(i + 1).forEach((b) => overlap(a, b) && problems.push(`state "${a.text}" overlaps "${b.text}"`)));
  expect(problems, name).toEqual([]);
}
async function importMachine(page: Page, machine: unknown) {
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
}

test("robot state machines lay out with no overlapping or hidden edge labels", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/robot-machines.json", import.meta.url), "utf8"));
  await page.goto("/");
  await page.getByRole("button", { name: "State machines", exact: true }).click();

  // The old ShotCycle: unnamed transitions, back edges, a "from any state" target.
  await importMachine(page, fixtures.oldShotCycle);
  await expect(page.locator(".mx-graph button.mx-edge-label").first()).toBeVisible();
  await expectLegible(page, "old ShotCycle");
  // Unnamed labels show the whole condition when it is short (no "…" hiding the meaning).
  await expect(page.locator(".mx-graph button.mx-edge-label", { hasText: "ready" }).first()).not.toContainText("…");
  await page.screenshot({ path: info.outputPath("old-shotcycle.png") });
  // Hovering a state dims the wires that don't touch it.
  const state = page.locator(".mx-state", { hasText: "Wait for aiming" });
  await state.hover();
  await expect(page.locator(".mx-graph.has-focus .mx-edge.is-far").first()).toBeAttached();
  const near = await page.locator(".mx-edge.is-near").count();
  expect(near).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("old-shotcycle-hover.png") });

  for (const machine of fixtures.current) {
    await importMachine(page, machine);
    if (machine.id === "Superstructure") {
      // Collapsed into the priority list; drawing every wire must still be legible.
      await page.getByRole("button", { name: "Show all wires" }).click();
      await expect(page.locator(".mx-edge")).toHaveCount(machine.transitions.length);
    }
    await expect(page.locator(".mx-graph button.mx-edge-label").first()).toBeVisible();
    await expectLegible(page, machine.id);
    // Named transitions are labelled by name.
    await expect(page.locator(".mx-graph button.mx-edge-label.is-named").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${machine.id}.png`), fullPage: true });
  }
});
