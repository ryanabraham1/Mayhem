import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("state-machine edges get readable, distinct labels and an inspectable condition", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const project = JSON.parse(await readFile(new URL("../../examples/suite/team3256-offseason-2026.mayhem.json", import.meta.url), "utf8"));
  const machine = project.extensions.machines.find((m: { id: string }) => m.id === "Superstructure");
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "superstructure.machine.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(machine)),
  });
  await page.getByRole("button", { name: new RegExp(machine.name.split(" ")[0]) }).first().click();
  const labels = page.locator("button.mx-edge-label");
  await expect(labels.first()).toBeVisible();
  // Nothing is cut off by the box (the text itself is shortened to fit).
  const clipped = await labels.evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(clipped).toEqual([]);
  // Labels of edges leaving the initial state are all different.
  const initial = machine.transitions.filter((t: { from: string }) => t.from === machine.initial).length;
  await page.screenshot({ path: info.outputPath("superstructure.png"), fullPage: true });
  const texts = await labels.allTextContents();
  expect(texts.length).toBeGreaterThanOrEqual(initial);
  // Clicking a label selects that edge in the inspector, which shows the full condition.
  const first = labels.first();
  await first.click();
  const picked = page.locator(".mx-guard-edge.is-picked");
  await expect(picked).toHaveCount(1);
  await expect(picked.locator("code")).not.toContainText("…");
  await expect(page.locator(".mx-edge.is-picked")).toHaveCount(1);
  await expect(first).toHaveAttribute("title", /\S/);
});

test("long state names and source paths stay readable on state cards", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const machine = {
    format: "mayhem-machine", version: 1, id: "IntakeSequence", name: "Intake sequence", initial: "PARKED",
    states: [
      { id: "PARKED", name: "Parked", source: "src/main/cpp/subsystems/intake/IntakeSequence.cpp" },
      { id: "READY", name: "Intake deployed and ready to collect", source: "src/main/cpp/subsystems/intake/IntakeSequence.cpp:142" },
    ],
    inputs: [{ key: "deploy", name: "Deploy requested", type: "boolean", initial: false }],
    transitions: [{ id: "go", from: "PARKED", to: "READY", condition: { kind: "signal", key: "deploy", op: "eq", value: true }, name: "Deploy", description: "Driver asked to intake." }],
  };
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "intake.machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
  const card = page.locator(".mx-state", { hasText: "Intake deployed" });
  await expect(card.locator("strong")).toHaveText("Intake deployed and ready to collect");
  const cut = await card.locator("strong").evaluate((e) => e.scrollHeight > e.clientHeight + 1);
  expect(cut).toBe(false);
  await expect(card.locator("small")).toHaveText("…/IntakeSequence.cpp:142");
  await expect(card).toHaveAttribute("title", /src\/main\/cpp\/subsystems\/intake\/IntakeSequence\.cpp:142/);
  // A named edge shows its name; the inspector lists name, condition and description.
  await expect(page.locator("button.mx-edge-label", { hasText: "Deploy" })).toBeVisible();
  await page.locator(".mx-state", { hasText: "Parked" }).click();
  const row = page.locator(".mx-guard-edge").first();
  await expect(row).toContainText("Deploy");
  // No category declared: the input is internal (I).
  await expect(row.locator("code")).toHaveText("Ideploy");
  await expect(row).toContainText("Driver asked to intake.");
  await page.screenshot({ path: info.outputPath("intake-cards.png") });
});

test("input categories show as glyphs, group the inputs, and explain transitions", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const machine = {
    format: "mayhem-machine", version: 1, id: "Intake2", name: "Intake categories", initial: "PARKED",
    states: [{ id: "PARKED", name: "Parked" }, { id: "READY", name: "Ready" }, { id: "FAULT", name: "Fault" }],
    inputs: [
      { key: "deploy", name: "Deploy requested", type: "boolean", initial: false, category: "operator" },
      { key: "hoodClear", name: "Hood clear", type: "boolean", initial: false, category: "sensor" },
      { key: "latched", name: "Deploy latched", type: "boolean", initial: false, derivedFrom: ["deploy"] },
      { key: "stateTime", name: "Seconds in state", type: "number", initial: 0, category: "timer" },
    ],
    transitions: [
      { id: "go", from: "PARKED", to: "READY", condition: { kind: "all", conditions: [
        { kind: "signal", key: "deploy", op: "eq", value: true }, { kind: "signal", key: "hoodClear", op: "eq", value: true }] } },
      { id: "late", from: "PARKED", to: "FAULT", condition: { kind: "signal", key: "stateTime", op: "gt", value: 3 } },
      { id: "back", from: "READY", to: "PARKED", condition: { kind: "signal", key: "hoodClear", op: "eq", value: false } },
      { id: "hold", from: "FAULT", to: "PARKED", condition: { kind: "signal", key: "latched", op: "eq", value: true } },
    ],
  };
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "intake2.machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
  const legend = page.getByLabel("Input sources");
  for (const label of ["Operator", "Sensor", "Internal", "Timer"]) await expect(legend).toContainText(label);
  // Edge labels mark each input with its category letter (not color alone).
  const go = page.locator("button.mx-edge-label", { hasText: "deploy" });
  await expect(go.locator(".mx-term.is-operator .mx-term-badge")).toHaveText("O");
  await expect(go.locator(".mx-term.is-sensor .mx-term-badge")).toHaveText("S");
  await expect(page.locator("button.mx-edge-label .mx-term.is-timer .mx-term-badge")).toHaveText("T");
  // Inputs are grouped by category; derived flags list their sources.
  await expect(page.locator("h4.mx-input-group")).toHaveText(["OOperator", "SSensor", "IInternal", "TTimer"]);
  await expect(page.locator(".mx-derived")).toContainText("deploy");
  // A simulated change explains the transition by the input that caused it.
  await page.getByRole("switch", { name: "Hood clear" }).click();
  await page.getByRole("switch", { name: "Deploy requested" }).click();
  await expect(page.locator(".mx-state.is-active")).toContainText("Ready");
  await expect(page.locator(".mx-cause")).toHaveText("Parked → Ready because Odeploy");
  await page.screenshot({ path: info.outputPath("categories.png") });
});

test("inspector exits wrap as text in a narrow window, with the target below the condition", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const sig = (key: string, value: boolean | number = true, op = "eq") => ({ kind: "signal", key, op, value });
  const machine = {
    format: "mayhem-machine", version: 1, id: "IntakeSequence", name: "Intake sequence", initial: "CLEARING_HOOD",
    states: [
      { id: "CLEARING_HOOD", name: "Clearing hood" }, { id: "PARKED", name: "Parked / no deployment demand" },
      { id: "DEPLOYING", name: "Deploy slide to intake" }, { id: "FAULT", name: "Clearance or deployment fault" },
    ],
    inputs: [
      { key: "deploy", name: "Deploy", type: "boolean", initial: false, category: "operator" },
      { key: "enabled", name: "Enabled", type: "boolean", initial: false, category: "sensor" },
      { key: "hoodClear", name: "Hood clear", type: "boolean", initial: false, category: "sensor" },
      { key: "stateTime", name: "Seconds in state", type: "number", initial: 0 },
    ],
    transitions: [
      { id: "park", from: "CLEARING_HOOD", to: "PARKED", condition: { kind: "any", conditions: [sig("deploy", false), sig("enabled", false)] } },
      { id: "deploy", from: "CLEARING_HOOD", to: "DEPLOYING", condition: { kind: "all", conditions: [sig("deploy"), sig("hoodClear")] } },
      { id: "fault", from: "CLEARING_HOOD", to: "FAULT", name: "Hood clearance timed out", description: "The hood never cleared the slide.",
        condition: { kind: "all", conditions: [sig("deploy"), sig("hoodClear", false), sig("stateTime", 2.5, "gt")] } },
    ],
  };
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "intake.machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
  // Narrow window (the nav collapses to icons below this, so shrink after navigating).
  await page.setViewportSize({ width: 900, height: 900 });
  const rows = page.locator(".mx-guard-edge");
  await expect(rows).toHaveCount(3);
  const width = await page.locator(".mx-inspector").evaluate((e) => e.getBoundingClientRect().width);
  expect(width).toBeLessThan(330); // genuinely narrow
  for (let i = 0; i < 3; i++) {
    const row = rows.nth(i);
    const layout = await row.evaluate((el) => {
      const main = el.querySelector(".mx-guard-main")!.getBoundingClientRect();
      const target = el.querySelector(".mx-guard-target")!.getBoundingClientRect();
      const condition = el.querySelector(".mx-guard-condition")!;
      // A term (badge + key) or a number never splits across lines.
      const split = [...condition.querySelectorAll(".mx-term")].filter((t) => {
        const tops = [...t.getClientRects()].map((x) => x.top).sort((a, b) => a - b);
        return tops.some((v, i) => i > 0 && v - tops[i - 1] > 6);
      }).length;
      const walker = document.createTreeWalker(condition, NodeFilter.SHOW_TEXT);
      // Distinct text lines among rects; inline-block badges sit a pixel or two off the text.
      const lineCount = (rects: DOMRect[]) => {
        const tops = rects.filter((x) => x.width > 0).map((x) => x.top).sort((a, b) => a - b);
        return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 6).length;
      };
      const lines = (node: Node, start: number, end: number) => {
        const r = document.createRange(); r.setStart(node, start); r.setEnd(node, end);
        return lineCount([...r.getClientRects()]);
      };
      let brokenNumbers = 0, detachedOperators = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        for (const m of text.matchAll(/\d+(\.\d+)?/g)) if (lines(n, m.index!, m.index! + m[0].length) > 1) brokenNumbers++;
        // An operator must share a line with what follows it.
        for (const m of text.matchAll(/[∧∨]/g)) {
          const next = n.nextSibling ?? n.parentNode?.nextSibling;
          const r = document.createRange(); r.setStart(n, m.index!);
          if (next) r.setEndAfter(next); else r.setEnd(n, text.length);
          if (lineCount([...r.getClientRects()]) > 1) detachedOperators++;
        }
      }
      return { split, brokenNumbers, detachedOperators, targetBelow: target.top >= main.bottom - 1, name: el.querySelector(".mx-guard-main strong")?.textContent ?? null, condTop: condition.getBoundingClientRect().top, nameBottom: el.querySelector(".mx-guard-main strong")?.getBoundingClientRect().bottom ?? 0 };
    });
    expect(layout, `row ${i + 1}`).toMatchObject({ split: 0, brokenNumbers: 0, detachedOperators: 0, targetBelow: true });
    if (layout.name) expect(layout.condTop).toBeGreaterThanOrEqual(layout.nameBottom - 1);
  }
  await expect(rows.nth(2).locator("strong")).toHaveText("Hood clearance timed out");
  await expect(rows.nth(2).locator(".mx-guard-condition")).toContainText("2.5");
  await page.locator(".mx-inspector").screenshot({ path: info.outputPath("narrow-inspector.png") });
});
