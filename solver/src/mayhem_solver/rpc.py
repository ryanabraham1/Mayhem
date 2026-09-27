"""JSON-RPC-ish server used by the desktop app.

Wire format: one JSON object per line (stdio) or per message (WebSocket).
  request:       {"id": 1, "method": "solve", "params": {...}}
  response:      {"id": 1, "result": ...}   or   {"id": 1, "error": "message"}
  notification:  {"method": "solveProgress", "params": {...}}

Solves run in a separate process per job so they can be cancelled by killing it.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import signal
import sys
import threading
import traceback
import uuid
from importlib import resources
from pathlib import Path
from typing import Callable

from . import __version__
from .models import Field_, Project, Trajectory

PROJECT_FILE = "project.mayhem"
TRAJ_EXT = ".mtraj"


# ---------------------------------------------------------------------------
# solve job process
# ---------------------------------------------------------------------------


def _run_solve(project_json: dict, traj_json: dict, emit: Callable[[str, dict], None], parallel: bool = True) -> None:
    """Run one solve, reporting ("progress", msg) events and a final ("done", result)."""
    from .pipeline import solve

    project = Project.model_validate(project_json)
    traj = Trajectory.model_validate(traj_json)
    try:
        res = solve(project, traj, progress=lambda m: emit("progress", m), parallel=parallel)
        emit("done", {
            "success": res.success,
            "output": res.output.dump() if res.output else None,
            "issues": [i.dump() for i in res.issues],
            "preview": res.preview,
        })
    except Exception as e:
        emit("done", {"success": False, "output": None,
                      "issues": [{"severity": "error", "message": f"Solver crashed: {e!r}"}],
                      "preview": None, "trace": traceback.format_exc()})


def _job_entry(project_json: dict, traj_json: dict, q) -> None:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    _run_solve(project_json, traj_json, lambda kind, payload: q.put((kind, payload)))


def solve_job_stdio() -> None:
    """`mayhem-solver solve-job`: one solve driven over stdin/stdout.

    Used instead of multiprocessing where spawning workers from a frozen binary is unreliable
    (Windows). Reads one JSON line {"project", "trajectory"}; writes JSON lines
    {"kind": "progress"|"done", "payload": ...}. Candidates are solved sequentially.
    """
    out = sys.stdout
    sys.stdout = sys.stderr
    lock = threading.Lock()
    req = json.loads(sys.stdin.readline())

    def emit(kind: str, payload: dict):
        with lock:
            out.write(json.dumps({"kind": kind, "payload": payload}, separators=(",", ":")) + "\n")
            out.flush()

    _run_solve(req["project"], req["trajectory"], emit, parallel=False)


def _use_subprocess_jobs() -> bool:
    mode = os.environ.get("MAYHEM_JOB_MODE", "")
    return mode == "subprocess" or (mode != "multiprocessing" and sys.platform == "win32")


class SubprocessJob:
    """A solve in a child `mayhem-solver solve-job` process (no multiprocessing)."""

    def __init__(self, job_id: str, name: str, project: dict, traj: dict, notify: Callable[[str, dict], None]):
        import subprocess

        self.id, self.name, self.notify = job_id, name, notify
        self.cancelled = False
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "solve-job"]
        else:
            cmd = [sys.executable, "-m", "mayhem_solver", "solve-job"]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", creationflags=flags)
        self.proc.stdin.write(json.dumps({"project": project, "trajectory": traj}) + "\n")
        self.proc.stdin.flush()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        done = False
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("kind") == "progress":
                self.notify("solveProgress", {"jobId": self.id, "name": self.name, **msg["payload"]})
            elif msg.get("kind") == "done":
                self.notify("solveDone", {"jobId": self.id, "name": self.name, **msg["payload"]})
                done = True
                break
        self.proc.wait()
        if not done:
            if self.cancelled:
                self.notify("solveDone", {"jobId": self.id, "name": self.name, "success": False, "cancelled": True,
                                          "output": None, "preview": None,
                                          "issues": [{"severity": "info", "message": "Cancelled."}]})
            else:
                self.notify("solveDone", {"jobId": self.id, "name": self.name, "success": False,
                                          "output": None, "preview": None,
                                          "issues": [{"severity": "error", "message": "Solver process exited unexpectedly."}]})

    def cancel(self):
        self.cancelled = True
        if self.proc.poll() is None:
            self.proc.kill()


class Job:
    def __new__(cls, *args, **kwargs):
        if _use_subprocess_jobs():
            return SubprocessJob(*args, **kwargs)
        return super().__new__(cls)

    def __init__(self, job_id: str, name: str, project: dict, traj: dict, notify: Callable[[str, dict], None]):
        ctx = mp.get_context("spawn")
        self.id, self.name = job_id, name
        self.q = ctx.Queue()
        self.proc = ctx.Process(target=_job_entry, args=(project, traj, self.q))
        self.notify = notify
        self.cancelled = False
        self.proc.start()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        import queue as queue_mod

        while True:
            try:
                kind, payload = self.q.get(timeout=0.25)
            except queue_mod.Empty:
                if not self.proc.is_alive():
                    if not self.cancelled:
                        self.notify("solveDone", {"jobId": self.id, "name": self.name, "success": False,
                                                  "output": None, "preview": None,
                                                  "issues": [{"severity": "error",
                                                              "message": "Solver process exited unexpectedly."}]})
                    else:
                        self.notify("solveDone", {"jobId": self.id, "name": self.name, "success": False,
                                                  "cancelled": True, "output": None, "preview": None,
                                                  "issues": [{"severity": "info", "message": "Cancelled."}]})
                    return
                continue
            if kind == "progress":
                self.notify("solveProgress", {"jobId": self.id, "name": self.name, **payload})
            else:
                self.notify("solveDone", {"jobId": self.id, "name": self.name, **payload})
                self.proc.join(timeout=5)
                return

    def cancel(self):
        self.cancelled = True
        if self.proc.is_alive():
            self.proc.terminate()


# ---------------------------------------------------------------------------
# method handlers
# ---------------------------------------------------------------------------


def list_fields() -> list[dict]:
    out = []
    for f in sorted(resources.files("mayhem_solver").joinpath("fields").iterdir(), key=lambda p: p.name):
        if f.name.endswith(".json"):
            out.append(Field_.model_validate_json(f.read_text()).dump())
    return out


def _safe_name(name: str) -> str:
    bad = '<>:"/\\|?*'
    clean = "".join("_" if ch in bad else ch for ch in name).strip().strip(".")
    if not clean:
        raise ValueError("Invalid trajectory name")
    return clean


class Server:
    def __init__(self, send: Callable[[dict], None]):
        self._send = send
        self.jobs: dict[str, Job] = {}

    def notify(self, method: str, params: dict):
        self._send({"method": method, "params": params})

    def handle(self, msg: dict):
        mid = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params") or {}
        try:
            fn = getattr(self, "m_" + method, None)
            if fn is None:
                raise ValueError(f"Unknown method {method!r}")
            result = fn(**params)
            if mid is not None:
                self._send({"id": mid, "result": result})
        except Exception as e:
            if mid is not None:
                self._send({"id": mid, "error": str(e) or repr(e)})

    # --- misc ---
    def m_ping(self):
        return {"version": __version__, "pid": os.getpid()}

    def m_listFields(self):
        return list_fields()

    def m_defaultProject(self):
        fields = list_fields()
        p = Project()
        pick = next((f for f in fields if f["id"] == "rebuilt-2026"), None)
        if pick:
            p.field = Field_.model_validate(pick)
        return p.dump()

    def m_homeDir(self):
        return str(Path.home())

    def m_listDir(self, path: str):
        p = Path(path).expanduser()
        entries = []
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.name.startswith("."):
                continue
            entries.append({"name": child.name, "path": str(child), "dir": child.is_dir()})
        return {"path": str(p.resolve()), "parent": str(p.resolve().parent), "entries": entries}

    # --- project files ---
    def m_openProject(self, dir: str):
        d = Path(dir).expanduser()
        pf = d / PROJECT_FILE
        if not pf.exists():
            raise FileNotFoundError(f"No {PROJECT_FILE} in {d}")
        project = Project.model_validate_json(pf.read_text())
        trajs = []
        for f in sorted(d.glob("*" + TRAJ_EXT)):
            try:
                trajs.append(Trajectory.model_validate_json(f.read_text()).model_dump(by_alias=True, mode="json"))
            except Exception as e:
                trajs.append({"name": f.stem, "error": str(e)})
        return {"dir": str(d.resolve()), "project": project.dump(), "trajectories": trajs}

    def m_createProject(self, dir: str, project: dict | None = None):
        d = Path(dir).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        pf = d / PROJECT_FILE
        if pf.exists():
            raise FileExistsError(f"{pf} already exists")
        proj = Project.model_validate(project) if project else Project.model_validate(self.m_defaultProject())
        pf.write_text(json.dumps(proj.dump(), indent=2))
        return self.m_openProject(str(d))

    def m_saveProject(self, dir: str, project: dict):
        proj = Project.model_validate(project)
        (Path(dir).expanduser() / PROJECT_FILE).write_text(json.dumps(proj.dump(), indent=2))
        return True

    def m_saveTrajectory(self, dir: str, trajectory: dict):
        traj = Trajectory.model_validate(trajectory)
        path = Path(dir).expanduser() / (_safe_name(traj.name) + TRAJ_EXT)
        path.write_text(json.dumps(traj.model_dump(by_alias=True, mode="json"), indent=1))
        return str(path)

    def m_deleteTrajectory(self, dir: str, name: str):
        path = Path(dir).expanduser() / (_safe_name(name) + TRAJ_EXT)
        if path.exists():
            path.unlink()
        return True

    def m_renameTrajectory(self, dir: str, old: str, new: str):
        d = Path(dir).expanduser()
        src = d / (_safe_name(old) + TRAJ_EXT)
        dst = d / (_safe_name(new) + TRAJ_EXT)
        if dst.exists():
            raise FileExistsError(f"A trajectory named {new!r} already exists")
        if src.exists():
            data = json.loads(src.read_text())
            data["name"] = new
            dst.write_text(json.dumps(data, indent=1))
            src.unlink()
        return True

    def m_deploy(self, dir: str, project: dict, trajectories: list[dict]):
        """Copy solved trajectories into the robot project's deploy dir."""
        proj = Project.model_validate(project)
        target = Path(proj.deploy_dir).expanduser() if proj.deploy_dir else Path(dir).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        written, skipped = [], []
        for tj in trajectories:
            traj = Trajectory.model_validate(tj)
            if traj.output is None:
                skipped.append(traj.name)
                continue
            path = target / (_safe_name(traj.name) + TRAJ_EXT)
            path.write_text(json.dumps(traj.model_dump(by_alias=True, mode="json"), separators=(",", ":")))
            written.append(str(path))
        return {"dir": str(target), "written": written, "skipped": skipped}

    def m_inputHash(self, project: dict, trajectory: dict):
        from .pipeline import input_hash

        return input_hash(Project.model_validate(project), Trajectory.model_validate(trajectory))

    def m_drivetrainInfo(self, robot: dict):
        from .drivetrain import build_drivetrain
        from .models import RobotConfig

        d = build_drivetrain(RobotConfig.model_validate(robot))
        return {
            "maxSpeed": d.max_speed,
            "maxAcceleration": d.max_linear_accel,
            "maxAngularVelocity": d.max_angular_velocity,
            "maxAngularAcceleration": d.max_angular_accel,
            "wheelStallForce": d.wheel_stall_force,
            "wheelCurrentForce": d.wheel_current_force,
            "frictionForce": d.friction_force,
            "limitingForce": min(("friction", d.friction_force), ("current limit", d.wheel_current_force),
                                 ("motor stall", d.wheel_stall_force), key=lambda kv: kv[1])[0],
        }

    # --- solving ---
    def m_solve(self, project: dict, trajectory: dict):
        job_id = uuid.uuid4().hex[:8]
        name = trajectory.get("name", "?")
        self.jobs[job_id] = Job(job_id, name, project, trajectory, self.notify)
        return {"jobId": job_id}

    def m_cancel(self, jobId: str):
        job = self.jobs.get(jobId)
        if job:
            job.cancel()
        return True

    def shutdown(self):
        for job in self.jobs.values():
            job.cancel()


# ---------------------------------------------------------------------------
# transports
# ---------------------------------------------------------------------------


def serve_stdio():
    lock = threading.Lock()
    out = sys.stdout
    # keep stray prints (e.g. from native libs) off the protocol channel
    sys.stdout = sys.stderr

    def send(msg: dict):
        line = json.dumps(msg, separators=(",", ":"))
        with lock:
            out.write(line + "\n")
            out.flush()

    server = Server(send)
    send({"method": "ready", "params": server.m_ping()})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            threading.Thread(target=server.handle, args=(msg,), daemon=True).start()
    finally:
        server.shutdown()


def serve_ws(port: int, host: str = "127.0.0.1"):
    import asyncio

    import websockets

    async def handler(ws):
        loop = asyncio.get_running_loop()
        outq: asyncio.Queue = asyncio.Queue()

        def send(msg: dict):
            loop.call_soon_threadsafe(outq.put_nowait, json.dumps(msg, separators=(",", ":")))

        server = Server(send)
        send({"method": "ready", "params": server.m_ping()})

        async def writer():
            while True:
                await ws.send(await outq.get())

        wtask = asyncio.create_task(writer())
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                loop.run_in_executor(None, server.handle, msg)
        finally:
            wtask.cancel()
            server.shutdown()

    import re
    from http import HTTPStatus

    local_origin = re.compile(r"^(https?|tauri)://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?$")

    def check_origin(connection, request):
        # The server can read/write files, so only accept pages served locally.
        origin = request.headers.get("Origin")
        if origin is not None and not local_origin.match(origin):
            return connection.respond(HTTPStatus.FORBIDDEN, "Forbidden origin\n")
        return None

    async def main():
        async with websockets.serve(handler, host, port, max_size=64 * 2 ** 20, process_request=check_origin):
            print(f"mayhem solver listening on ws://{host}:{port}", file=sys.stderr, flush=True)
            await asyncio.Future()

    asyncio.run(main())
