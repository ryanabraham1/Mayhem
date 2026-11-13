import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const sig = (key: string, value = true) => ({ kind: "signal", key, op: "eq", value });
const all = (...conditions: object[]) => ({ kind: "all", conditions });
const any = (...conditions: object[]) => ({ kind: "any", conditions });

test("a priority-select supervisor reads as a decision ladder in plain words", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/robot-machines.json", import.meta.url), "utf8"));
  const real = fixtures.current.find((m: { id: string }) => m.id === "Superstructure");
  // The robot's Superstructure written for priority select: each row only says what it needs.
  const row = (id: string, to: string, condition: object, name: string) => ({ id, from: "*", to, condition, name });
  const machine = {
    ...real,
    selection: "priority",
    transitions: [
      row("disabled", "IDLE", sig("enabled", false), "Robot disabled"),
      row("cancel", "CANCEL_ALL", any(sig("cancel"), sig("poseValid", false)), "Cancel / lost pose"),
      row("home", "HOME", sig("home"), "Home"),
      row("outtake", "OUTTAKE", sig("outtake"), "Outtake"),
      row("shoot-jitter", "JITTER_AND_SHOOT", all(sig("shoot"), sig("jitter")), "Shoot + jitter"),
      row("shoot-intake", "SHOOT_AND_INTAKE", all(sig("shoot"), sig("intake")), "Shoot + intake"),
      row("shoot", "SHOOT", sig("shoot"), "Shoot"),
      row("jitter", "JITTER", sig("jitter"), "Jitter"),
      row("rev-intake", "REV_AND_INTAKE", all(sig("intake"), sig("rev")), "Intake in zone"),
      row("intake", "INTAKE", sig("intake"), "Intake"),
      row("rev", "REV", sig("rev"), "Rev"),
      row("otherwise", "IDLE", { kind: "always" }, "Nothing requested"),
    ],
  };
  await page.goto("/");
  await page.getByRole("button", { name: "State machines", exact: true }).click();
  await page.locator("label", { hasText: "Import machine" }).locator("input[type=file]").setInputFiles({
    name: "superstructure.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(machine)),
  });
  const ladder = page.getByLabel("Decision ladder");
  const rows = ladder.locator(".mx-decision-row");
  await expect(rows).toHaveCount(12);
  // Plain words with input names (after their O/S/I badge), no ∧ ¬ ∨.
  await expect(rows.nth(0)).toContainText("not IRobot enabled?");
  await expect(rows.nth(1)).toContainText("ICancel all (auto ended or failed) or not SPose and shot distance valid?");
  await expect(rows.nth(2)).toContainText("OHome requested (B)?");
  await expect(rows.nth(4)).toContainText("OShoot requested (A / auto) and OJitter requested (Y)?");
  await expect(rows.nth(11)).toContainText("Otherwise");
  await expect(ladder).not.toContainText("∧");
  await expect(rows.nth(2).locator(".mx-decision-state")).toHaveText("Home");
  await expect(rows.nth(2).locator(".mx-term-badge.is-operator")).toHaveText("O");
  // Disabled: the first question decides and the robot stays in Nothing requested.
  await expect(rows.nth(0)).toHaveClass(/is-deciding/);
  await expect(ladder.getByRole("status")).toContainText("question 1 → Idle");
  // Enable with a valid pose, then hold B and A: Home wins and holding it keeps Home.
  for (const name of ["Robot enabled", "Pose and shot distance valid", "Home requested (B)", "Shoot requested (A / auto)"])
    await page.getByRole("switch", { name }).click();
  await expect(rows.nth(2)).toHaveClass(/is-deciding/);
  await expect(page.locator(".mx-decision-state.is-active")).toHaveText("Home");
  await page.getByRole("switch", { name: "Home requested (B)" }).click();
  await expect(page.locator(".mx-decision-state.is-active")).toHaveText("Shoot");
  await expect(rows.nth(6)).toHaveClass(/is-deciding/);
  await page.screenshot({ path: info.outputPath("superstructure-ladder.png") });
  // The inspector lists the same rows in words, including the one that keeps the state.
  await rows.nth(6).locator(".mx-decision-state").click();
  await expect(page.locator(".mx-guard-edge").nth(6)).toContainText("Shoot requested (A / auto)");
  await expect(page.locator(".mx-guard-edge").nth(6)).toContainText("(stays)");
});
