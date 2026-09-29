import json
import subprocess
import sys
import time
import threading

from mayhem_solver.models import Constraint, PointAt, Project, Scope, Trajectory

from .conftest import wp


def test_job_forwards_infeasible_progress():
    from mayhem_solver.rpc import Job

    traj = Trajectory(name="warning", waypoints=[wp(0, 7, 2, heading_mode="free", stop=True),
                                                  wp(1, 10, 2, heading_mode="free", stop=True)])
    scope = Scope(kind="range", **{"from": 0, "to": 1})
    traj.constraints = [Constraint(id="up", scope=scope, data=PointAt(x=8.5, y=7, tolerance=0.05)),
                        Constraint(id="down", scope=scope, data=PointAt(x=8.5, y=-3, tolerance=0.05))]
    got = []
    done = threading.Event()

    def notify(method, params):
        got.append((method, params))
        if method == "solveDone":
            done.set()

    job = Job("test-job", traj.name, Project().dump(), traj.dump(), notify)
    try:
        assert done.wait(20)
        warnings = [p for m, p in got if m == "solveProgress" and p.get("type") == "infeasible"]
        assert warnings and warnings[0]["issues"]
        assert warnings[0]["jobId"] == "test-job"
        json.dumps(warnings[0], allow_nan=False)
    finally:
        job.cancel()
        job.wait(5)


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


def test_folders_roundtrip_and_do_not_affect_input_hash(tmp_path):
    from mayhem_solver.models import Project
    from mayhem_solver.pipeline import input_hash
    from mayhem_solver.rpc import Server

    server = Server(lambda msg: None)
    opened = server.m_createProject(str(tmp_path / "proj"))
    project = {**opened["project"], "folders": ["Left side", "Empty"]}
    server.m_saveProject(opened["dir"], project)
    t = Trajectory(name="Auto 1", waypoints=[wp(0, 2, 2), wp(1, 6, 6)])
    server.m_saveTrajectory(opened["dir"], {**t.model_dump(by_alias=True, mode="json"), "folder": "Left side"})
    reopened = server.m_openProject(opened["dir"])
    assert reopened["project"]["folders"] == ["Left side", "Empty"]
    assert reopened["trajectories"][0]["folder"] == "Left side"

    p = Project.model_validate(project)
    moved = t.model_copy(update={"folder": "Elsewhere"})
    assert input_hash(p, t) == input_hash(p, moved)


def test_fuel_collision_roundtrips_and_does_not_affect_input_hash():
    from importlib.resources import files

    from mayhem_solver.models import Field_, Project
    from mayhem_solver.pipeline import input_hash

    raw = json.loads(files("mayhem_solver").joinpath("fields/rebuilt-2026.json").read_text())
    field = Field_.model_validate(raw)
    assert {o.name: o.fuel_collision for o in field.obstacles}["Blue Bump (left)"] == "block"
    assert field.dump()["obstacles"][0]["fuelCollision"] in ("paths", "block", "pass")
    t = Trajectory(name="Auto 1", waypoints=[wp(0, 2, 2), wp(1, 6, 6)])
    h = input_hash(Project(field=field), t)

    # files from before the setting existed keep their hashes
    legacy = {**raw, "obstacles": [{k: v for k, v in o.items() if k != "fuelCollision"} for o in raw["obstacles"]]}
    assert input_hash(Project(field=Field_.model_validate(legacy)), t) == h
    # changing it never marks a path stale...
    flipped = field.model_copy(deep=True)
    for o in flipped.obstacles:
        o.fuel_collision = "pass" if o.fuel_collision == "block" else "block"
    assert input_hash(Project(field=flipped), t) == h
    # ...but enabling an obstacle still does
    toggled = field.model_copy(deep=True)
    toggled.obstacles[1].enabled = not toggled.obstacles[1].enabled
    assert input_hash(Project(field=toggled), t) != h


def test_subprocess_job_mode_solves_and_cancels(tmp_path):
    """The Windows job mode (child `solve-job` process, no multiprocessing), forced on any OS."""
    import os

    env = {**os.environ, "MAYHEM_JOB_MODE": "subprocess"}
    proc = subprocess.Popen([sys.executable, "-m", "mayhem_solver", "serve"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, bufsize=1, env=env)
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
        call(1, "defaultProject")
        project = read_until(lambda m: m.get("id") == 1)["result"]
        t = Trajectory(name="Sub", waypoints=[wp(0, 2, 2, stop=True), wp(1, 3, 6, stop=True)])
        tj = t.model_dump(by_alias=True, mode="json", exclude={"output"})
        call(2, "solve", project=project, trajectory=tj)
        job = read_until(lambda m: m.get("id") == 2)["result"]["jobId"]
        done = read_until(lambda m: m.get("method") == "solveDone" and m["params"]["jobId"] == job)
        assert done["params"]["success"], done["params"]["issues"]
        assert done["params"]["output"]["samples"]

        # cancel a long solve: must report cancelled promptly
        long = Trajectory(name="Long", waypoints=[wp(i, 1.0 + 1.4 * i, 2.0 if i % 2 else 6.0, 0.3 * i, stop=(i in (0, 9)))
                                                   for i in range(10)])
        open_field = {**project, "field": {**project["field"], "obstacles": []}}
        call(3, "solve", project=open_field, trajectory=long.model_dump(by_alias=True, mode="json", exclude={"output"}))
        job2 = read_until(lambda m: m.get("id") == 3)["result"]["jobId"]
        time.sleep(0.5)
        call(4, "cancel", jobId=job2)
        done2 = read_until(lambda m: m.get("method") == "solveDone" and m["params"]["jobId"] == job2, timeout=30)
        assert done2["params"].get("cancelled") or done2["params"]["success"], done2["params"]["issues"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)


def test_shutdown_exits_and_non_ascii_names_roundtrip(tmp_path):
    """The app stops the solver with `shutdown` (so onefile builds clean up), and stdio is UTF-8
    regardless of the platform's default encoding."""
    proc = subprocess.Popen([sys.executable, "-m", "mayhem_solver", "serve"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, encoding="utf-8", bufsize=1)
    try:
        def call(i, method, **params):
            proc.stdin.write(json.dumps({"id": i, "method": method, "params": params}, ensure_ascii=False) + "\n")
            proc.stdin.flush()

        def read_until(pred, timeout=60):
            end = time.time() + timeout
            while time.time() < end:
                msg = json.loads(proc.stdout.readline())
                if pred(msg):
                    return msg
            raise TimeoutError

        read_until(lambda m: m.get("method") == "ready")
        call(1, "createProject", dir=str(tmp_path / "proj"))
        opened = read_until(lambda m: m.get("id") == 1)["result"]
        t = Trajectory(name="Départ ▸ Trench", waypoints=[wp(0, 2, 2), wp(1, 6, 6)])
        call(2, "saveTrajectory", dir=opened["dir"], trajectory=t.model_dump(by_alias=True, mode="json"))
        saved = read_until(lambda m: m.get("id") == 2)["result"]
        assert saved.endswith("Départ ▸ Trench.mtraj")
        call(3, "openProject", dir=opened["dir"])
        assert read_until(lambda m: m.get("id") == 3)["result"]["trajectories"][0]["name"] == "Départ ▸ Trench"
        call(4, "shutdown")
        assert read_until(lambda m: m.get("id") == 4)["result"] is True
        assert proc.wait(timeout=10) == 0  # exits without stdin being closed
    finally:
        if proc.poll() is None:
            proc.kill()
