import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { sampleProject } from "../src/suite/core/sample";
import { DEFAULT_CONSTRAINTS, DEFAULT_GOAL } from "../src/suite/core/model";

test("keeps pose controls compact and provides generated visual constraints", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const project = structuredClone(sampleProject);
  project.robot.start = { x: 1, y: 1, heading: 0 };
  project.robot.constraints = { ...DEFAULT_CONSTRAINTS };
  const nodes: any[] = [
    [4, 1],
    [4, 4],
    [7, 4],
  ].map(([x, y], i) => ({
    id: `p${i}`,
    name: `Pose ${i + 1}`,
    kind: "pose",
    timeout: 30,
    goal: { ...DEFAULT_GOAL, x, y },
  }));
  nodes.push({ id: "f", name: "Finish", kind: "finish", timeout: 1 });
  project.routines = [
    {
      id: "constraint-path",
      name: "Constraint path",
      initial: "p0",
      nodes,
      transitions: nodes.slice(0, -1).map((n, i) => ({
        id: `t${i}`,
        from: n.id,
        to: nodes[i + 1].id,
        condition: { kind: "always" },
      })),
    },
  ];
  await page.addInitScript((project) => {
    if (!localStorage.getItem("mayhem.suite.project.v1"))
      localStorage.setItem("mayhem.suite.project.v1", JSON.stringify(project));
    localStorage.setItem("mayhem.page.v1", "autos");
  }, project);
  await page.goto("/");
  const inspector = page.getByRole("complementary", {
    name: "Inspector",
    exact: true,
  });
  await expect(inspector.getByRole("spinbutton")).toHaveCount(4);
  await expect(page.getByLabel("Failure watchdog")).toBeHidden();
  await expect(page.getByLabel("Concurrent callbacks")).toBeHidden();
  await inspector
    .getByRole("button", { name: "Advanced", exact: true })
    .click();
  await expect(page.getByLabel("Failure watchdog")).toBeVisible();
  await page
    .getByRole("button", { name: "Select goal Pose 2", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Pose", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("simplified-pose.png") });
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await expect(inspector).toBeHidden();
  await page.getByRole("button", { name: "Show inspector", exact: true }).click();
  await expect(inspector).toBeVisible();
  await page
    .getByRole("button", { name: "Whole path", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("group", { name: "Path constraint map" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(inspector.getByRole("status")).toHaveText(
    /Up to date|Review limits/,
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Speed limit 2: Pose 2", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Constraint value mode" })
    .getByRole("button", { name: "Manual", exact: true })
    .click();
  await page.getByLabel("Segment speed limit", { exact: true }).fill("1.3");
  await page.getByLabel("Segment speed limit", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(inspector.getByRole("status")).toHaveText(
    /Up to date|Review limits/,
    { timeout: 30000 },
  );
  await expect(
    page.getByLabel("Segment speed limit", { exact: true }),
  ).toHaveValue("1.3");
  await page.screenshot({ path: info.outputPath("visual-constraints.png") });
  await page.getByRole("button", { name: "Switch project" }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export project", exact: true })
    .click();
  const file = await download;
  await page.getByRole("button", { name: "Close projects" }).click();
  const output = info.outputPath("constraints.mayhem.json");
  await file.saveAs(output);
  const saved = JSON.parse(await readFile(output, "utf8"));
  expect(saved.routines[0].nodes[1].constraints.maxVelocity).toBe(1.3);
  expect(
    saved.routines[0].nodes[0].generatedConstraints.handoffRadius,
  ).toBeGreaterThan(0);
  expect(saved.routines[0].constraintGeneration.signature).toBeTruthy();
  await page
    .getByRole("group", { name: "Constraint value mode" })
    .getByRole("button", { name: "Auto", exact: true })
    .click();
  await expect(
    page.getByLabel("Segment speed limit", { exact: true }),
  ).toBeHidden();
  await page
    .getByRole("group", { name: "Constraint scope" })
    .getByRole("button", { name: "Path limits", exact: true })
    .click();
  await page.getByLabel("Max acceleration", { exact: true }).fill("3");
  await page.getByLabel("Max acceleration", { exact: true }).press("Tab");
  await expect(
    page.getByLabel("Max acceleration", { exact: true }),
  ).toHaveValue("3");
  await page
    .getByRole("group", { name: "Constraint scope" })
    .getByRole("button", { name: "Range", exact: true })
    .click();
  await page.getByLabel("From step", { exact: true }).selectOption("0");
  await page.getByLabel("Through step", { exact: true }).selectOption("1");
  await page.getByLabel("Max speed", { exact: true }).fill("1.8");
  await page.getByLabel("Max speed", { exact: true }).press("Tab");
  await page
    .getByRole("button", { name: "Apply range limits", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Whole path", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Speed limit 1: Pose 1", exact: true }),
  ).toContainText("1.8 m/s");
  await expect(
    page.getByRole("button", { name: "Speed limit 2: Pose 2", exact: true }),
  ).toContainText("1.8 m/s");
  expect(errors).toEqual([]);
});
