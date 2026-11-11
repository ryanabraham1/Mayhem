# Plan: warn early when a constraint makes a path unsolvable

## Goal

Today, when a path can't be solved, the user waits the whole time limit (60 s by default),
and sometimes longer, before the Issues panel says which constraint is at fault. The solver
often knows the cause within a few seconds. This plan does four things:

1. **Streams an early warning** to the app as soon as any candidate proves a constraint
   can't be met, and lets the user stop right away while keeping that diagnosis.
2. **Stops the solve early** when the proven conflict can't be fixed by picking a
   different route.
3. **Runs the infeasibility probe in more cases**, so solves that currently run out the
   clock also get diagnosed early.
4. **Keeps the final diagnosis within the time limit**, instead of starting a new
   elastic solve of up to `max(10, time_limit/3)` after the deadline.

Out of scope for now: new analytic checks in `validate()` that run before the solve
(heading rate, stopping distance, and so on). Note them as a follow-up in the PR.

## Background: how solving works today

Read these before starting:

- `docs/SOLVER.md`, section "Search and diagnostics".
- `solver/src/mayhem_solver/pipeline.py`:
  - `Solver.ladder()` (around line 612): per-candidate steps: direct → **1b elastic probe** →
    coarse mesh → soft geometry → relaxed limits → segment-wise.
  - Step 1b only runs when the direct status is in `INFEASIBLE_STATUSES`
    (`Infeasible_Problem_Detected`, `Restoration_Failed`). It runs an `"elastic"` OCP, capped
    at `min(8, 0.3 * time_left)`. If `hard_violations(probe.slacks)` is non-empty, it returns
    `Attempt(..., probe=probe, infeasible=True)`, which stops that candidate.
  - `DECISIVE_SLACK` / `hard_violations()` decide what counts as a real violation. Each
    slack entry is `(label, category, total, sample_index)`. The categories are
    `user, heading, stop, waypoint, obstacle, wall, keepin, wheel, force, motor`.
  - `_solve_candidate()` runs one candidate and returns a dict containing `infeasible`,
    `probe_sol` and `probe_slacks`.
  - `solve()` runs the candidates, in parallel through `_run_parallel()` or sequentially
    (`parallel=False`, used on Windows via `solve-job`), then calls `diagnose()` if none
    succeeded.
  - `_run_parallel()` waits for **every** candidate's `_result`, forwards other queue
    messages to `progress`, and terminates procs at `deadline + 30`.
  - `diagnose()` either reuses the best probe or runs a **new** elastic solve with its own
    `max(10, time_limit/3)` budget. That budget starts after the candidates' deadline, so
    it adds time on top of the limit. Lines ~871–908 turn slacks into `Issue`s: ranked, top
    6, with waypoint/t/x/y, plus a per-category `hint`.
- `solver/src/mayhem_solver/rpc.py`: each progress message `m` becomes an RPC
  notification `solveProgress` with params `{jobId, name, **m}`. Both job types forward it
  (`Job` via multiprocessing and `SubprocessJob` via stdio). Payloads must be
  JSON-serializable.
- `solver/src/mayhem_solver/ocp.py`: `SUCCESS` set (line 38). IPOPT's time cap is
  `max_cpu_time`, which ends with `Maximum_CpuTime_Exceeded`. Check the exact status
  strings that come back from `stats["return_status"]` (around line 761).
- App side:
  - `app/src/store.ts`: `SolveState` (around line 28); the `backend.on("solveProgress")`
    handler (around line 354) handles `stage` / `iteration` / `candidates`;
    `finishSolve` (around line 261); `cancelSolve` (around line 756), which resets the
    state to `idle` and **drops issues**.
  - `app/src/components/Stage.tsx` (around line 53–85): the floating Issues panel, titled
    "Generation failed". Clicking an issue selects its waypoint and seeks to `t`.
  - `app/src/types.ts`: `Issue` type.

**The working tree has uncommitted, unrelated edits** (`app/src/components/FieldCanvas.tsx`,
`app/src/model.ts`, `app/src/model.test.ts`). Don't revert or include them. Commit only your
own files.

---

## Part A: solver

### A1. Pull issue-building out of `diagnose()`

Move the "slacks → `list[Issue]`" code (the `agg` / `ranked` / hint loop, including the
`(intake)` special case) into a module-level function:

```python
def slack_issues(traj: Trajectory, sol: Solution, slacks) -> list[Issue]:
```

`diagnose()` then calls it. Keep the "did not converge, but no single constraint looks
infeasible" fallback inside `diagnose()`, not inside `slack_issues`. Nothing should
change for existing callers; `test_infeasible_heading_is_diagnosed` and
`test_conflicting_point_at_is_diagnosed_quickly` must still pass.

`Solver.traj` is already pose-resolved, because `solve()` resolves before dumping `tj`.
So a worker can call `slack_issues(self.traj, probe.solution, probe.slacks)` directly.

### A2. Classify which conflicts depend on the route

Add near `DECISIVE_SLACK`:

```python
# Violations another route can't fix: once one candidate proves one of these, the others
# almost certainly fail too. Geometry (obstacle/wall/keepin) depends on the route.
ROUTE_INDEPENDENT = {"user", "stop", "waypoint"}
```

Leave `heading` out on purpose. Point-at and heading conflicts depend on where the robot
is, so a different route can sometimes satisfy them. They still get the early *warning*,
just not the early *stop* without confirmation (see A4).

Add a helper `route_independent(bad) -> bool` that returns True when **every** decisive
violation's category is in `ROUTE_INDEPENDENT`.

> Check this assumption against a user constraint that depends on position, such as a
> velocity limit in a zone: a different route might avoid the zone. If `user` labels can be
> tied back to their constraint type, restrict the set to types whose scope doesn't depend
> on position (range/waypoint scope). Zone-scoped constraints count as route-dependent. The
> label format is `Constraint '<type>' (<id>)`; check how `ocp.py` builds user labels and
> use `traj.constraints` to look up the scope kind.

### A3. Emit an early-warning progress event

In `Solver.ladder()` step 1b, when `bad` is non-empty and before returning, call:

```python
if self.progress:
    self.progress({"type": "infeasible", "candidate": self.candidate,
                   "routeIndependent": route_independent(bad),
                   "issues": [i.dump() for i in slack_issues(self.traj, probe.solution, probe.slacks)]})
```

`Issue.dump()` already exists (`rpc.py` uses it). Check that it produces camelCase and
JSON-safe floats. NaN or inf in `t`/`x`/`y` would break the JSON; use `None` for
non-finite values.

Also add `"routeIndependent"` to the dict that `_solve_candidate()` returns, so the
parent doesn't have to rely on the progress message to decide whether to stop.

### A4. Stop early in `solve()`

Add a constant `EARLY_STOP_GRACE = 5.0` (seconds).

**Parallel (`_run_parallel`):** when a `_result` arrives with `infeasible and
routeIndependent`:

- If this is the **first** such result, set `deadline = min(deadline, now +
  EARLY_STOP_GRACE)`. A candidate on a better route that really is feasible usually
  converges within a few seconds.
- If a **second** candidate reports route-independent infeasibility with at least one
  label in common with the first, stop now.
- Stopping means: leave the loop, terminate the remaining processes (the `finally` block
  already does this), and record the unfinished ones as today ("did not finish within the
  time limit").

The loop currently only knows `hard_deadline`, so pass the soft deadline in and loop while
`len(results) < len(procs)` and `now <= effective_deadline`. **Don't** shorten anything
when no candidate proved infeasibility; that path must behave exactly as before.

The loop's exit condition is only checked after a message arrives or `Empty` fires (every
0.2 s at most), so the grace deadline is honoured to within about 0.2 s. That's fine.

**Sequential (`parallel=False`, Windows):** in the `for i, c in enumerate(cands)` loop,
after a route-independent infeasible result, run each remaining candidate with budget
`min(deadline - now, EARLY_STOP_GRACE)`. After a second agreeing proof, `break`.

If any candidate succeeds, it still wins as today. The early stop only applies when no
candidate has succeeded.

Log it in the attempts list, for example `"stopped early: <label> cannot be met on any
route"`, so it shows up in `SolveStats.attempts` / debugging.

### A5. Run the probe in more cases

Today step 1b only fires on `INFEASIBLE_STATUSES`. Conflicting constraints often end the
direct solve at `Maximum_Iterations_Exceeded` or the CPU-time cap instead.

- Save `direct_status = res.status` right after the direct `run_ocp`, **before**
  `finish(res)`. `polish()` can set `res.success=False` / change the status on a converged
  solve that failed the swept check, and that's a geometry problem, not proof of
  infeasibility.
- Run the probe when `direct_status in INFEASIBLE_STATUSES` (keep the current cap
  `min(8, 0.3*time_left)`), **or** when `direct_status` is not in `SUCCESS` (a new, smaller
  cap `min(5, 0.2*time_left)`).
- Don't probe when the direct solve converged but `polish` rejected it.
- Keep what happens next the same: decisive violation → stop the candidate; near-zero
  slack → warm-start `elastic->hard`; otherwise continue the ladder.

**This has to pass the benchmark** (see Verification). If feasible paths get slower or
some stop solving, narrow the trigger to `INFEASIBLE_STATUSES | {"Maximum_Iterations_Exceeded",
"Maximum_CpuTime_Exceeded"}` and re-run. Record before/after numbers in
`solver/benchmarks/RESULTS.md`, following the existing format there.

### A6. Keep the final diagnosis within the time limit

In `solve()`, when no candidate succeeded and no probe exists, `diagnose()` starts a new
elastic solve with its own `max(10, time_limit/3)` budget, which runs after the deadline.
Change this:

- Reserve diagnosis time up front: `diag_reserve = min(8.0, 0.15 * time_limit)`, and run
  the candidates with `deadline = start + time_limit - diag_reserve`.
- Pass `diagnose()` an explicit deadline equal to the original `start + time_limit`,
  instead of `max(10, tl/3)` from now.
- If a probe exists, `diagnose()` uses it and the reserved time just isn't used. Consider
  whether to only reserve when needed: an alternative is to keep the full budget for the
  candidates and give `diagnose` a hard 5 s cap. Pick one, and note the choice in
  `docs/SOLVER.md`.

This must not reduce the success rate on the benchmark. If the reserve costs successes on
paths that run close to the limit, choose the alternative.

### A7. Solver tests (`solver/tests/`)

Use the fixtures in `conftest.py` and the helpers in `test_solver.py` /
`test_poses_lines.py` (`wp`, `rng`, `project`, `box_project`).

1. **Early event:** use the `test_infeasible_heading_is_diagnosed` setup and collect
   progress messages with a list-appending `progress` callback. Assert that an
   `{"type": "infeasible"}` message arrives, that its `issues` are non-empty and
   JSON-serializable (`json.dumps`), and that it arrives before `solve()` returns.
2. **Early stop, parallel:** use a project with obstacles so `candidate_routes` returns
   more than one candidate (`box_project`, or add an obstacle), plus a route-independent
   conflict such as two contradictory `stop`/fixed-waypoint constraints or a user limit
   that can't be met. Look at `test_conflicting_point_at_is_diagnosed_quickly` for the
   pattern, but choose a conflict in `ROUTE_INDEPENDENT`. Set `time_limit = 60` and
   `parallel=True`, and assert `not r.success`, that the right label is in
   `r.issues[0].message`, and that wall time is well under the limit (for example < 20 s).
3. **Early stop, sequential:** same case with `parallel=False`, with the same assertions.
4. **No false stop:** a feasible path with more than one candidate still succeeds and still
   picks the fastest candidate. Existing tests mostly cover this; add one explicitly if
   none has more than one candidate.
5. **Geometry conflict doesn't stop early:** a waypoint set that can only be blocked by an
   obstacle on some routes should still let the other candidates run. Assert that no
   `"stopped early"` line appears in the attempts log.
6. **Time limit respected:** an unsolvable case with no probe (for example one that
   doesn't converge but has no decisive slack) finishes within `time_limit + 3` s (only if
   you implement A6).
7. `test_rpc.py`: check that a `solveProgress` notification with `type: "infeasible"`
   reaches the notify callback, for at least the multiprocessing `Job` path.

---

## Part B: app

### B1. State

In `app/src/store.ts`, extend `SolveState`:

```ts
/** Constraint conflicts reported while the solve is still running (see solver "infeasible" events). */
warnings?: Issue[];
```

### B2. Progress handler

In the `backend.on("solveProgress")` handler, add:

```ts
if (p.type === "infeasible") {
  const seen = new Set((st.warnings ?? []).map((w) => w.message));
  st.warnings = [...(st.warnings ?? []), ...(p.issues as Issue[]).filter((w) => !seen.has(w.message))];
}
```

Note the existing guard `st.jobId !== p.jobId`. As `finishSolve` already notes, an event
can arrive before the RPC response sets `jobId`. A probe takes at least a second, so this
is unlikely, but if you buffer events for the early case, reuse the `earlyDone` pattern.
Otherwise leave a comment explaining why it's safe to drop.

`finishSolve` should clear `cur.warnings = undefined`. The final `issues` replace them.

### B3. Stop and keep the diagnosis

Add an action `stopWithWarnings(name: string)`: cancel the job like `cancelSolve` does,
then set `s.solves[name] = { status: "failed", issues: st.warnings ?? [] }` instead of
`idle` with no issues. `cancelSolve` stays as it is for the top-bar Stop button and for
deleting a path.

The RPC `cancel` still triggers a `solveDone` with `cancelled: true`. `finishSolve`
ignores it because the status is no longer `"solving"`. Confirm this, so the warnings
aren't overwritten with "Cancelled."

### B4. UI (`app/src/components/Stage.tsx`)

The Issues panel only renders `solve.issues`. Add a second state: while
`solve.status === "solving"` and `solve.warnings?.length`, render the same floating panel
with:

- Title **"Likely unsolvable"**, in amber (`var(--amber)`) with `AlertTriangle`. Not red:
  the solve is still running and another candidate may still succeed if the conflict
  depends on the route.
- One line of body text, for example "Mayhem is still trying other routes." For a
  route-independent early stop the solve finishes on its own within a few seconds, so this
  text is only accurate for route-dependent conflicts. Keep it generic.
- The same clickable issue rows (reuse the row markup: pull out a small `IssueRow`
  component rather than duplicating it).
- A **Stop** button (`btn danger sm`) that calls `stopWithWarnings(selectedTraj)`.

Optional: an amber dot on the path's row in `Sidebar.tsx` (around line 220) while
`warnings` is non-empty, so problems show up during "Generate all".

Match the existing style: purple, light, card-based theme; lucide icons; the existing
`card-head` / `card-title` / `issue` classes. Don't add new colors.

### B5. App tests

- `store.test.ts`: feed a `solveProgress` `{type: "infeasible", issues: [...]}` for an
  active job, then assert that `warnings` are set and deduped. Then `solveDone` → assert
  `warnings` are cleared and `issues` come from the done payload. Also test
  `stopWithWarnings` → status `failed`, issues equal the warnings, and a later
  `cancelled` `solveDone` doesn't overwrite them.
- `ui.test.tsx` (or a new `Stage.test.tsx`): the panel renders "Likely unsolvable" with a
  Stop button while solving with warnings, and "Generation failed" after completion.

---

## Part C: docs

- `docs/SOLVER.md` "Search and diagnostics": describe the `infeasible` progress event, the
  probe trigger, `ROUTE_INDEPENDENT`, the grace period, the early stop, and how the
  diagnosis budget is handled. Also document the RPC event shape at the top of the file,
  where `solveProgress` is mentioned.
- `docs/USER_GUIDE.md`: a short paragraph on the "Likely unsolvable" panel and its Stop
  button.

## Verification (all must pass before handing back)

```bash
cd solver && uv run pytest
```

```bash
cd solver && uv run python -m benchmarks.run
```

Compare against `solver/benchmarks/results/current.json`. The pass bar: no path that
succeeded before fails now, and no path's median wall time gets more than about 5%
slower. Unsolvable paths, if the corpus has any, should get faster. Save the new results
the way earlier runs did, and add a short entry to `RESULTS.md`.

```bash
cd app && npm test
```

```bash
cd app && npx tsc --noEmit
```

Then run the app, open a path with a known conflict (for example the two opposing point-at
constraints from `test_conflicting_point_at_is_diagnosed_quickly`, or a max-velocity
constraint that can't be met), click Generate, and check the following. Take screenshots.

1. The amber "Likely unsolvable" panel shows up within about 10 s and names the constraint.
2. Clicking a row selects the waypoint.
3. Stop leaves the diagnosis visible as "Generation failed".
4. Without clicking Stop, a route-independent conflict finishes within about the grace
   period after the first warning, not at 60 s.

## Suggested commit breakdown

1. Solver: `slack_issues` refactor (no behavior change).
2. Solver: `infeasible` progress event + early stop + tests.
3. Solver: broader probe trigger + benchmark results.
4. Solver: diagnosis budget within the time limit (A6).
5. App: warnings state, Stop action, panel + tests.
6. Docs.

Commit messages follow the repo's style (`git log --oneline`). Ask the user before bumping
the app version or tagging a release.
