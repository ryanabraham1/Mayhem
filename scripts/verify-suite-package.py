"""Exercise extracted release archives without imports from the source checkout."""
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def run(args, cwd, **kwargs):
    result = subprocess.run(args, cwd=cwd, capture_output=True,
                            text=True, timeout=120, **kwargs)
    if result.returncode:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        result.check_returncode()
    return result.stdout


def main():
    archives = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="mayhem distribution ") as directory:
        destination = Path(directory)
        roots = {}
        for line in (archives / "Mayhem-suite-SHA256SUMS.txt").read_text().splitlines():
            digest, name = line.split("  ")
            archive = archives / name
            assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest, name
            with zipfile.ZipFile(archive) as source:
                source.extractall(destination)
            roots["tools" if "suite-tools" in name else "cpp"] = destination / archive.stem
        root = roots["tools"]
        cli = ["node", str(root / "scripts/mayhem.mjs")]
        project = root / "new robot.json"
        example = json.loads(run([*cli, "example"], root))
        project.write_text(json.dumps(example))
        validation = json.loads(run([*cli, "validate", str(project)], root))
        assert not [i for i in validation["issues"] if i["severity"] == "error"], validation
        result = json.loads(run([*cli, "simulate", str(project), '{"mode":"path"}'], root))
        assert result["status"] == "completed", result
        code = run([*cli, "cpp", str(project)], root)
        assert "mayhem_generated" in code
        (root / "generated.hpp").write_text(code)
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                "name": "inspect_project", "arguments": {"path": str(project)}}},
        ]
        replies = [json.loads(line) for line in run([*cli, "mcp"], root,
                    input="".join(json.dumps(r) + "\n" for r in requests)).splitlines()]
        assert [r["id"] for r in replies] == [1, 2, 3], replies
        assert replies[0]["result"]["serverInfo"]["name"] == "mayhem-suite"
        assert "simulate_auto" in [t["name"] for t in replies[1]["result"]["tools"]]
        inspected = replies[2]["result"]
        assert not inspected.get("isError"), inspected
        assert json.loads(inspected["content"][0]["text"])["name"] == example["name"]
        cpp = roots["cpp"]
        run(["cmake", "-S", "lib-cpp", "-B", "build", "-DBUILD_TESTING=ON"], cpp)
        run(["cmake", "--build", "build", "--config", "Debug"], cpp)
        run(["ctest", "--test-dir", "build", "-C", "Debug", "--output-on-failure"], cpp)
        # Compile the actual Node-generated routine against the independently extracted library.
        consumer = destination / "generated-consumer"
        consumer.mkdir()
        (consumer / "main.cpp").write_text('#include "generated.hpp"\nint main() { return 0; }\n')
        (consumer / "CMakeLists.txt").write_text('''cmake_minimum_required(VERSION 3.20)
project(GeneratedConsumer LANGUAGES CXX)
add_subdirectory("${MAYHEM_CPP}/lib-cpp" mayhem)
add_executable(consumer main.cpp)
target_link_libraries(consumer PRIVATE Mayhem::Core)
target_include_directories(consumer PRIVATE "${MAYHEM_TOOLS}")
''')
        run(["cmake", "-S", str(consumer), "-B", "generated-build",
             f"-DMAYHEM_CPP={cpp.as_posix()}", f"-DMAYHEM_TOOLS={root.as_posix()}",
             "-DBUILD_TESTING=OFF"], destination)
        run(["cmake", "--build", "generated-build", "--config", "Debug"], destination)
        print("Verified archive hashes, standalone CLI, simulation, MCP stdio, C++ tests and generated C++ compilation")


if __name__ == "__main__":
    main()
