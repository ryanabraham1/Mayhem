"""Build the header-only MayhemCpp WPILib vendordep: a maven repo plus MayhemCpp.json.

GradleRIO (native-utils WPIVendorMavenDependency) adds a C++ vendordep to roboRIO builds only
when `binaryPlatforms` lists linuxathena/systemcore, and then resolves `<platform>static` and
`<platform>staticdebug` zips for those platforms and links the *.a/*.lib files it finds. So
the repo carries the headers zip plus empty static zips for the robot platforms; simulation
platforms are not listed and, with skipInvalidPlatforms, get the headers only.

Usage: python3 scripts/build-cpp-vendordep.py --output build/cpp-vendordep
         [--maven-url URL] [--json-url URL]
Writes <output>/repos/releases/mayhemlib/MayhemCpp-cpp/<version>/... and
<output>/MayhemCpp.json. Output bytes are deterministic for the same sources.
"""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADERS = ROOT / "lib-cpp/include/mayhem"
GROUP, ARTIFACT, NAME = "mayhemlib", "MayhemCpp-cpp", "MayhemCpp"
UUID = "bbc3a081-21ab-47e0-b9fa-b67c6e42b842"
PAGES = "https://ryanabraham1.github.io/Mayhem"
ROBOT_PLATFORMS = ["linuxathena", "systemcore"]
EPOCH = (1980, 1, 1, 0, 0, 0)


def version():
    text = (HEADERS / "version.hpp").read_text()
    match = re.search(r'^#define MAYHEM_CPP_VERSION "([0-9]+\.[0-9]+\.[0-9]+)"', text, re.M)
    if not match:
        raise SystemExit("lib-cpp/include/mayhem/version.hpp does not define MAYHEM_CPP_VERSION")
    return match.group(1)


def write_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
        for name, data in entries:
            info = zipfile.ZipInfo(name, EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            out.writestr(info, data)


def checksums(path):
    data = path.read_bytes()
    for algorithm in ("md5", "sha1", "sha256"):
        Path(f"{path}.{algorithm}").write_text(hashlib.new(algorithm, data).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--maven-url", default=f"{PAGES}/maven/")
    parser.add_argument("--json-url", default=f"{PAGES}/{NAME}.json")
    args = parser.parse_args()
    v = version()
    directory = args.output / "repos/releases" / GROUP / ARTIFACT / v
    directory.mkdir(parents=True, exist_ok=True)
    stem = directory / f"{ARTIFACT}-{v}"

    # Every header including subdirectories (sim/), sorted like `mayhem.mjs vendor` sorts them.
    headers = sorted(HEADERS.rglob("*.hpp"), key=lambda p: p.relative_to(HEADERS).as_posix())
    notice = (ROOT / "THIRD_PARTY_NOTICES.md").read_bytes()
    write_zip(f"{stem}-headers.zip",
              [(f"mayhem/{p.relative_to(HEADERS).as_posix()}", p.read_bytes()) for p in headers]
              + [("mayhem/THIRD_PARTY_NOTICES.md", notice)])
    placeholder = (f"MayhemCpp {v} is header-only. GradleRIO requires a static library archive for "
                   "robot platforms; this one is intentionally empty.\n").encode()
    artifacts = [f"{stem}-headers.zip"]
    for platform in ROBOT_PLATFORMS:
        for suffix in ("static", "staticdebug"):
            path = f"{stem}-{platform}{suffix}.zip"
            write_zip(path, [("README.txt", placeholder)])
            artifacts.append(path)
    pom = Path(f"{stem}.pom")
    pom.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>{GROUP}</groupId>
  <artifactId>{ARTIFACT}</artifactId>
  <version>{v}</version>
  <packaging>pom</packaging>
  <name>MayhemCpp</name>
  <description>Header-only Mayhem C++ library (pose follower, auto runner, state machine, observers, physics sim).</description>
</project>
""")
    for path in [*artifacts, str(pom)]:
        checksums(Path(path))
    # Lists every version present under this output, so repeated builds into one repo stay valid.
    versions = sorted((p.name for p in directory.parent.iterdir() if p.is_dir()),
                      key=lambda s: tuple(int(x) for x in s.split(".")))
    metadata = directory.parent / "maven-metadata.xml"
    metadata.write_text(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<metadata>\n"
        f"  <groupId>{GROUP}</groupId>\n  <artifactId>{ARTIFACT}</artifactId>\n  <versioning>\n"
        f"    <latest>{versions[-1]}</latest>\n    <release>{versions[-1]}</release>\n    <versions>\n"
        + "".join(f"      <version>{x}</version>\n" for x in versions)
        + "    </versions>\n  </versioning>\n</metadata>\n")
    checksums(metadata)
    vendordep = {
        "fileName": f"{NAME}.json",
        "name": NAME,
        "version": v,
        "frcYear": "2026",
        "uuid": UUID,
        "mavenUrls": [args.maven_url],
        "jsonUrl": args.json_url,
        "javaDependencies": [],
        "jniDependencies": [],
        "cppDependencies": [{
            "groupId": GROUP,
            "artifactId": ARTIFACT,
            "version": v,
            "libName": NAME,
            "headerClassifier": "headers",
            "sharedLibrary": False,
            "skipInvalidPlatforms": True,
            "binaryPlatforms": ROBOT_PLATFORMS,
        }],
    }
    (args.output / f"{NAME}.json").write_text(json.dumps(vendordep, indent=4) + "\n")
    print(args.output / f"{NAME}.json")


if __name__ == "__main__":
    main()
