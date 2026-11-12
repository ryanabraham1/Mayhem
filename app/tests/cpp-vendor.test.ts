// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { vendorCpp } from "../../scripts/cpp-vendor.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = resolve(root, "scripts/mayhem.mjs");
const headers = resolve(root, "lib-cpp/include/mayhem");
const names = readdirSync(headers).filter((n) => n.endsWith(".hpp")).sort();
const version = /#define MAYHEM_CPP_VERSION "([^"]+)"/.exec(readFileSync(join(headers, "version.hpp"), "utf8"))![1];
const dir = mkdtempSync(resolve(tmpdir(), "mayhem-vendor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const python = process.platform === "win32" ? "python" : "python3";

describe("vendoring the C++ headers into a robot project", () => {
  it("leaves the command framework to wpilib.hpp, so a command-free robot can skip it", () => {
    expect(names).toEqual(expect.arrayContaining(["pose_driver.hpp", "wpilib_log.hpp", "wpilib.hpp"]));
    const frc2 = names.filter((n) => /#include\s*[<"](frc2\/|mayhem\/wpilib\.hpp)/.test(readFileSync(join(headers, n), "utf8")));
    expect(frc2).toEqual(["wpilib.hpp"]);
    expect(readFileSync(join(headers, "wpilib.hpp"), "utf8")).toMatch(/#include "mayhem\/wpilib_log\.hpp"/);
  });

  it("copies every header with a snapshot, checks it, and repairs drift", async () => {
    const robot = join(dir, "robot");
    const dest = join(robot, "src/main/include/mayhem");
    expect((await vendorCpp(robot, { check: true })).upToDate).toBe(false);
    const result = await vendorCpp(robot);
    expect(result).toMatchObject({ version, dest: "src/main/include/mayhem", snapshot: "src/main/include/mayhem/mayhem-vendor.json" });
    expect(result.files).toEqual(names);
    for (const name of names) expect(readFileSync(join(dest, name))).toEqual(readFileSync(join(headers, name)));
    const snapshot = JSON.parse(readFileSync(join(dest, "mayhem-vendor.json"), "utf8"));
    expect(snapshot).toMatchObject({ format: "mayhem-cpp-vendor", version, source: "lib-cpp/include/mayhem" });
    expect(Object.keys(snapshot.sha256)).toEqual(names);
    expect(await vendorCpp(robot, { check: true })).toEqual({ upToDate: true, version, problems: [] });
    // An unchanged re-run writes nothing.
    expect((await vendorCpp(robot)).written).toEqual([]);

    writeFileSync(join(dest, "auto_runner.hpp"), "// edited\n");
    const drift = await vendorCpp(robot, { check: true });
    expect(drift.upToDate).toBe(false);
    expect(drift.problems).toEqual([`src/main/include/mayhem/auto_runner.hpp differs from Mayhem ${version}`]);
    expect((await vendorCpp(robot)).written).toEqual(["src/main/include/mayhem/auto_runner.hpp"]);

    // Files the previous snapshot listed but Mayhem no longer ships are removed; others are kept.
    snapshot.sha256["old_header.hpp"] = "0";
    writeFileSync(join(dest, "mayhem-vendor.json"), JSON.stringify(snapshot));
    writeFileSync(join(dest, "old_header.hpp"), "// gone\n");
    writeFileSync(join(dest, "robot_owned.hpp"), "// mine\n");
    expect((await vendorCpp(robot, { check: true })).problems).toEqual(["src/main/include/mayhem/old_header.hpp is no longer part of Mayhem"]);
    expect((await vendorCpp(robot)).removed).toEqual(["src/main/include/mayhem/old_header.hpp"]);
    expect(existsSync(join(dest, "robot_owned.hpp"))).toBe(true);

    await expect(vendorCpp(robot, { dest: "../elsewhere" })).rejects.toThrow(/inside the robot project/);
  });

  it("supports a custom snapshot path and reports staleness from the CLI", () => {
    const robot = join(dir, "cli-robot");
    mkdirSync(robot);
    const run = (...args: string[]) => spawnSync(process.execPath, [script, "vendor", robot, ...args], { encoding: "utf8" });
    const snapshot = ["--snapshot", "docs/mayhem/vendor-snapshot.json"];
    const missing = run(...snapshot, "--check");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/headers are stale:[\s\S]*auto_runner\.hpp is missing[\s\S]*Run: node scripts\/mayhem\.mjs vendor .* --snapshot docs\/mayhem\/vendor-snapshot\.json/);
    const write = run(...snapshot);
    expect([write.status, write.stderr]).toEqual([0, ""]);
    expect(JSON.parse(write.stdout).snapshot).toBe("docs/mayhem/vendor-snapshot.json");
    expect(existsSync(join(robot, "src/main/include/mayhem/mayhem-vendor.json"))).toBe(false);
    const check = run(...snapshot, "--check");
    expect([check.status, check.stderr]).toEqual([0, ""]);
  });
});

describe("MayhemCpp vendordep", () => {
  const build = (out: string) =>
    execFileSync(python, [resolve(root, "scripts/build-cpp-vendordep.py"), "--output", out], { encoding: "utf8" });
  const listZip = (path: string) =>
    execFileSync(python, ["-c", "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", path], { encoding: "utf8" })
      .trim().split(/\r?\n/);

  it("describes a header-only C++ dependency GradleRIO can resolve on the roboRIO", () => {
    const out = join(dir, "vendordep");
    build(out);
    const json = JSON.parse(readFileSync(join(out, "MayhemCpp.json"), "utf8"));
    expect(json).toMatchObject({
      fileName: "MayhemCpp.json",
      name: "MayhemCpp",
      version,
      frcYear: "2026",
      mavenUrls: ["https://ryanabraham1.github.io/Mayhem/maven/"],
      jsonUrl: "https://ryanabraham1.github.io/Mayhem/MayhemCpp.json",
      javaDependencies: [],
      jniDependencies: [],
    });
    const [cpp] = json.cppDependencies;
    // native-utils only adds a C++ vendordep to robot builds when binaryPlatforms lists the
    // robot platform, then needs <platform>static(debug) zips for it.
    expect(cpp).toMatchObject({ groupId: "mayhemlib", artifactId: "MayhemCpp-cpp", version, headerClassifier: "headers", sharedLibrary: false, skipInvalidPlatforms: true });
    expect(cpp.binaryPlatforms).toContain("linuxathena");
    const base = join(out, "repos/releases/mayhemlib/MayhemCpp-cpp", version);
    expect(listZip(join(base, `MayhemCpp-cpp-${version}-headers.zip`))).toEqual([
      ...names.map((n) => `mayhem/${n}`),
      "mayhem/THIRD_PARTY_NOTICES.md",
    ]);
    for (const platform of cpp.binaryPlatforms)
      for (const suffix of ["static", "staticdebug"])
        expect(listZip(join(base, `MayhemCpp-cpp-${version}-${platform}${suffix}.zip`))).toEqual(["README.txt"]);
    expect(readFileSync(join(base, `MayhemCpp-cpp-${version}.pom`), "utf8")).toContain(`<version>${version}</version>`);
    expect(readFileSync(join(out, "repos/releases/mayhemlib/MayhemCpp-cpp/maven-metadata.xml"), "utf8")).toContain(`<release>${version}</release>`);
  });

  it("is byte-for-byte reproducible", () => {
    const [a, b] = [join(dir, "a"), join(dir, "b")];
    build(a);
    build(b);
    const base = `repos/releases/mayhemlib/MayhemCpp-cpp/${version}/MayhemCpp-cpp-${version}-headers.zip`;
    expect(readFileSync(join(a, base))).toEqual(readFileSync(join(b, base)));
    expect(readFileSync(join(a, "MayhemCpp.json"))).toEqual(readFileSync(join(b, "MayhemCpp.json")));
  });
});
