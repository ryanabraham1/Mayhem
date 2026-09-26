"""Command line interface: `mayhem-solver serve|solve|schema|fields`."""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    mp.freeze_support()
    ap = argparse.ArgumentParser(prog="mayhem-solver")
    sub = ap.add_subparsers(dest="cmd")

    sv = sub.add_parser("serve", help="Run the app backend (stdio by default)")
    sv.add_argument("--ws", type=int, help="Serve over WebSocket on this port instead of stdio")

    so = sub.add_parser("solve", help="Solve trajectories in a project directory")
    so.add_argument("project_dir")
    so.add_argument("names", nargs="*", help="Trajectory names (default: all)")
    so.add_argument("--sequential", action="store_true", help="Do not solve candidates in parallel")
    so.add_argument("--check", action="store_true", help="Exit non-zero if any trajectory fails")

    sc = sub.add_parser("schema", help="Export JSON Schema")
    sc.add_argument("out_dir")

    sub.add_parser("fields", help="List bundled field presets")
    sub.add_parser("version")

    args = ap.parse_args(argv)
    if args.cmd in (None, "serve"):
        from .rpc import serve_stdio, serve_ws

        if args.cmd == "serve" and args.ws:
            serve_ws(args.ws)
        else:
            serve_stdio()
        return 0
    if args.cmd == "version":
        from . import __version__

        print(__version__)
        return 0
    if args.cmd == "schema":
        from .schema import export

        print(export(args.out_dir))
        return 0
    if args.cmd == "fields":
        from .rpc import list_fields

        for f in list_fields():
            print(f"{f['id']:<18} {f['name']}  ({len(f['obstacles'])} obstacles)")
        return 0
    if args.cmd == "solve":
        from .models import Project, Trajectory
        from .pipeline import solve
        from .rpc import PROJECT_FILE, TRAJ_EXT

        d = Path(args.project_dir)
        project = Project.model_validate_json((d / PROJECT_FILE).read_text())
        files = sorted(d.glob("*" + TRAJ_EXT))
        failed = 0
        for f in files:
            traj = Trajectory.model_validate_json(f.read_text())
            if args.names and traj.name not in args.names:
                continue
            t0 = time.monotonic()
            res = solve(project, traj, parallel=not args.sequential)
            dt = time.monotonic() - t0
            if res.success:
                traj.output = res.output
                f.write_text(json.dumps(traj.model_dump(by_alias=True, mode="json"), indent=1))
                print(f"OK    {traj.name:<24} {res.output.stats.total_time:6.2f}s path  ({dt:.1f}s solve)")
            else:
                failed += 1
                print(f"FAIL  {traj.name:<24} ({dt:.1f}s)")
            for issue in res.issues:
                print(f"      [{issue.severity}] {issue.message}")
        return 1 if (failed and args.check) else 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
