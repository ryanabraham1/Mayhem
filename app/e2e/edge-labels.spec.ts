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
  await expect(picked.locator(".mx-guard-condition")).not.toContainText("…");
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
  await expect(row.locator(".mx-guard-condition")).toHaveText("IDeploy requested"); // in words, by name
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
  await expect(page.locator(".mx-cause")).toHaveText("Parked → Ready because ODeploy requested");
  await page.screenshot({ path: info.outputPath("categories.png") });
});

test("an input derived from another machine's input names that machine and its source", async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const flag = (key: string, extra: object = {}) => ({ key, name: key, type: "boolean", initial: false, ...extra });
  const machine = (id: string, inputs: object[]) => ({
    format: "mayhem-machine", version: 1, id, name: id, initial: "IDLE", states: [{ id: "IDLE", name: "Idle" }, { id: "BUSY", name: "Busy" }], inputs,
    transitions: [{ id: "go", from: "IDLE", to: "BUSY", condition: { kind: "signal", key: (inputs[0] as { key: string }).key, op: "eq", value: true } }],
  });
  const imports = page.locator("label", { hasText: "Import machine" }).locator("input[type=file]");
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  for (const [m, name] of [
    [machine("Superstructure", [flag("jitter", { name: "Jitter requested (Y)", category: "operator" })]), "Jitter requested (Y)"],
    [machine("IntakeSequence", [flag("jitterDemand", { name: "Jitter wanted", category: "internal", derivedFrom: [{ machine: "Superstructure", key: "jitter" }] })]), "Jitter wanted"],
  ] as const) {
    await imports.setInputFiles({ name: `${m.id}.machine.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(m)) });
    await expect(page.locator(".mx-input-row", { hasText: name })).toBeVisible(); // imported and selected
  }
  const derived = page.locator(".mx-derived");
  await expect(derived).toContainText("from Superstructure · Ojitter");
  await expect(derived.locator(".mx-term.is-operator .mx-term-badge")).toHaveText("O");
  await expect(derived).toHaveAttribute("title", "Derived from Superstructure · jitter (operator: Jitter requested (Y)); driven by operator input");
});

test("a priority supervisor (every state to every state) reads as a ladder, with wires on demand", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  await page.goto("/");
  const sig = (key: string, value = true) => ({ kind: "signal", key, op: "eq", value });
  const targets = [
    { id: "CANCEL", name: "Cancel", when: sig("cancel") },
    { id: "SHOOT_AND_JITTER", name: "Shoot + jitter", when: { kind: "all", conditions: [sig("shoot"), sig("jitter")] } },
    { id: "SHOOT", name: "Shoot", when: sig("shoot") },
    { id: "JITTER", name: "Jitter", when: sig("jitter") },
    { id: "IDLE", name: "Nothing requested", when: { kind: "all", conditions: [sig("shoot", false), sig("jitter", false)] } },
  ];
  const states = targets.map((t) => ({ id: t.id, name: t.name }));
  const inputs = ["cancel", "shoot", "jitter"].map((key) => ({ key, name: key, type: "boolean", initial: false, category: key === "cancel" ? "internal" : "operator" }));
  // Expanded the way a generator without "*" writes it: every target from every other state.
  const expanded = {
    format: "mayhem-machine", version: 1, id: "Supervisor", name: "Supervisor", initial: "IDLE", states, inputs,
    transitions: states.flatMap((from) => targets.filter((t) => t.id !== from.id).map((t) => ({ id: `${from.id}->${t.id}`, from: from.id, to: t.id, condition: t.when }))),
  };
  const imports = page.locator("label", { hasText: "Import machine" }).locator("input[type=file]");
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await imports.setInputFiles({ name: "supervisor.machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(expanded)) });
  const ladder = page.getByLabel("Transitions from any state");
  await expect(ladder.locator("li")).toHaveCount(5);
  await expect(ladder.locator("li").nth(1)).toContainText("→ Shoot + jitter");
  await expect(ladder.locator("li").nth(1)).toContainText("Oshoot and Ojitter");
  // Chips say where they come from instead of a bare "any".
  const chip = page.locator(".mx-state", { hasText: "Shoot + jitter" }).locator(".mx-any");
  await expect(chip).toHaveText("from any state");
  await expect(chip).toHaveAttribute("title", /Shoot \+ jitter: from any state\nshoot \(operator\) ∧ jitter \(operator\)/);
  await expect(page.locator(".mx-edge")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("supervisor-ladder.png") });
  // The selected state's exits stay in priority order; picking a ladder row picks that exit.
  await page.locator(".mx-state", { hasText: "Shoot" }).filter({ hasNotText: "jitter" }).click();
  const exits = page.locator(".mx-guard-edge");
  await expect(exits).toHaveCount(4);
  await expect(exits.nth(0)).toContainText("→ Cancel");
  await expect(exits.nth(1)).toContainText("→ Shoot + jitter");
  await ladder.locator("li").nth(1).getByRole("button").click();
  await expect(page.locator(".mx-guard-edge.is-picked")).toContainText("→ Shoot + jitter");
  await ladder.getByRole("button", { name: "Show all wires" }).click();
  await expect(page.locator(".mx-edge")).toHaveCount(20);
  await page.screenshot({ path: info.outputPath("supervisor-wires.png") });

  // The same machine with from "*": five transitions, same ladder, exits say where they apply.
  const star = {
    ...expanded, id: "Supervisor2", name: "Supervisor star",
    transitions: targets.map((t) => ({ id: `to-${t.id}`, from: "*", to: t.id, condition: t.when, ...(t.id === "JITTER" ? { except: ["CANCEL"] } : {}) })),
  };
  await imports.setInputFiles({ name: "star.machine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(star)) });
  await expect(ladder.locator("li")).toHaveCount(5);
  await expect(ladder.locator("li").nth(3)).toContainText("not from Cancel");
  await expect(page.locator(".mx-state", { hasText: "Jitter" }).filter({ hasNotText: "Shoot" }).locator(".mx-any")).toContainText("from any state but 1");
  await page.locator(".mx-state", { hasText: "Cancel" }).click();
  await expect(exits).toHaveCount(3); // not JITTER (except), not itself
  await expect(exits.first()).toContainText("From any state");
  // Simulating follows "*" transitions.
  await page.getByRole("switch", { name: "shoot" }).click();
  await expect(page.locator(".mx-state.is-active")).toContainText("Shoot");
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
      // A badge never parts from its first word, and a number never splits across lines.
      const split = [...condition.querySelectorAll(".mx-plain-head, .mx-term:not(.mx-plain)")].filter((t) => {
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
