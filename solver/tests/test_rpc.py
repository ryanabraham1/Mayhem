import json
import subprocess
import sys
import time

from mayhem_solver.models import Trajectory

from .conftest import wp


def test_stdio_roundtrip(tmp_path):
    proc = subprocess.Popen([sys.executable, "-m", "mayhem_solver", "serve"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, bufsize=1)
    try:
        def call(i, method, **params):
            proc.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n")
            proc.stdin.flush()

        def read_until(pred, timeout=120):
            end = time.time() + timeout
            while time.time() < end:
                msg = json.loads(proc.stdout.readline())
                if pred(msg):
                    return msg
            raise TimeoutError

        read_until(lambda m: m.get("method") == "ready")
        call(1, "createProject", dir=str(tmp_path / "proj"))
        opened = read_until(lambda m: m.get("id") == 1)["result"]
        assert opened["trajectories"] == []
        project = opened["project"]
        t = Trajectory(name="Auto 1", waypoints=[wp(0, 2, 2, stop=True), wp(1, 6, 6, stop=True)])
        tj = t.model_dump(by_alias=True, mode="json")
        call(2, "saveTrajectory", dir=opened["dir"], trajectory=tj)
        read_until(lambda m: m.get("id") == 2)
        call(3, "solve", project=project, trajectory=tj)
        done = read_until(lambda m: m.get("method") == "solveDone")
        assert done["params"]["success"], done["params"]["issues"]
        assert done["params"]["output"]["samples"]
        call(4, "openProject", dir=opened["dir"])
        assert read_until(lambda m: m.get("id") == 4)["result"]["trajectories"][0]["name"] == "Auto 1"
        call(5, "nope")
        assert "Unknown" in read_until(lambda m: m.get("id") == 5)["error"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
