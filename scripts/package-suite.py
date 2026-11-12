"""Build portable, dependency-free suite tools and C++ source distributions."""
import argparse
import hashlib
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+-]*", args.version):
        parser.error("version must be a safe filename component")
    args.output.mkdir(parents=True, exist_ok=True)
    core = ROOT / "app/src/suite/core"
    core_files = [p for p in sorted(core.rglob("*")) if p.is_file()
                  and (p.suffix in {".ts", ".json", ".md"} or p.name == "LICENSE")]
    tools = [ROOT / "scripts/mayhem.mjs", ROOT / "scripts/suite-imports.mjs", *core_files,
             ROOT / "THIRD_PARTY_NOTICES.md",
             ROOT / "docs/SUITE_AGENTS.md", ROOT / "docs/ROBOT_LOGGING.md",
             ROOT / "docs/TEAM_LOGS.md", *sorted((ROOT / "examples/suite").glob("*.json"))]
    cpp = [p for p in sorted((ROOT / "lib-cpp").rglob("*")) if p.is_file()
           and p.relative_to(ROOT / "lib-cpp").parts[0] in
           {"include", "tests", "cmake", "CMakeLists.txt", "README.md"}]
    cpp.append(ROOT / "examples/suite/competition.hpp")
    sums = []
    for name, files, readme in [
        ("suite-tools", tools, "Requires Node 24+. No npm install needed.\n\n"
         "Run: node scripts/mayhem.mjs example\n"
         "CLI and MCP setup: docs/SUITE_AGENTS.md\n"
         "Keep the archive's directory structure intact.\n"),
        ("cpp", cpp, "Header-only C++17 library; optional WPILib adapters require C++20.\n"
         "Build/install instructions: lib-cpp/README.md\n"
         "This is separate from the Java MayhemLib vendordep.\n"),
    ]:
        stem = f"Mayhem-{name}-{args.version}"
        archive = args.output / f"{stem}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as out:
            out.writestr(f"{stem}/README.txt", f"Mayhem {args.version}\n\n{readme}")
            for path in files:
                out.write(path, f"{stem}/{path.relative_to(ROOT).as_posix()}")
        sums.append(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
        print(archive)
    (args.output / "Mayhem-suite-SHA256SUMS.txt").write_text("".join(sums))


if __name__ == "__main__":
    main()
