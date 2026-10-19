"""Agent boundary and stale-edit protections, independent of the optional MCP SDK."""
import json
from copy import deepcopy

import pytest

from mayhem_solver.agent import AgentWorkspace
from mayhem_solver.models import Project, Trajectory
from .conftest import wp


@pytest.fixture
def workspace(tmp_path):
    agent = AgentWorkspace(tmp_path)
    agent.create_project("project", Project().dump())
    yield agent
    agent.close()


def path_input(name="Auto"):
    return Trajectory(name=name, waypoints=[wp(0, 2, 2, stop=True), wp(1, 4, 2, stop=True)]).dump()


def test_revisions_and_input_only_saves(workspace):
    saved = workspace.save_trajectory("project", path_input())
    original = (workspace.root / "project/Auto.mtraj").read_bytes()
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.save_trajectory("project", path_input())
    edited = deepcopy(saved["trajectory"])
    edited["waypoints"][1]["x"] = 5
    changed = workspace.save_trajectory("project", edited, saved["revision"])
    assert changed["revision"] != saved["revision"]
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.save_trajectory("project", path_input(), saved["revision"])
    assert (workspace.root / "project/Auto.mtraj").read_bytes() != original
    assert changed["outputCurrent"] is False
    edited["output"] = {"inputHash": "forged"}
    with pytest.raises(ValueError, match="output"):
        workspace.save_trajectory("project", edited, changed["revision"])


def test_project_revisions(workspace):
    opened = workspace.inspect_project("project")
    p = opened["project"]
    p["name"] = "Changed"
    changed = workspace.save_project("project", p, opened["revision"])
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.save_project("project", p, opened["revision"])
    assert changed["project"]["name"] == "Changed"
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.create_project("project")


@pytest.mark.parametrize("edit", [
    lambda t: t.update(wayponts=[]),
    lambda t: t["waypoints"][0].update(haeding=2),
    lambda t: t["waypoints"][0].update(x=float("nan")),
    lambda t: t["waypoints"][0].update(x="NaN"),
    lambda t: t["waypoints"][0].update(id="1"),
    lambda t: t.update(markers=[{"id": "m", "name": "Intake", "waypoint": 20}]),
    lambda t: t.update(constraints=[{"id": "c", "scope": {"from": 0, "to": 9},
                                         "data": {"type": "maxVelocity", "value": 2}}]),
])
def test_bad_authoring_is_rejected_without_writes(workspace, edit):
    t = path_input()
    edit(t)
    with pytest.raises(ValueError):
        workspace.save_trajectory("project", t)
    assert not (workspace.root / "project/Auto.mtraj").exists()


def test_paths_and_symlinks_cannot_escape(workspace, tmp_path):
    with pytest.raises(ValueError, match="outside"):
        workspace.create_project("../outside")
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    try:
        (workspace.root / "escape").symlink_to(outside, target_is_directory=True)
        with pytest.raises(ValueError, match="outside"):
            workspace.create_project("escape/proj")
        secret = outside / "secret.mtraj"
        secret.write_text(json.dumps(path_input()))
        (workspace.root / "project/Auto.mtraj").symlink_to(secret)
        with pytest.raises(ValueError, match="outside"):
            workspace.inspect_project("project")
        with pytest.raises(ValueError, match="outside"):
            workspace.save_trajectory("project", path_input())
        assert json.loads(secret.read_text())["name"] == "Auto"
    finally:
        import shutil
        shutil.rmtree(outside)


def test_filename_collisions_and_stale_deploy(workspace):
    workspace.save_trajectory("project", path_input("A/B"))
    with pytest.raises(FileExistsError):
        workspace.save_trajectory("project", path_input("A_B"))
    with pytest.raises(ValueError, match="stale"):
        workspace.deploy_trajectories("project", ["A/B"], "deploy")
    assert not (workspace.root / "deploy").exists()
    with pytest.raises(ValueError, match="nonempty"):
        workspace.deploy_trajectories("project", [], "deploy")


def test_preflight_reports_errors(workspace):
    t = path_input()
    t["waypoints"][0]["x"] = -1
    workspace.save_trajectory("project", t)
    result = workspace.validate_trajectory("project", "Auto")
    assert not result["valid"]
    assert any(i["waypoint"] == 0 for i in result["issues"])


class FakeJob:
    instances = []

    def __init__(self, job_id, name, project, trajectory, notify):
        self.id, self.notify = job_id, notify
        self.cancelled = self.waited = False
        self.instances.append(self)

    def finish(self, output=None, success=False):
        self.notify("solveDone", {"jobId": self.id, "success": success, "output": output,
                                   "issues": []})

    def cancel(self):
        self.cancelled = True

    def wait(self, timeout):
        self.waited = True


def test_job_limits_failures_and_shutdown(workspace, monkeypatch):
    monkeypatch.setattr("mayhem_solver.rpc.Job", FakeJob)
    workspace.save_trajectory("project", path_input())
    first = workspace.start_solve("project", "Auto")["jobId"]
    second = workspace.start_solve("project", "Auto")["jobId"]
    with pytest.raises(ValueError, match="Two solves"):
        workspace.start_solve("project", "Auto")
    assert workspace.cancel_solve(first)["cancelRequested"]
    FakeJob.instances[-2].finish()
    assert workspace.get_solve(first)["status"] == "failed"
    with pytest.raises(ValueError, match="successful"):
        workspace.save_solve(first)
    workspace.close()
    assert FakeJob.instances[-1].cancelled and FakeJob.instances[-1].waited
    with pytest.raises(RuntimeError, match="shutting down"):
        workspace.start_solve("project", "Auto")
    with pytest.raises(ValueError, match="Unknown"):
        workspace.get_solve("missing")
    assert workspace.get_solve(second)["status"] == "running"


def test_stale_job_cannot_save_and_fast_completion_is_retained(workspace, monkeypatch):
    class FastJob(FakeJob):
        def __init__(self, *args):
            super().__init__(*args)
            self.finish(output={}, success=True)

    monkeypatch.setattr("mayhem_solver.rpc.Job", FastJob)
    saved = workspace.save_trajectory("project", path_input())
    job = workspace.start_solve("project", "Auto")["jobId"]
    assert workspace.get_solve(job)["status"] == "succeeded"
    t = saved["trajectory"]
    t["waypoints"][1]["y"] = 3
    workspace.save_trajectory("project", t, saved["revision"])
    before = (workspace.root / "project/Auto.mtraj").read_bytes()
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.save_solve(job)
    assert (workspace.root / "project/Auto.mtraj").read_bytes() == before
    job = workspace.start_solve("project", "Auto")["jobId"]
    p = workspace.inspect_project("project")
    p["project"]["robot"]["mass"] = 70
    workspace.save_project("project", p["project"], p["revision"])
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.save_solve(job)


def test_pagination():
    output = {"samples": list(range(7))}
    assert AgentWorkspace.samples(output, 2, 3) == {
        "samples": [2, 3, 4], "sampleCount": 7, "nextSampleOffset": 5}
    with pytest.raises(ValueError):
        AgentWorkspace.samples(output, 0, 501)
    assert AgentWorkspace.samples(output, 0, 0)["samples"] == []


def test_create_path_defaults_and_explicit_choices(workspace):
    saved = workspace.create_path("project", "Cycle", [
        {"x": 2, "y": 2}, {"x": 3, "y": 3, "heading": 1.2}, {"x": 4, "y": 2, "stop": False}],
        markers=[{"id": "intake", "name": "Intake", "waypoint": 1}])
    points = saved["trajectory"]["waypoints"]
    assert [p["stop"] for p in points] == [True, False, False]
    assert len({p["id"] for p in points}) == 3
    assert points[1]["heading"] == 1.2
    assert saved["trajectory"]["markers"][0]["waypoint"] == 1
    with pytest.raises(ValueError, match="Revision conflict"):
        workspace.create_path("project", "Cycle", [{"x": 2, "y": 2}, {"x": 3, "y": 3}])
    with pytest.raises(ValueError, match="two waypoints"):
        workspace.create_path("project", "Too short", [{"x": 2, "y": 2}])


def test_directory_discovery(workspace):
    assert workspace.list_directory()["entries"] == [{"name": "project", "directory": True, "project": True}]
    assert workspace.list_directory("project")["entries"] == [{"name": "project.mayhem", "directory": False}]
