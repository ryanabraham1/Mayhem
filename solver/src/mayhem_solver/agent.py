"""File-backed agent operations shared by the MCP adapter and Python callers.

The desktop RPC remains private to the editor. This interface has an explicit
workspace boundary, optimistic revisions, and separate solve/save/deploy steps.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import uuid
from copy import deepcopy
from pathlib import Path

from pydantic import BaseModel

from . import __version__, rpc
from .models import Project, Trajectory

GUIDE = """Mayhem plans time-optimal FRC swerve trajectories. Work on saved files only;
this server does not control the desktop editor's unsaved state or live robot.
Save/close the editor project before agent edits; reopen it afterward.
All coordinates use WPILib's blue origin. Distances are meters, headings radians,
time seconds, mass kg. Author blue paths; MayhemLib flips for red at runtime.
Read mayhem://schema/project and mayhem://schema/trajectory before authoring.
Use list_field_presets to discover obstacles, dimensions, symmetry, and terrain.
Workflow: inspect_project -> create_path (or get_trajectory -> save_trajectory) -> validate_trajectory
-> start_solve -> get_solve until finished -> save_solve -> deploy_trajectories.
New files use expected_revision=null. For existing files pass the revision from a
fresh read; stale revisions fail. Full-document saves replace the supplied document;
keep fields you want preserved. Unknown fields, nonfinite numbers, and supplied
trajectory outputs are rejected. Saves of trajectory inputs clear old output.
Project edits make dependent generated paths stale; inspect outputCurrent.
Waypoints need stable unique IDs and at least two entries for generation. Endpoints
usually have stop=true. Constraints and markers refer to zero-based waypoint indices;
when reordering, update those references. Use poseRef to reference a project pose ID.
Validation performs input/geometry preflight, not proof of dynamic feasibility.
Successful generation includes the solver's collision/feasibility checks.
Solves run in cancellable child processes. get_solve returns diagnostics, progress,
and optionally a page of samples. save_solve refuses results if project/path files
changed since generation. It never deploys automatically. Deploy requires explicit
names and a target inside the workspace and rejects missing/stale/failed output.
Deploy copies .mtraj files only; it never sends code or trajectories to a roboRIO.
Only paths inside the configured workspace are accessible (including symlinks).
"""


def _validate(model: type[BaseModel], raw: dict):
    """Validate using app models, while rejecting fields their legacy loader ignores."""
    json.dumps(raw, allow_nan=False)
    parsed = model.model_validate(raw)

    def check(value, source):
        if isinstance(value, BaseModel) and isinstance(source, dict):
            fields = type(value).model_fields
            keys = {key for name, field in fields.items() for key in (name, field.alias or name)}
            unknown = source.keys() - keys
            if unknown:
                raise ValueError(f"Unknown {type(value).__name__} fields: {sorted(unknown)}")
            for name, field in fields.items():
                if field.alias and field.alias != name and field.alias in source and name in source:
                    raise ValueError(f"Specify only one of {field.alias!r} and {name!r}")
                key = field.alias if field.alias in source else name
                if key in source:
                    check(getattr(value, name), source[key])
        elif isinstance(value, (list, tuple)) and isinstance(source, (list, tuple)):
            for item, original in zip(value, source):
                check(item, original)

    check(parsed, raw)
    # Pydantic can coerce strings such as "NaN" into nonfinite numbers.
    json.dumps(parsed.dump(), allow_nan=False)
    return parsed


def _revision(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _load(model, path: Path):
    content = path.read_bytes()
    return model.model_validate_json(content), hashlib.sha256(content).hexdigest()


def _write(path: Path, data: dict):
    """Readers see either the old or the complete new document."""
    fd, temp = tempfile.mkstemp(prefix=".mayhem-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


class AgentWorkspace:
    MAX_JOBS = 32
    MAX_ACTIVE = 2

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("Workspace must be an existing directory")
        self.backend = rpc.Server(lambda _: None)
        self.lock = threading.RLock()
        self.jobs: dict[str, dict] = {}
        self.closed = False

    def path(self, value: str | Path) -> Path:
        p = Path(value).expanduser()
        p = (p if p.is_absolute() else self.root / p).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError("Path is outside the configured Mayhem workspace")
        return p

    def directory(self, directory: str) -> Path:
        d = self.path(directory)
        self.path(d / rpc.PROJECT_FILE)
        # Collision checking reads stored names. Validate all targets before reading.
        for f in d.glob("*" + rpc.TRAJ_EXT):
            self.path(f)
        return d

    def trajectory_path(self, d: Path, name: str) -> Path:
        return self.path(rpc._trajectory_path(d, name))

    @staticmethod
    def expect(path: Path, expected: str | None):
        if _revision(path) != expected:
            raise ValueError("Revision conflict: read the file again before writing")

    def info(self) -> dict:
        return {"version": __version__, "workspace": str(self.root), "mode": "saved-files",
                "maxActiveSolves": self.MAX_ACTIVE, "instructions": GUIDE}

    def list_directory(self, directory: str = ".") -> dict:
        d = self.path(directory)
        entries = []
        for child in sorted(d.iterdir(), key=lambda p: p.name.casefold()):
            if child.name.startswith("."):
                continue
            try:
                safe = self.path(child)
            except ValueError:
                continue
            if safe.is_dir():
                try:
                    is_project = self.path(safe / rpc.PROJECT_FILE).is_file()
                except ValueError:
                    is_project = False
                entries.append({"name": child.name, "directory": True, "project": is_project})
            elif safe.name == rpc.PROJECT_FILE or safe.suffix == rpc.TRAJ_EXT:
                entries.append({"name": child.name, "directory": False})
        return {"directory": str(d), "entries": entries}

    def create_project(self, directory: str, project: dict | None = None) -> dict:
        with self.lock:
            d = self.directory(directory)
            pf = d / rpc.PROJECT_FILE
            self.expect(pf, None)
            p = _validate(Project, project if project is not None else self.backend.m_defaultProject())
            d.mkdir(parents=True, exist_ok=True)
            _write(pf, p.dump())
            return self.inspect_project(directory)

    def inspect_project(self, directory: str) -> dict:
        with self.lock:
            d = self.directory(directory)
            p, revision = _load(Project, d / rpc.PROJECT_FILE)
            trajectories = []
            for f in sorted(d.glob("*" + rpc.TRAJ_EXT)):
                try:
                    t, traj_revision = _load(Trajectory, f)
                    trajectories.append({"name": t.name, "revision": traj_revision,
                                         "waypointCount": len(t.waypoints), "folder": t.folder,
                                         **self.output_summary(p, t)})
                except (ValueError, TypeError) as exc:
                    trajectories.append({"file": f.name, "error": str(exc)})
            return {"directory": str(d), "project": p.dump(),
                    "revision": revision, "trajectories": trajectories}

    @staticmethod
    def output_summary(project: Project, traj: Trajectory) -> dict:
        from .pipeline import input_hash

        output = traj.output
        return {"outputCurrent": bool(output and output.stats.success and
                                       output.input_hash == input_hash(project, traj)),
                "stats": output.stats.dump() if output else None,
                "sampleCount": len(output.samples) if output else 0}

    def save_project(self, directory: str, project: dict, expected_revision: str) -> dict:
        with self.lock:
            d = self.directory(directory)
            pf = d / rpc.PROJECT_FILE
            if not pf.exists():
                raise FileNotFoundError("Use create_project for a new project")
            self.expect(pf, expected_revision)
            p = _validate(Project, project)
            _write(pf, p.dump())
            return self.inspect_project(directory)

    def read(self, directory: str, name: str):
        d = self.directory(directory)
        p, project_revision = _load(Project, d / rpc.PROJECT_FILE)
        f = self.trajectory_path(d, name)
        t, trajectory_revision = _load(Trajectory, f)
        return d, p, f, t, project_revision, trajectory_revision

    @staticmethod
    def samples(output, offset: int, limit: int) -> dict:
        if offset < 0 or not 0 <= limit <= 500:
            raise ValueError("sample_offset must be >= 0; sample_limit must be between 0 and 500")
        all_samples = output["samples"] if output else []
        end = min(len(all_samples), offset + limit)
        return {"samples": all_samples[offset:end], "sampleCount": len(all_samples),
                "nextSampleOffset": end if limit and end < len(all_samples) else None}

    def get_trajectory(self, directory: str, name: str, sample_offset: int = 0, sample_limit: int = 0) -> dict:
        with self.lock:
            _, p, _, t, _, revision = self.read(directory, name)
            out = t.output.dump() if t.output else None
            return {"trajectory": t.model_dump(by_alias=True, mode="json", exclude={"output"}),
                    "revision": revision, **self.output_summary(p, t),
                    "generated": {k: v for k, v in out.items() if k not in ("samples", "recovery")} if out else None,
                    **self.samples(out, sample_offset, sample_limit)}

    def create_path(self, directory: str, name: str, waypoints: list[dict],
                    constraints: list[dict] | None = None, markers: list[dict] | None = None,
                    settings: dict | None = None) -> dict:
        if len(waypoints) < 2:
            raise ValueError("A path needs at least two waypoints")
        points = []
        for i, waypoint in enumerate(waypoints):
            point = {k: v for k, v in waypoint.items() if v is not None}
            point.setdefault("id", uuid.uuid4().hex)
            point.setdefault("stop", i in (0, len(waypoints) - 1))
            points.append(point)
        trajectory = {"name": name, "waypoints": points,
                      "constraints": constraints or [], "markers": markers or []}
        if settings is not None:
            trajectory["settings"] = settings
        # This is a create-only operation: never replace an existing named path.
        return self.save_trajectory(directory, trajectory, expected_revision=None)

    def save_trajectory(self, directory: str, trajectory: dict, expected_revision: str | None = None) -> dict:
        with self.lock:
            if trajectory.get("output") is not None:
                raise ValueError("Agent-authored output is not accepted; use start_solve then save_solve")
            d = self.directory(directory)
            if not (d / rpc.PROJECT_FILE).exists():
                raise FileNotFoundError("Create or open a project first")
            t = _validate(Trajectory, trajectory)
            self.check_references(t)
            f = self.trajectory_path(d, t.name)
            self.expect(f, expected_revision)
            t.output = None
            _write(f, t.dump())
            return self.get_trajectory(directory, t.name)

    @staticmethod
    def check_references(t: Trajectory):
        ids = [w.id for w in t.waypoints]
        if len(ids) != len(set(ids)):
            raise ValueError("Waypoint IDs must be unique")
        n = len(ids)
        for c in t.constraints:
            if c.scope.kind in ("waypoint", "range"):
                refs = [c.scope.from_] + ([c.scope.to] if c.scope.kind == "range" else [])
                if any(i < 0 or i >= n for i in refs):
                    raise ValueError(f"Constraint {c.id} references a missing waypoint")
        for m in t.markers:
            if not 0 <= m.waypoint < n or (m.end_waypoint is not None and not 0 <= m.end_waypoint < n):
                raise ValueError(f"Marker {m.id} references a missing waypoint")

    def validate_trajectory(self, directory: str, name: str) -> dict:
        from .drivetrain import build_drivetrain
        from .pipeline import make_world, validate

        with self.lock:
            _, p, _, t, _, _ = self.read(directory, name)
            self.check_references(t)
            issues = validate(p, t, build_drivetrain(p.robot), make_world(p, t))
            return {"valid": not any(i.severity == "error" for i in issues),
                    "issues": [i.dump() for i in issues],
                    "note": "Input/geometry preflight only; run start_solve to check dynamic feasibility."}

    def start_solve(self, directory: str, name: str) -> dict:
        with self.lock:
            if self.closed:
                raise RuntimeError("Workspace is shutting down")
            active = [j for j in self.jobs.values() if j["status"] == "running"]
            if len(active) >= self.MAX_ACTIVE:
                raise ValueError("Two solves are active; wait or cancel one first")
            if len(self.jobs) >= self.MAX_JOBS:
                oldest = next(k for k, v in self.jobs.items() if v["status"] != "running")
                del self.jobs[oldest]
            d, p, _, t, project_revision, trajectory_revision = self.read(directory, name)
            self.check_references(t)
            job_id = uuid.uuid4().hex
            state = {"jobId": job_id, "name": name, "directory": str(d), "status": "running",
                     "projectRevision": project_revision, "trajectoryRevision": trajectory_revision,
                     "result": None, "progress": None, "job": None}
            self.jobs[job_id] = state

            def notify(method, payload):
                with self.lock:
                    if method == "solveDone":
                        state["result"] = deepcopy(payload)
                        state["status"] = ("cancelled" if payload.get("cancelled") else
                                           "succeeded" if payload.get("success") else "failed")
                    elif method == "solveProgress":
                        state["progress"] = deepcopy(payload)

            try:
                state["job"] = rpc.Job(job_id, name, p.dump(), t.dump(), notify)
            except BaseException:
                del self.jobs[job_id]
                raise
            return {"jobId": job_id, "status": state["status"]}

    def job(self, job_id: str) -> dict:
        if job_id not in self.jobs:
            raise ValueError("Unknown or expired job ID (only the latest 32 jobs are retained)")
        return self.jobs[job_id]

    def get_solve(self, job_id: str, sample_offset: int = 0, sample_limit: int = 0) -> dict:
        with self.lock:
            state = self.job(job_id)
            result = state["result"] or {}
            out = result.get("output")
            progress = state["progress"]
            # Candidate route arrays and preview geometry can overwhelm an agent context.
            if progress:
                progress = {k: v for k, v in progress.items() if k != "routes"}
            return {"jobId": job_id, "name": state["name"], "status": state["status"],
                    "progress": progress, "issues": result.get("issues", []),
                    "stats": out.get("stats") if out else None,
                    **self.samples(out, sample_offset, sample_limit)}

    def cancel_solve(self, job_id: str) -> dict:
        with self.lock:
            state = self.job(job_id)
            if state["status"] == "running":
                state["job"].cancel()
            return {"jobId": job_id, "status": state["status"],
                    "cancelRequested": state["status"] == "running"}

    def save_solve(self, job_id: str) -> dict:
        with self.lock:
            state = self.job(job_id)
            if state["status"] != "succeeded":
                raise ValueError("Only a successful solve can be saved")
            d, p, f, t, _, _ = self.read(state["directory"], state["name"])
            self.expect(d / rpc.PROJECT_FILE, state["projectRevision"])
            self.expect(f, state["trajectoryRevision"])
            from .models import TrajectoryOutput
            from .pipeline import input_hash

            t.output = TrajectoryOutput.model_validate(state["result"]["output"])
            if not t.output.stats.success or t.output.input_hash != input_hash(p, t):
                raise ValueError("Solver output does not match the current inputs")
            _write(f, t.dump())
            return self.get_trajectory(str(d), t.name)

    def deploy_trajectories(self, directory: str, names: list[str], target_directory: str) -> dict:
        with self.lock:
            if not names or len(names) != len(set(names)):
                raise ValueError("Provide a nonempty list of unique trajectory names")
            target = self.directory(target_directory)
            pending = []
            filenames = set()
            for name in names:
                _, p, _, t, _, _ = self.read(directory, name)
                if not self.output_summary(p, t)["outputCurrent"]:
                    raise ValueError(f"Trajectory {name!r} has missing, stale, or failed output; generate and save it first")
                f = self.trajectory_path(target, name)
                if f.name.casefold() in filenames:
                    raise FileExistsError("Trajectory names collide in the deploy folder")
                filenames.add(f.name.casefold())
                pending.append((f, t.dump()))
            target.mkdir(parents=True, exist_ok=True)
            for f, data in pending:
                _write(f, data)
            return {"directory": str(target), "written": [str(f) for f, _ in pending],
                    "note": "Local files only; deploy the robot project with WPILib separately."}

    def close(self):
        with self.lock:
            self.closed = True
            jobs = [s["job"] for s in self.jobs.values() if s["job"] is not None]
        for job in jobs:
            job.cancel()
        # Never hold the state lock while waiting for completion callbacks.
        for job in jobs:
            job.wait(5)
