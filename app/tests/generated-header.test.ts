// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { exportCpp } from "../src/suite/core/export-cpp.ts";
import { generateHeader, matchFromTable, syncHeader } from "../src/suite/core/generated-header.ts";
import { parseProject } from "../src/suite/core/model.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = resolve(root, "scripts/mayhem.mjs");
const exampleText = readFileSync(resolve(root, "examples/suite/competition.mayhem.json"), "utf8");
const dir = mkdtempSync(resolve(tmpdir(), "mayhem-header-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const HEADER = "src/main/include/commands/MayhemProject.h";

describe("keeping MayhemProject.h in step with the project file", () => {
  it("generates exactly what exportCpp writes for the saved text", () => {
    expect(generateHeader(exampleText)).toBe(exportCpp(parseProject(exampleText)));
    const same = () => "same" as const;
    expect(syncHeader(exampleText, "old", undefined, same)).toEqual({ code: generateHeader(exampleText), result: { status: "updated" } });
    expect(syncHeader(exampleText, generateHeader(exampleText), "abc", same)).toEqual({ result: { status: "unchanged" } });
  });
  it("leaves the header alone and says why when the robot's pinned exporter may differ", () => {
    const different = syncHeader(exampleText, "old", "0123456789abcdef", () => "different");
    expect(different.code).toBeUndefined();
    expect(different.result).toMatchObject({ status: "skipped", message: expect.stringContaining("pins Mayhem 0123456") });
    expect(syncHeader(exampleText, "old", "0123456789abcdef", () => "unknown").result).toMatchObject({ status: "skipped", message: expect.stringContaining("can't tell") });
    expect(syncHeader(exampleText, "old", "", () => "same").result).toMatchObject({ status: "skipped", message: expect.stringContaining("names no Mayhem commit") });
  });
  it("reports a project it can't generate from", () => {
    expect(syncHeader("{}", "old", undefined, () => "same").result).toMatchObject({ status: "failed", message: expect.stringContaining("could not be regenerated") });
  });
  it("reads the app's built-in exporter table", () => {
    const table = { fingerprint: "f", compatible: ["a"], known: ["a", "b"] };
    expect([matchFromTable("a", table), matchFromTable("b", table), matchFromTable("c", table), matchFromTable("a", null)]).toEqual(["same", "different", "unknown", "unknown"]);
  });

  /** A robot repo with a project file, a stale generated header and an exporter pin. */
  const robot = (name: string, pinned?: string) => {
    const repo = join(dir, name);
    mkdirSync(join(repo, "src/main/include/commands"), { recursive: true });
    writeFileSync(join(repo, "robot.mayhem.json"), exampleText);
    writeFileSync(join(repo, HEADER), "// stale\n");
    if (pinned !== undefined) {
      mkdirSync(join(repo, "docs/mayhem"), { recursive: true });
      writeFileSync(join(repo, "docs/mayhem/vendor-snapshot.json"), JSON.stringify({ commit: pinned }));
    }
    return repo;
  };
  const save = (repo: string) => {
    const project = JSON.parse(readFileSync(join(repo, "robot.mayhem.json"), "utf8"));
    project.routines[0].name = "Renamed auto";
    const out = execFileSync(process.execPath, [script, "save", join(repo, "robot.mayhem.json"), JSON.stringify({ project, expectedRevision: project.revision })], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out);
  };
  const check = (repo: string) => spawnSync(process.execPath, [script, "cpp", join(repo, "robot.mayhem.json"), "--check", join(repo, HEADER)]).status;

  // Pinning HEAD only matches while the exporter in the working tree is HEAD's.
  const clean = spawnSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", "app/src", "scripts"]).status === 0;
  it.skipIf(!clean)("save_project regenerates the header byte for byte like `cpp --out`", () => {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const repo = robot("pinned-here", head);
    expect(save(repo).header).toMatchObject({ status: "updated" });
    expect(check(repo)).toBe(0);
    expect(readFileSync(join(repo, HEADER), "utf8")).toContain("Renamed auto");
    // No pin at all: still regenerated.
    const unpinned = robot("unpinned");
    expect(save(unpinned).header).toMatchObject({ status: "updated" });
    expect(check(unpinned)).toBe(0);
  }, 60_000);
  it("save_project leaves the header for an unknown pinned exporter, and a folder without one alone", () => {
    const repo = robot("pinned-elsewhere", "1234567890123456789012345678901234567890");
    expect(save(repo).header).toMatchObject({ status: "skipped", message: expect.stringContaining("1234567") });
    expect(readFileSync(join(repo, HEADER), "utf8")).toBe("// stale\n");
    const plain = join(dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "robot.mayhem.json"), exampleText);
    expect(save(plain).header).toBeUndefined();
  }, 60_000);
});
