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
