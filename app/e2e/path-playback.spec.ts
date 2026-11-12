import { expect, test } from "@playwright/test";

test("animates between fixed samples, pauses, scrubs and resumes without jumping", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  await page
    .getByRole("button", { name: "Play simulation", exact: true })
    .click();
  const transforms = await page.evaluate(async () => {
    const svg = document.querySelector(
      '[aria-label="Autonomous field editor"]',
    )!;
    const robot =
      svg.querySelector('g[style*="pointer-events"]:last-of-type') ??
      svg.querySelector(":scope > g:last-of-type");
    if (!robot) throw new Error("Robot display missing");
    const result: string[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      result.push(robot.getAttribute("transform") ?? "");
    }
    return result;
  });
  expect(new Set(transforms).size).toBeGreaterThan(20);
  await page
    .getByRole("button", { name: "Pause simulation", exact: true })
    .click();
  const slider = page.getByRole("slider", { name: "Preview time" });
  const paused = Number(await slider.inputValue());
  await page.waitForTimeout(100);
  expect(Number(await slider.inputValue())).toBe(paused);
  await slider.fill("0");
  expect(Number(await slider.inputValue())).toBe(0);
  await page
    .getByRole("button", { name: "Play simulation", exact: true })
    .click();
  await expect
    .poll(async () => Number(await slider.inputValue()))
    .toBeGreaterThan(0.05);
  expect(Number(await slider.inputValue())).toBeLessThan(paused);
  await page
    .getByRole("button", { name: "Pause simulation", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("path-playback.png") });
  expect(errors).toEqual([]);
});
