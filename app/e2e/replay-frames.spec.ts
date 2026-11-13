// Renders a 3D before/after replay frame by frame (smooth video regardless of render speed):
// MAYHEM_REVIEW_REPO, MAYHEM_FRAMES (folder), MAYHEM_BEFORE, MAYHEM_ROUTINE, MAYHEM_FPS.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "./reviewBridge";

const repo = process.env.MAYHEM_REVIEW_REPO;
const out = process.env.MAYHEM_FRAMES;
test.skip(!repo || !out, "renders replay frames on request");
// The Mac's GPU (Metal) instead of software rendering.
test.use({ launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader=false"] } });

test("renders a 3D before/after replay frame by frame", async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args]).toString().trim();
  await desktop(page, repo!);
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: /Choose robot code folder/ }).first().click();
  await page.getByLabel("Before version").selectOption(git("rev-parse", process.env.MAYHEM_BEFORE ?? "HEAD~1"));
  await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
  await page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Sim proof/ }).click();
  await page.getByRole("button", { name: "Run sim proof" }).click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 800_000 });
  await page.getByRole("navigation", { name: "Scenarios" }).getByRole("button", { name: new RegExp(`^${process.env.MAYHEM_ROUTINE ?? "Depot Trench Sweep Depot"}`) }).click();
  await page.getByRole("group", { name: "Replay view" }).getByRole("button", { name: "3D" }).click();
  await expect(page.locator(".mx-replay-3d-status")).toBeHidden({ timeout: 180_000 });
  const slider = page.getByLabel("Replay time");
  const end = Number(await slider.getAttribute("max"));
  const fps = Number(process.env.MAYHEM_FPS ?? 15);
  const proof = page.locator(".mx-replay-proof");
  await proof.scrollIntoViewIfNeeded();
  const started = Date.now();
  console.log("renderer:", await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  }));
  for (let i = 0, t = 0; t <= end; i++, t = i / fps) {
    await slider.fill(t.toFixed(2));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // The canvas itself (keeps its drawing buffer), much faster than a page screenshot.
    const data = await page.evaluate(() => (document.querySelector(".mx-replay-3d canvas") as HTMLCanvasElement).toDataURL("image/jpeg", 0.9));
    writeFileSync(join(out!, `f${String(i).padStart(5, "0")}.jpg`), Buffer.from(data.split(",")[1], "base64"));
    if (i === 3) console.log(`frames/s so far: ${(4 / ((Date.now() - started) / 1000)).toFixed(2)}`);
  }
});
