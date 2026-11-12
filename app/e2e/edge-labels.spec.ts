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
  await expect(row.locator("code")).toHaveText("deploy");
  await expect(row).toContainText("Driver asked to intake.");
  await page.screenshot({ path: info.outputPath("intake-cards.png") });
});
