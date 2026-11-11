"""Launch an installed/extracted desktop bundle and fail on early process exit.

This catches loader, missing-library and startup crashes, not native UI correctness.
"""
import os
import platform
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    bundle = ROOT / "app/src-tauri/target/release/bundle"
    log = ROOT / "artifacts/desktop-smoke.log"
    log.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mayhem-desktop-") as directory:
        install = Path(directory) / "installed"
        system = platform.system()
        if system == "Darwin":
            executable, = bundle.glob("macos/*.app/Contents/MacOS/mayhem")
        elif system == "Linux":
            archive, = bundle.glob("deb/*.deb")
            subprocess.run(["dpkg-deb", "-x", str(archive), str(install)], check=True)
            executable = install / "usr/bin/mayhem"
        elif system == "Windows":
            installer, = bundle.glob("nsis/*-setup.exe")
            subprocess.run([str(installer), "/S", f"/D={install}"], check=True, timeout=180)
            executable = install / "mayhem.exe"
        else:
            raise RuntimeError(f"Unsupported platform: {system}")
        assert executable.is_file(), executable
        env = {**os.environ, "XDG_CONFIG_HOME": str(Path(directory) / "config"),
               "XDG_DATA_HOME": str(Path(directory) / "data")}
        with log.open("w") as output:
            output.write(f"Starting packaged executable: {executable}\n")
            output.flush()
            child = subprocess.Popen([str(executable)], cwd=directory, env=env,
                                     stdout=output, stderr=subprocess.STDOUT)
            try:
                child.wait(timeout=10)
                raise RuntimeError(f"Packaged app exited early: {child.returncode}; see {log}")
            except subprocess.TimeoutExpired:
                print("Packaged application stayed running for 10 seconds")
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)


if __name__ == "__main__":
    main()
