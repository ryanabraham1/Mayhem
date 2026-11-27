import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, TOOL_SPECS } from "../e2e/features";

const E2E = join(process.cwd(), "e2e");
const specs = readdirSync(E2E).filter((f) => f.endsWith(".spec.ts"));
/** Each spec's test titles, as written (template literals keep their ${…}). */
const titles = new Map(specs.map((f) => [f, [...readFileSync(join(E2E, f), "utf8").matchAll(/(?:^|\n)\s*test\(\s*(?:"([^"]+)"|`([^`]+)`)/g)].map((m) => m[1] ?? m[2])]));

describe("feature map (app/e2e/features.ts)", () => {
  it("points only at browser tests that exist", () => {
    const broken = FEATURES.flatMap((f) => (f.proof ?? []).filter((p) => {
      const [file, ...rest] = p.split(": ");
      return !titles.get(file)?.includes(rest.join(": "));
    }));
    expect(broken).toEqual([]);
  });

  it("lists every browser test under the feature it proves", () => {
    const mapped = new Set(FEATURES.flatMap((f) => f.proof ?? []));
    const unmapped = [...titles].filter(([f]) => !TOOL_SPECS.includes(f)).flatMap(([f, ts]) => ts.map((t) => `${f}: ${t}`)).filter((p) => !mapped.has(p));
    expect(unmapped, "Add these tests to app/e2e/features.ts").toEqual([]);
  });

  it("covers every page, and every feature has a test or says what one needs", () => {
    // The pages in the app's navigation (SuiteApp.tsx), plus Settings: a new page needs a row and a test.
    const nav = readFileSync(join(process.cwd(), "src/suite/SuiteApp.tsx"), "utf8");
    const pages = [...nav.slice(nav.indexOf("const navigation")).matchAll(/\{ id: "\w+", name: "([^"]+)"/g)].map((m) => m[1]).concat("Settings");
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.filter((p) => !FEATURES.some((f) => f.page === p && f.proof?.length))).toEqual([]);
    expect(FEATURES.filter((f) => !f.proof?.length && !f.gap).map((f) => f.feature)).toEqual([]);
  });
});
