import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Property-based UI testing: a seeded random walk through the app (clicks, tabs, typing, keys)
// that checks properties which must hold after every step, whatever was clicked. A failure names
// the seed and the steps, so it replays exactly: UI_SEED=<seed> pnpm test:e2e ui-properties.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

const STEPS = Number(process.env.UI_STEPS ?? 40);
const SEEDS = process.env.UI_SEED ? [Number(process.env.UI_SEED)] : [1, 2, 3];
// Never clicked: what leaves the page, changes things outside it, or can't be undone in a test.
const UNSAFE = /delete|remove|reset|discard|merge|deploy|put main|clear|sign out|quit|restart|update now|download|export|open in|github|docs/i;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
}

/** The properties every screen keeps. Each returns a problem, or undefined. */
async function properties(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.querySelector(".ms-crash-recovery")) out.push(`crashed: ${document.querySelector(".ms-crash-recovery pre")?.textContent?.slice(0, 200)}`);
    if (!document.querySelector('nav[aria-label="Suite tools"]')) out.push("the suite navigation is gone");
    const root = document.scrollingElement!;
    if (root.scrollWidth > root.clientWidth + 1) out.push(`the page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    for (const el of document.querySelectorAll<HTMLElement>("button, [role=tab], a[href], input, select, textarea")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
      const labelled = name || (el as HTMLInputElement).labels?.length || el.getAttribute("aria-labelledby");
      if (!labelled && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") out.push(`a ${el.tagName.toLowerCase()} with no accessible name (${el.className})`);
    }
    if (/\b(NaN|undefined|\[object Object\])\b/.test(document.body.innerText)) out.push(`shows ${/\b(NaN|undefined|\[object Object\])\b/.exec(document.body.innerText)![0]} as text`);
    return out;
  });
}

for (const seed of SEEDS)
  test(`UI properties hold on a random walk (seed ${seed})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on("dialog", (d) => d.dismiss());
    page.on("filechooser", () => {});
    const text = await readFile(new URL("../tests/fixtures/robot-project.json", import.meta.url), "utf8");
    await page.goto("/");
    await page.locator("#mx-project-import").setInputFiles({ name: "robot.mayhem.json", mimeType: "application/json", buffer: Buffer.from(text) });
    const random = rng(seed);
    const steps: string[] = [];
    for (let i = 0; i < STEPS; i++) {
      const targets = await page.locator("button:visible:enabled, [role=tab]:visible, input[type=checkbox]:visible:enabled, select:visible:enabled, input[type=text]:visible:enabled, input[type=number]:visible:enabled").all();
      const roll = random();
      if (roll < 0.08) {
        const key = ["Escape", "Tab", "Enter", "ArrowDown", "ArrowRight"][Math.floor(random() * 5)];
        steps.push(`key ${key}`);
        await page.keyboard.press(key);
      } else if (targets.length) {
        const target = targets[Math.floor(random() * targets.length)];
        const name = ((await target.getAttribute("aria-label")) || (await target.textContent()) || (await target.getAttribute("title")) || "").trim().slice(0, 40);
        if (UNSAFE.test(name)) continue;
        const tag = await target.evaluate((e) => `${e.tagName.toLowerCase()}:${(e as HTMLInputElement).type ?? ""}`);
        try {
          if (tag.startsWith("select")) {
            const options = await target.locator("option").allTextContents();
            const pick = options[Math.floor(random() * options.length)];
            steps.push(`select “${pick}” in ${name || tag}`);
            await target.selectOption({ label: pick }, { timeout: 2000 });
          } else if (tag === "input:text" || tag === "input:number") {
            const value = tag === "input:number" ? String(Math.round((random() * 20 - 5) * 100) / 100) : ["", "x", "Auto 2", "é ✓"][Math.floor(random() * 4)];
            steps.push(`type “${value}” into ${name || tag}`);
            await target.fill(value, { timeout: 2000 });
            await target.press("Tab");
          } else {
            steps.push(`click ${name || tag}`);
            await target.click({ timeout: 2000 });
          }
        } catch {
          steps.push("  (not clickable: covered or gone)");
          continue;
        }
      }
      await page.waitForTimeout(60);
      const problems = [...(await properties(page)), ...errors.splice(0)];
      expect(problems, `seed ${seed}, after:\n${steps.slice(-8).join("\n")}`).toEqual([]);
    }
  });
