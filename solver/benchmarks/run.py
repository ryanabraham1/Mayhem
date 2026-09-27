"""Run the Mayhem solver benchmark.

    cd solver
    uv run python -m benchmarks.run                    # full suite, writes results + RESULTS.md
    uv run python -m benchmarks.run --fast             # CI subset
    uv run python -m benchmarks.run --only trench      # name substring filter
    uv run python -m benchmarks.run --jobs 4           # throughput mode (candidates run sequentially)
    uv run python -m benchmarks.run --compare baseline,previous   # keep several earlier runs in RESULTS.md

Default mode solves one scenario at a time with ``parallel=True`` (exactly what the app
does), so the wall times are what a user sees. ``--jobs N`` runs N scenarios at once with
``parallel=False``; use it for quick success-rate checks, not for timing.

A scenario counts as a success only if the solver reports success AND the exported
samples pass the independent checks in benchmarks/validate.py (physics, dynamics,
swept collision, waypoints, user constraints).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"


def _run_one(scen_json: dict, parallel: bool) -> dict:
    from mayhem_solver.models import Project, Trajectory
    from mayhem_solver.pipeline import solve

    from .validate import check_output

    project = Project.model_validate(scen_json["project"])
    traj = Trajectory.model_validate(scen_json["traj"])
    t0 = time.monotonic()
    try:
        res = solve(project, traj, parallel=parallel)
        err = None
    except Exception as e:  # a crash is a failure, not a benchmark abort
        res, err = None, repr(e)
    wall = time.monotonic() - t0
    row = {
        "name": scen_json["name"], "group": scen_json["group"], "tags": scen_json["tags"],
        "waypoints": len(traj.waypoints), "wall": round(wall, 3), "solver_success": bool(res and res.success),
        "valid": False, "violations": [], "path_time": None, "iterations": None, "candidate": None,
        "attempts": [], "issues": [], "metrics": {},
    }
    if err:
        row["issues"] = [f"crash: {err}"]
        return row
    row["issues"] = [f"[{i.severity}] {i.message}" for i in res.issues]
    if scen_json["group"] == "infeasible":
        # success = fails, and the report names the right constraint (and waypoint)
        text = " ".join(i.message for i in res.issues).lower()
        kw_ok = any(k.lower() in text for k in scen_json.get("expect_keywords") or [""])
        ew = scen_json.get("expect_waypoint")
        wp_ok = ew is None or any(i.waypoint == ew for i in res.issues)
        row["valid"] = (not res.success) and kw_ok and wp_ok
        if res.success:
            row["violations"] = ["solver reported success on an infeasible problem"]
        elif not row["valid"]:
            row["violations"] = [f"diagnosis mismatch (keywords ok: {kw_ok}, waypoint ok: {wp_ok})"] + row["issues"][:2]
        return row
    if res.success:
        st = res.output.stats
        row.update(path_time=round(st.total_time, 4), iterations=st.iterations, candidate=st.candidate,
                   attempts=st.attempts)
        viol, metrics = check_output(project, traj, res.output)
        row["violations"], row["metrics"] = viol, metrics
        row["valid"] = not viol
    return row


def _pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summarize(rows: list[dict]) -> dict:
    def block(rs):
        ok = [r for r in rs if r["valid"]]
        walls = [r["wall"] for r in rs]
        paths = [r["path_time"] for r in ok if r["path_time"] is not None]
        return {
            "n": len(rs),
            "success": len(ok),
            "success_rate": round(len(ok) / len(rs), 4) if rs else None,
            "solver_success_but_invalid": sum(1 for r in rs if r["solver_success"] and not r["valid"]),
            "wall_median": round(statistics.median(walls), 3) if walls else None,
            "wall_p90": round(_pct(walls, 0.9), 3) if walls else None,
            "wall_max": round(max(walls), 3) if walls else None,
            "wall_total": round(sum(walls), 2),
            "path_time_median": round(statistics.median(paths), 3) if paths else None,
            "path_time_mean": round(statistics.mean(paths), 3) if paths else None,
            "path_time_total": round(sum(paths), 3) if paths else None,
            "iterations_total": sum(r["iterations"] or 0 for r in ok),
        }

    out = {"all": block([r for r in rows if r["group"] != "infeasible"])}
    for g in sorted({r["group"] for r in rows}):
        out[g] = block([r for r in rows if r["group"] == g])
    return out


def _status(r) -> str:
    if r["group"] == "infeasible":
        return "diagnosed" if r["valid"] else "MISDIAGNOSED"
    return "yes" if r["valid"] else ("INVALID" if r["solver_success"] else "FAIL")


def write_markdown(path: Path, runs: dict[str, dict]):
    """runs: label -> result json. Newest (last) label is the 'current' run."""
    labels = list(runs)
    cur = runs[labels[-1]]
    lines = ["# Solver benchmark results", "",
             "Generated by `uv run python -m benchmarks.run` (see benchmarks/run.py). "
             "Field: 2026 REBUILT, default robot (0.9 m square bumper, Kraken X60, 60 kg). "
             "A run is a success only if the output passes the independent physics / swept-collision / "
             "constraint checks in `benchmarks/validate.py`. Wall time is end-to-end `pipeline.solve` "
             "(`parallel=True`) on the machine noted below. The `all` row covers the feasible groups "
             "(`hard` + `random`); the `infeasible` group must fail and name the offending constraint "
             "(and waypoint), and its wall time is the time to report the diagnosis.", ""]
    lines += ["## Summary", "",
              "| run | group | n | success | rate | invalid | wall median [s] | wall p90 [s] | wall max [s] "
              "| wall total [s] | path median [s] | path total [s] |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for lab in labels:
        s = runs[lab]["summary"]
        for g in ("all", "hard", "random", "infeasible"):
            if g not in s:
                continue
            b = s[g]
            lines.append(f"| {lab} | {g} | {b['n']} | {b['success']} | {100 * b['success_rate']:.1f}% | "
                         f"{b['solver_success_but_invalid']} | {b['wall_median']} | {b['wall_p90']} | "
                         f"{b['wall_max']} | {b['wall_total']} | {b['path_time_median']} | {b['path_time_total']} |")
    lines.append("")
    for lab in labels:
        m = runs[lab].get("meta", {})
        lines.append(f"- **{lab}**: {m.get('date', '')}, seed {m.get('seed')}, {m.get('n_random')} random, "
                     f"mode `{m.get('mode')}`, {m.get('machine', '')}")
    lines.append("")

    base = runs[labels[0]] if len(labels) > 1 else None
    base_rows = {r["name"]: r for r in base["rows"]} if base else {}
    lines += ["## Per-scenario (current run)", ""]
    hdr = "| scenario | tags | wps | ok | wall [s] | path [s] | cand |"
    sep = "|---|---|---|---|---|---|---|"
    if base:
        hdr += f" {labels[0]} ok | {labels[0]} wall [s] | {labels[0]} path [s] |"
        sep += "---|---|---|"
    lines += [hdr, sep]
    for r in cur["rows"]:
        ok = _status(r)
        pt = "" if r["path_time"] is None else f"{r['path_time']:.3f}"
        cand = "" if r["candidate"] is None else r["candidate"]
        line = f"| {r['name']} | {', '.join(r['tags'])} | {r['waypoints']} | {ok} | {r['wall']:.2f} | {pt} | {cand} |"
        if base:
            b = base_rows.get(r["name"])
            if b:
                bok = _status(b)
                bp = "" if b["path_time"] is None else f"{b['path_time']:.3f}"
                line += f" {bok} | {b['wall']:.2f} | {bp} |"
            else:
                line += " | | |"
        lines.append(line)
    fails = [r for r in cur["rows"] if not r["valid"]]
    if fails:
        lines += ["", "## Failures (current run)", ""]
        for r in fails:
            lines.append(f"- **{r['name']}**: " + "; ".join((r["violations"] or r["issues"])[:3]))
    path.write_text("\n".join(lines) + "\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="benchmarks.run")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--n-random", type=int, default=60)
    ap.add_argument("--fast", action="store_true", help="only the CI subset")
    ap.add_argument("--only", action="append", default=[], help="name substring filter (repeatable)")
    ap.add_argument("--group", choices=["hard", "random", "infeasible"])
    ap.add_argument("--jobs", type=int, default=1, help=">1: run scenarios concurrently with parallel=False")
    ap.add_argument("--sequential", action="store_true", help="parallel=False even with --jobs 1")
    ap.add_argument("--label", default="current")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--compare", default="baseline",
                    help="comma-separated labels of earlier runs to keep in RESULTS.md (the first is the "
                         "per-scenario reference)")
    args = ap.parse_args(argv)

    from .scenarios import FAST_SUBSET, all_scenarios

    scen = all_scenarios(args.seed, args.n_random)
    if args.fast:
        scen = [s for s in scen if s.name in FAST_SUBSET]
    if args.only:
        scen = [s for s in scen if any(o in s.name for o in args.only)]
    if args.group:
        scen = [s for s in scen if s.group == args.group]
    payloads = [{"name": s.name, "group": s.group, "tags": s.tags, "project": s.project.dump(),
                 "expect_keywords": s.expect_keywords, "expect_waypoint": s.expect_waypoint,
                 "traj": s.traj.model_dump(by_alias=True, mode="json", exclude={"output"})} for s in scen]

    parallel = args.jobs == 1 and not args.sequential
    mode = "app (parallel candidates)" if parallel else f"throughput ({args.jobs} jobs, sequential candidates)"
    print(f"{len(payloads)} scenarios, mode: {mode}", flush=True)
    rows: list[dict] = []
    t0 = time.monotonic()

    def report(r):
        ok = "ok " if r["valid"] else ("BAD" if r["solver_success"] else "FAIL")
        pt = f"{r['path_time']:.2f}s" if r["path_time"] is not None else "-"
        print(f"{ok} {r['name']:<28} wall {r['wall']:7.2f}s path {pt:>7}", flush=True)
        if not r["valid"]:
            for line in (r["violations"] or r["issues"])[:3]:
                print(f"      {line}", flush=True)

    if args.jobs > 1:
        import multiprocessing as mp

        with ProcessPoolExecutor(args.jobs, mp_context=mp.get_context("spawn")) as ex:
            futs = [ex.submit(_run_one, p, False) for p in payloads]
            for f in as_completed(futs):
                r = f.result()
                rows.append(r)
                report(r)
        order = {p["name"]: i for i, p in enumerate(payloads)}
        rows.sort(key=lambda r: order[r["name"]])
    else:
        for p in payloads:
            r = _run_one(p, parallel)
            rows.append(r)
            report(r)

    summary = summarize(rows)
    elapsed = time.monotonic() - t0
    print(json.dumps(summary, indent=1))
    print(f"total elapsed {elapsed:.1f}s")
    if args.no_write:
        return 0
    import platform

    result = {
        "meta": {"label": args.label, "date": time.strftime("%Y-%m-%d %H:%M"), "seed": args.seed,
                 "n_random": args.n_random, "mode": mode, "fast": args.fast, "filters": args.only,
                 "machine": f"{platform.machine()} {platform.system()} {os.cpu_count()} cores, "
                            f"Python {platform.python_version()}",
                 "elapsed": round(elapsed, 1)},
        "summary": summary,
        "rows": rows,
    }
    RESULTS_DIR.mkdir(exist_ok=True)
    out = RESULTS_DIR / f"{args.label}.json"
    out.write_text(json.dumps(result, indent=1))
    print(f"wrote {out}")
    if not (args.fast or args.only or args.group):
        runs = {}
        for lab in [c.strip() for c in args.compare.split(",") if c.strip()]:
            cmp_path = RESULTS_DIR / f"{lab}.json"
            if lab != args.label and cmp_path.exists():
                runs[lab] = json.loads(cmp_path.read_text())
        runs[args.label] = result
        write_markdown(HERE / "RESULTS.md", runs)
        print(f"wrote {HERE / 'RESULTS.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
