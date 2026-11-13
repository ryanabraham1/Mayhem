#!/usr/bin/env node
// Node 24+ strips TypeScript: UI and agents share the exact authoring/preview core.
import "./suite-imports.mjs";
// The import hook relies on node:module stripTypeScriptTypes, which prints an
// ExperimentalWarning on first use. CI and Gradle treat stderr output as a problem,
// so drop exactly that warning; every other warning is still reported.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (type === "ExperimentalWarning" && /stripTypeScriptTypes|Type Stripping/.test(text)) return;
  return emitWarning.call(this, warning, ...rest);
};
import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  mkdir,
  stat,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseProject, validateProject } from "../app/src/suite/core/model.ts";
import { sampleProject } from "../app/src/suite/core/sample.ts";
const { exportCpp } = await import("../app/src/suite/core/export-cpp.ts");
const { simulate } = await import("../app/src/suite/core/runtime.ts");
const { headingLints } = await import("../app/src/suite/core/headingLint.ts");
import { analyze, parseRecordingJSON, currentBreakdown } from "../app/src/suite/core/analysis.ts";
import { listChannels, logTable, findAnomalies, whatChanged, logEvents, machineStates } from "../app/src/suite/core/logquery.ts";
import { NT4Observer } from "../app/src/suite/core/nt4.ts";
import { parseWPILog } from "../app/src/suite/core/wpilog.ts";
import { vendorCpp } from "./cpp-vendor.mjs";
const { applyMachineSpecs, machineFromSpec, specFromMachine, routineFromMtraj } = await import("../app/src/suite/core/authoring.ts");
import { execFile } from "node:child_process";
const { buildReport, WORKTREE } = await import("../app/src/suite/core/review/report.ts");
const { gitSnapshot } = await import("./review-git.mjs");
const { nodeRunner } = await import("./review-sim.mjs");
const { scenarioSet, describeTrack } = await import("../app/src/suite/core/review/scenarios.ts");
const { runSimProof } = await import("../app/src/suite/core/review/simproof.ts");
const { parseMachineSpecs } = await import("../app/src/suite/core/review/machines.ts");
const { readProject } = await import("../app/src/suite/core/review/autos.ts");
const { createItem, move, STATUS_NAMES } = await import("../app/src/suite/core/review/tasks.ts");
const { listItems, readItem, saveItem } = await import("./review-tasks.mjs");
const tools = [
  {
    name: "apply_machine_spec",
    description:
      "Create or replace state machines in a project from compact specs (docs/SUITE_AGENTS.md, Authoring machines and routines): inputs grouped by category, states, and transitions with readable conditions such as \"FROM -> TO: enabled && deploy && !hoodClear  # name\". A misspelled input or state is an error. Each machine replaces the one with the same id in extensions.machines, in place, or is appended. Saves atomically with a revision bump (expectedRevision optional); dryRun returns the manifests without writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        spec: { description: "One machine spec, a list of them, or { machines: [...] }." },
        expectedRevision: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "spec"],
    },
  },
  {
    name: "machine_spec",
    description: "Return the compact spec of a machine in a project (conditions as text), to edit and pass back to apply_machine_spec.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, machine: { type: "string" } }, required: ["path", "machine"] },
  },
  {
    name: "import_mtraj_route",
    description:
      "Build (or rebuild) autonomous routines from solved classic-planner .mtraj passes: each pass becomes key-waypoint pose steps (its waypoints plus the fewest points that stay within pathTolerance m and headingTolerance deg of the solve) with the solved heading and a speed cap from the solved speed, mapped event markers, and optional steps after each pass (e.g. an aim-and-shoot custom step with onTimeout \"succeed\"). .mtraj paths are relative to the project file. Saves atomically with a revision bump; dryRun returns the routines without writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        spec: { description: "One route spec, a list, or { routines: [...], events, endEvents, options } with shared defaults." },
        expectedRevision: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["path", "spec"],
    },
  },
  {
    name: "inspect_live_robot",
    description:
      "Read current NT4 states, schema manifests, and explicitly requested signal topics. This client cannot publish or command the robot.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        topics: { type: "array", items: { type: "string" } },
        durationMs: { type: "integer", minimum: 100, maximum: 5000 },
      },
      required: ["host"],
    },
  },
  {
    name: "export_cpp",
    description:
      "Generate the standalone C++17 header for a robot: every routine (RoutineView, name, start pose, `routines` array), one Autonomous manifest, every extensions.machines graph as a mayhem::StateMachine MachineView with its manifest, and the field size. Deterministic. Custom robot code remains unrestricted. Returns code; does not deploy. From a shell, `cpp <project> --out <header>` writes it and `--check <header>` fails if stale.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vendor_cpp",
    description:
      "Copy Mayhem's header-only C++ library (lib-cpp/include/mayhem) into a robot project (default <robotDir>/src/main/include/mayhem) and write a snapshot with the version, source commit and SHA-256 of every header. check=true only compares and reports problems. Prefer the MayhemCpp vendordep when the robot can use it.",
    inputSchema: {
      type: "object",
      properties: {
        robotDir: { type: "string" },
        dest: { type: "string", description: "Header directory relative to robotDir." },
        snapshot: { type: "string", description: "Snapshot path relative to robotDir (default <dest>/mayhem-vendor.json)." },
        check: { type: "boolean" },
      },
      required: ["robotDir"],
    },
  },
  {
    name: "open_in_app",
    description:
      "Show a project file to the user in the Mayhem desktop app (macOS): validates it, then opens it in the running app (or launches it), which switches to that project and links and watches the file, exactly like Agents → Open project file. Later edits to the file appear live. Use after writing a project the user should look at.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project file (*.mayhem.json)." },
        app: { type: "string", description: "Application name or path (default Mayhem, or MAYHEM_APP)." },
      },
      required: ["path"],
    },
  },
  {
    name: "inspect_project",
    description:
      "Read the full Mayhem project. Extensions and custom action IDs are open; the editor is not a limit on robot code.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "validate_project",
    description: "Validate a Mayhem project and return actionable issues.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "object" } },
      required: ["project"],
    },
  },
  {
    name: "save_project",
    description:
      "Atomically replace a valid project with optimistic revision checking. expectedRevision=null creates a new file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        project: { type: "object" },
        expectedRevision: { type: ["integer", "null"] },
      },
      required: ["path", "project", "expectedRevision"],
    },
  },
  {
    name: "simulate_auto",
    description:
      "Run a deterministic pose/condition preview. This ideal plant cannot validate real mechanism code. Sensors change only through supplied signal values. Frozen drive must fail its watchdog. headingWarnings lists event markers (pickups) that fire with the robot's front (+x) more than 45° off its direction of travel; fix them with goal.headingMode \"motion\" (optionally goal.headingOffset) on that step.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        routine: { type: "string" },
        signals: { type: "object" },
        freezeDrive: { type: "boolean" },
        maxSeconds: { type: "number" },
        mode: { type: "string", enum: ["path", "routine"] },
        actions: { type: "object", additionalProperties: { type: "string", enum: ["running", "succeeded", "failed"] } },
      },
      required: ["path"],
    },
  },
  {
    name: "behavior_diff",
    description:
      "Compare the behavior of two revisions of a robot repo the way the team reviews it (docs/SUITE_AGENTS.md, Behavior review): hardware (CAN IDs, motor direction, brake/coast, current limits, gear ratios), constants with units, state machines (tools/mayhem/machines.json) including driver-control changes, and autonomous paths (the root *.mayhem.json) driven in the path preview. Returns a risk level: red = safety-related hardware/settings change; yellow = controls, machines or other values changed; green = only auto paths changed and every changed path completes. Run it on your own change before asking a human to review. `before` defaults to HEAD, `after` to the working tree (\"WORKTREE\").",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        before: { type: "string", description: "Git revision (default HEAD)." },
        after: { type: "string", description: "Git revision, or WORKTREE for uncommitted files (default)." },
        detail: { type: "string", enum: ["summary", "full"], description: "summary (default): level, findings, errors. full: the whole report (devices, settings, machines, paths)." },
      },
      required: ["repo"],
    },
  },
  {
    name: "run_scenarios",
    description:
      "Sim proof (docs/SUITE_AGENTS.md, Sim proof): build a revision of the robot repo with Mayhem's probe test and run scenarios through the robot's own simulation: every controller button tapped and held from teleop, every auto in the root *.mayhem.json, and the team's tools/mayhem/scenarios.json (plain steps such as \"hold A 2\" and expectations such as \"Shooter mode is SHOOTING by 1.5 s\"). With `before`, each scenario also runs on that revision and differences in what the robot does (machine states, drive mode, auto result) are reported; the team rule is that the same driver inputs give the same outcomes. Takes about a minute per revision the first time (cached per commit). Needs the robot's Gradle/WPILib toolchain on this computer.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Robot repository directory." },
        after: { type: "string", description: "Revision to test (default WORKTREE, the uncommitted files)." },
        before: { type: "string", description: "Optional revision to compare against, e.g. HEAD or main." },
        groups: { type: "array", items: { type: "string", enum: ["button", "auto", "custom"] }, description: "Which scenarios (default all)." },
        names: { type: "array", items: { type: "string" }, description: "Only scenarios whose name contains one of these (case-insensitive), e.g. [\"Hold A\", \"Outpost\"]." },
        scenarios: {
          type: "array",
          description: "Extra scenarios to run now without editing scenarios.json (same format: { name, steps, expect }). With `scenarios` and no groups/names, only these run.",
          items: { type: "object", properties: { name: { type: "string" }, steps: { type: "array", items: { type: "string" } }, expect: { type: "array", items: { type: "string" } }, alliance: { type: "string" }, field: { type: "boolean" } }, required: ["name", "steps"] },
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "list_tasks",
    description:
      "Feedback from the team turned into tasks (docs/SUITE_AGENTS.md, Tasks): one file each in the robot repo's tools/mayhem/review/. Returns id, title, kind, status, agent and anchor (log, time, revision, field pose, scenario). `status` filters (default: everything not done/declined/noted). Pick an open task, claim it, then propose a plan and wait for a person to approve it before changing code.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, status: { type: "array", items: { type: "string", enum: ["noted", "open", "claimed", "plan", "approved", "review", "done", "declined"] } } }, required: ["repo"] },
  },
  {
    name: "get_task",
    description: "One task with its full context: the feedback text, driver form answers, anchor (log name/path and seconds into it, code revision, field pose, sim scenario), plan, decision, commits with their behavior risk, and history.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" } }, required: ["repo", "id"] },
  },
  {
    name: "claim_task",
    description: "Take an open task. `agent` is your name (shown to people). Records the repo's current HEAD as the base the change is compared against.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" }, agent: { type: "string" } }, required: ["repo", "id", "agent"] },
  },
  {
    name: "propose_plan",
    description:
      "Before changing code: describe in plain English, for people who don't read code, what will change on the robot and how they will be able to tell (which button, auto or value; what sim proof scenario covers it). The task waits in \"Plan to approve\" until a person approves it in the Mayhem app; poll get_task until status is \"approved\" (or back to \"claimed\" with a note asking for a different plan). Do not start coding before approval.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" }, agent: { type: "string" }, plan: { type: "string" } }, required: ["repo", "id", "agent", "plan"] },
  },
  {
    name: "report_progress",
    description:
      "After committing work for an approved task, report the commit. Put a `Mayhem-Task: <id>` trailer in the commit message so the Changes page links the change to this feedback. Mayhem runs behavior_diff on the commit (against the task's base) and stores its risk level and findings on the task.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" }, agent: { type: "string" }, revision: { type: "string" }, summary: { type: "string" } }, required: ["repo", "id", "agent", "revision"] },
  },
  {
    name: "finish_task",
    description:
      "Mark an approved task's work done. If every reported commit is green (only auto paths changed and every changed path finishes), it is accepted automatically; otherwise a person checks it (\"Ready to check\"). Run run_scenarios with `before` = the task's base first and mention the result in `note`.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" }, agent: { type: "string" }, note: { type: "string" } }, required: ["repo", "id", "agent"] },
  },
  {
    name: "release_task",
    description: "Give a claimed task back (open again), e.g. when it needs something you can't do. Say why in `note`.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, id: { type: "string" }, agent: { type: "string" }, note: { type: "string" } }, required: ["repo", "id", "agent"] },
  },
  {
    name: "add_feedback",
    description: "Record feedback someone gave you (e.g. a driver in chat) as a task, with whatever anchor you know.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        author: { type: "string", description: "The person who gave the feedback." },
        kind: { type: "string", enum: ["comment", "thumbs-up", "thumbs-down", "field-point", "pit-note"] },
        title: { type: "string" },
        text: { type: "string" },
        anchor: { type: "object" },
      },
      required: ["repo", "author", "text"],
    },
  },
  {
    name: "analyze_log",
    description:
      "Read a local WPILOG 1.0 or recording JSON and return measured power findings and logging coverage. Returns a compact summary by default (findings, power, top current draws, channel overview). Use `channels` (substring filters) to get per-channel stats and downsampled samples, `from`/`to` to restrict to a time window, and `detail: \"full\"` for the raw legacy dump. Optionally map voltage/current/brownout names.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mapping: { type: "object" },
        policy: { type: "object" },
        detail: { type: "string", enum: ["summary", "full"], description: "summary (default) omits sample arrays; full returns everything." },
        channels: { type: "array", items: { type: "string" }, description: "Case-insensitive substrings; matching channels return stats (min/max/mean/first/last) and downsampled samples. Include \"Estimated total supply current\" to query the estimate." },
        from: { type: "number", description: "Window start, seconds from log start." },
        to: { type: "number", description: "Window end, seconds from log start." },
        maxSamples: { type: "integer", minimum: 0, maximum: 500, description: "Max samples per queried channel (default 40, 0 = stats only)." },
        maxChannels: { type: "integer", minimum: 1, maximum: 200, description: "Max matched channels returned (default 30)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_log_channels",
    description:
      "Search a WPILOG/recording's channels. Returns name, type, sample count, time span, rate, and min/max/mean for numeric channels. Start here to find what to look at. `filter` = case-insensitive substrings.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, filter: { type: "array", items: { type: "string" } }, type: { type: "string" }, limit: { type: "integer", maximum: 300 }, offset: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "log_table",
    description:
      "Line several channels up on one shared clock (last value held) between `from` and `to`, at `step` seconds or `points` rows (max 500). Use it to compare up to 20 signals at the same moments; for up to 8 channels it also returns pairwise correlation. Names are exact or substring matches.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, step: { type: "number" }, points: { type: "integer" } }, required: ["path", "channels"] },
  },
  {
    name: "log_anomalies",
    description:
      "Scan channels (all by default) for abnormal behavior: outliers, sudden jumps, sampling dropouts, flatlined sensors, boolean flapping, channels that stop/start logging. Returns ranked events with times to investigate with log_table / log_what_changed. `sensitivity` 0.25-4 (higher finds more).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer" }, sensitivity: { type: "number" } }, required: ["path"] },
  },
  {
    name: "log_what_changed",
    description:
      "Given a moment `time` (seconds), rank the channels that deviated most from their own normal within +/- `window` seconds (default 1), with before/after values. Use after finding a suspicious time to see what else was happening.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, time: { type: "number" }, window: { type: "number" }, filter: { type: "array", items: { type: "string" } }, limit: { type: "integer" } }, required: ["path", "time"] },
  },
  {
    name: "log_states",
    description:
      "Why each state machine did what it did: from Mayhem's logged Mayhem/States/<id>/state, /transition and /inputs/*, every state change with the transition that fired and the input values at that moment. Back-and-forth bursts (a machine fighting itself) collapse into one entry naming both transitions and the inputs that kept both true. Start here for state-machine bugs, e.g. on a run_scenarios log.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, machines: { type: "array", items: { type: "string" }, description: "Machine id substrings (default all)." }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer", description: "Entries per machine (default 40, max 200)." } }, required: ["path"] },
  },
  {
    name: "log_events",
    description:
      "Chronological list of value changes for boolean/string/state channels (all meaningful non-numeric channels by default: dashboard plumbing, guard flags and NetworkTables copies of logged channels are skipped unless `all`; or the named `channels`), merged across channels. Shows state-machine transitions, mode changes and alerts in order.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, mapping: { type: "object", description: "Optional signal mapping, as for analyze_log (adds the estimated total current channel)." }, channels: { type: "array", items: { type: "string" } }, from: { type: "number" }, to: { type: "number" }, limit: { type: "integer" }, all: { type: "boolean" } }, required: ["path"] },
  },
];
function pathFor(path) {
  if (typeof path !== "string" || !path.trim())
    throw new Error("A file path is required.");
  return resolve(path);
}
function channelStats(channel, from, to, maxSamples) {
  const inWindow = channel.samples.filter((s) => s.time >= from && s.time <= to);
  const nums = inWindow.filter((s) => typeof s.value === "number" && Number.isFinite(s.value));
  const round = (n) => Math.round(n * 1e4) / 1e4;
  const out = { name: channel.name, type: channel.type, samples: inWindow.length };
  if (nums.length) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (const s of nums) {
      min = Math.min(min, s.value);
      max = Math.max(max, s.value);
      sum += s.value;
    }
    Object.assign(out, { min: round(min), max: round(max), mean: round(sum / nums.length), first: round(nums[0].value), last: round(nums[nums.length - 1].value) });
  } else if (inWindow.length) {
    out.first = inWindow[0].value;
    out.last = inWindow[inWindow.length - 1].value;
  }
  if (maxSamples > 0 && inWindow.length) {
    const step = Math.max(1, Math.ceil(inWindow.length / maxSamples));
    out.series = inWindow
      .filter((_, i) => i % step === 0)
      .map((s) => [round(s.time), typeof s.value === "number" ? round(s.value) : s.value]);
  }
  return out;
}
const logCache = new Map();
async function loadLog(path, mapping) {
  const { mtimeMs } = await stat(path);
  const key = `${path}|${mtimeMs}|${JSON.stringify(mapping ?? null)}`;
  let hit = logCache.get(key);
  if (!hit) {
    const bytes = await readFile(path);
    const recording = path.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), path)
      : parseRecordingJSON(bytes.toString("utf8"));
    const { estimatedCurrent } = analyze(recording, mapping);
    hit = estimatedCurrent
      ? { ...recording, channels: [...recording.channels, estimatedCurrent] }
      : recording;
    logCache.clear();
    logCache.set(key, hit);
  }
  return hit;
}
/** Open a validated project file in the desktop app; it links and watches the file. */
export async function openInApp(path, app = process.env.MAYHEM_APP || "Mayhem") {
  if (typeof path !== "string" || !path) throw new Error("A project file path is required.");
  const file = resolve(path);
  const problems = validateProject(JSON.parse(await readFile(file, "utf8"))).filter((i) => i.severity === "error");
  if (problems.length) throw new Error(`Not opened; the project is invalid: ${problems.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  if (process.platform !== "darwin")
    throw new Error("Opening in the desktop app from the command line is macOS-only for now. Open it in Mayhem with Agents → Open project file.");
  // macOS delivers the file to the running app (or launches it); the app switches to the
  // project and links the file. `open` returns once Launch Services has handed it over.
  await new Promise((done, fail) =>
    execFile("open", ["-a", app, file], (error, _out, stderr) => (error ? fail(new Error(stderr.trim() || error.message)) : done())),
  );
  return { opened: file, app, note: "The app switches to this project and watches the file; edits on disk appear within about a second." };
}
const asList = (spec, key) => {
  if (Array.isArray(spec)) return spec;
  if (spec && typeof spec === "object" && Array.isArray(spec[key])) return spec[key];
  if (spec && typeof spec === "object") return [spec];
  throw new Error("Expected a spec object or a list of specs.");
};
/** Route specs with shared `events`, `endEvents`, `options`, `constraints` defaults applied. */
const routeSpecs = (spec) => {
  const shared = spec && !Array.isArray(spec) && Array.isArray(spec.routines) ? spec : {};
  return asList(spec, "routines").map((r) => ({
    ...r,
    events: { ...(shared.events ?? {}), ...(r.events ?? {}) },
    endEvents: r.endEvents ?? shared.endEvents,
    options: { ...(shared.options ?? {}), ...(r.options ?? {}) },
    ...(shared.constraints || r.constraints ? { constraints: { ...(shared.constraints ?? {}), ...(r.constraints ?? {}) } } : {}),
  }));
};
/** Read, change and save a project with the same revision check and atomic write as save_project. */
async function updateProject(path, args, change) {
  const current = parseProject(await readFile(path, "utf8"));
  if (args.expectedRevision !== undefined && args.expectedRevision !== null && args.expectedRevision !== current.revision)
    throw new Error(`Revision conflict: current revision is ${current.revision}. Re-read before editing.`);
  const { project, ...result } = change(current);
  if (args.dryRun) return { dryRun: true, revision: current.revision, ...result };
  const saved = await execute("save_project", { path, project, expectedRevision: current.revision });
  return { ...saved, ...result };
}
export async function behaviorDiff(args) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  const report = buildReport(await gitSnapshot(repo, args.before ?? "HEAD"), await gitSnapshot(repo, args.after ?? WORKTREE));
  if (args.detail === "full") return report;
  const { level, findings, errors, before, after } = report;
  return { before, after, level, findings, errors };
}
export async function runScenarios(args, progress) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  const snapshot = await gitSnapshot(repo, args.after ?? WORKTREE);
  const machines = parseMachineSpecs(snapshot.files["tools/mayhem/machines.json"]).machines;
  const project = Object.keys(snapshot.files).find((p) => /^[^/]+\.mayhem\.json$/.test(p));
  const fileScenarios = snapshot.files["tools/mayhem/scenarios.json"];
  const merged = args.scenarios?.length
    ? JSON.stringify({ scenarios: [...((fileScenarios && JSON.parse(fileScenarios).scenarios) || []), ...args.scenarios] })
    : fileScenarios;
  const { scenarios, errors } = scenarioSet(project ? readProject(snapshot.files[project]).project : undefined, merged);
  const inline = new Set((args.scenarios ?? []).map((s) => s.name));
  const chosen = scenarios.filter(
    (s) =>
      (!args.groups?.length || args.groups.includes(s.group)) &&
      (!args.names?.length || args.names.some((n) => s.name.toLowerCase().includes(String(n).toLowerCase()))) &&
      (args.groups?.length || args.names?.length || !inline.size || inline.has(s.name)),
  );
  const proof = await runSimProof(await nodeRunner(repo), { before: args.before, after: args.after ?? WORKTREE }, chosen, machines, progress);
  return {
    passed: proof.passed,
    changed: proof.changed,
    errors,
    results: proof.results.map((r) => ({
      scenario: r.scenario.name,
      ...(r.failed ? { failed: true } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.checks.length ? { checks: r.checks } : {}),
      ...(r.differences.length ? { differences: r.differences } : {}),
      ...(r.after?.physics?.hits?.length ? { hits: r.after.physics.hits } : {}),
      // What happened, in brief: each machine's states after the scenario started (flapping collapsed).
      ...(r.after && (r.failed || r.differences.length || inline.has(r.scenario.name))
        ? { timeline: Object.fromEntries(r.after.tracks.filter((t) => t.changes.length > 1).map((t) => [t.name, describeTrack(t, 12)])) }
        : {}),
      logs: r.logs,
    })),
  };
}
const summarize = (t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, statusText: STATUS_NAMES[t.status], author: t.author, ...(t.agent ? { agent: t.agent } : {}), anchor: t.anchor, createdAt: t.createdAt });
export async function taskTool(name, args) {
  if (typeof args.repo !== "string" || !args.repo) throw new Error("A robot repository directory is required.");
  const repo = resolve(args.repo);
  if (name === "list_tasks") {
    const wanted = args.status?.length ? args.status : ["open", "claimed", "plan", "approved", "review"];
    return { tasks: (await listItems(repo)).filter((t) => wanted.includes(t.status)).map(summarize) };
  }
  if (name === "add_feedback") return saveItem(repo, createItem({ author: args.author, kind: args.kind ?? "comment", title: args.title, text: args.text, anchor: args.anchor }), null);
  const { item, text } = await readItem(repo, args.id);
  if (name === "get_task") return item;
  if (typeof args.agent !== "string" || !args.agent.trim()) throw new Error("Say who you are: agent.");
  const agent = args.agent.trim();
  let next;
  if (name === "claim_task") {
    next = move(item, "claim", agent);
    next.base = (await new Promise((done, fail) => execFile("git", ["-C", repo, "rev-parse", "HEAD"], (e, out) => (e ? fail(e) : done(out.trim())))));
  } else if (name === "propose_plan") next = move(item, "plan", agent, { plan: args.plan });
  else if (name === "release_task") next = move(item, "release", agent, { note: args.note });
  else if (name === "report_progress") {
    const diff = await behaviorDiff({ repo, before: item.base ?? `${args.revision}~1`, after: args.revision });
    next = move(item, "progress", agent, { change: { revision: diff.after.rev, summary: args.summary, level: diff.level, findings: diff.findings.map((f) => `[${f.level}] ${f.text}`) } });
  } else if (name === "finish_task") {
    if (!item.changes.length) throw new Error("Report at least one commit with report_progress first.");
    const allGreen = item.changes.every((c) => c.level === "green" || c.level === "none");
    next = move(item, "finish", agent, { note: args.note });
    // Path-only changes that pass the preview need no person (team rule): accepted automatically.
    if (allGreen) next = move(next, "accept", "Mayhem", { note: "auto-OK: only auto paths changed and every changed path finishes" });
  } else throw new Error(`Unknown task tool ${name}`);
  return saveItem(repo, next, text);
}
export async function execute(name, args) {
  if (["list_tasks", "get_task", "claim_task", "propose_plan", "report_progress", "finish_task", "release_task", "add_feedback"].includes(name)) return taskTool(name, args);
  if (name === "behavior_diff") return behaviorDiff(args);
  if (name === "run_scenarios") return runScenarios(args);
  if (name === "validate_project")
    return { issues: validateProject(args.project) };
  if (name === "inspect_live_robot") {
    if (typeof args.host !== "string" || !args.host)
      throw new Error("A robot address is required");
    const duration = args.durationMs ?? 1000;
    if (!Number.isInteger(duration) || duration < 100 || duration > 5000)
      throw new Error("durationMs must be 100–5000");
    if (
      args.topics !== undefined &&
      (!Array.isArray(args.topics) ||
        args.topics.some((t) => typeof t !== "string"))
    )
      throw new Error("Topics must be strings");
    return await new Promise((resolve, reject) => {
      let latest = { status: "disconnected", topics: {} };
      const observer = new NT4Observer(args.host, (value) => {
        latest = value;
      });
      observer.setExtraTopics(args.topics ?? []);
      observer.connect();
      setTimeout(() => {
        const result = latest;
        observer.disconnect();
        if (result.status !== "connected")
          reject(new Error(result.error ?? "Could not read a connected robot"));
        else resolve(result);
      }, duration);
    });
  }
  if (name === "open_in_app") return openInApp(args.path, args.app);
  if (name === "vendor_cpp")
    return vendorCpp(args.robotDir, { dest: args.dest, snapshot: args.snapshot, check: args.check === true });
  const path = pathFor(args.path);
  if (name === "apply_machine_spec") {
    const specs = asList(args.spec, "machines");
    return updateProject(path, args, (project) => {
      const { project: next, machines, warnings } = applyMachineSpecs(project, specs);
      return { project: next, machines, warnings, ...(args.dryRun ? { manifests: specs.map(machineFromSpec) } : {}) };
    });
  }
  if (name === "machine_spec") {
    const project = parseProject(await readFile(path, "utf8"));
    const machine = (project.extensions.machines ?? []).find((m) => m?.id === args.machine);
    if (!machine) throw new Error(`No machine ${args.machine}. Machines: ${(project.extensions.machines ?? []).map((m) => m?.id).join(", ") || "none"}.`);
    return specFromMachine(machine);
  }
  if (name === "import_mtraj_route") {
    const specs = routeSpecs(args.spec);
    const base = dirname(path);
    const files = new Map();
    for (const spec of specs)
      for (const pass of spec.passes ?? []) {
        if (typeof pass?.mtraj !== "string") throw new Error(`Routine ${spec.routine}: every pass needs an "mtraj" path.`);
        const file = resolve(base, pass.mtraj);
        if (!files.has(file)) files.set(file, JSON.parse(await readFile(file, "utf8")));
      }
    return updateProject(path, args, (project) => {
      const routines = [], warnings = [];
      for (const spec of specs) {
        const result = routineFromMtraj(project, spec, (p) => files.get(resolve(base, p)));
        project = result.project;
        routines.push({ routine: result.routine, steps: result.steps });
        warnings.push(...result.warnings);
      }
      return {
        project,
        routines,
        warnings,
        ...(args.dryRun ? { preview: project.routines.filter((r) => specs.some((s) => s.routine === r.id)) } : {}),
      };
    });
  }
  if (name === "export_cpp")
    return { code: exportCpp(parseProject(await readFile(path, "utf8"))) };
  if (name === "inspect_project")
    return parseProject(await readFile(path, "utf8"));
  if (name === "save_project") {
    const project = parseProject(JSON.stringify(args.project));
    await mkdir(dirname(path), { recursive: true });
    const lock = await open(path + ".lock", "wx");
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      let previous = null;
      try {
        previous = parseProject(await readFile(path, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (args.expectedRevision !== (previous?.revision ?? null))
        throw new Error(
          `Revision conflict: current revision is ${previous?.revision ?? "new"}. Re-read before editing.`,
        );
      project.revision = previous ? previous.revision + 1 : 0;
      await writeFile(temporary, JSON.stringify(project, null, 2) + "\n");
      await rename(temporary, path);
      return { path, revision: project.revision };
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(path + ".lock");
    }
  }
  if (name === "simulate_auto") {
    const project = parseProject(await readFile(path, "utf8"));
    const routine = args.routine
      ? project.routines.find((r) => r.id === args.routine)
      : project.routines[0];
    if (!routine) throw new Error("Routine ID does not exist.");
    const signals = Object.fromEntries(
      project.signals.map((s) => [s.key, s.initial]),
    );
    for (const [key, value] of Object.entries(args.signals ?? {})) {
      const definition = project.signals.find((s) => s.key === key);
      if (
        !definition ||
        typeof value !== definition.type ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new Error(`Invalid signal ${key}`);
      signals[key] = value;
    }
    if (
      args.maxSeconds !== undefined &&
      (!Number.isFinite(args.maxSeconds) ||
        args.maxSeconds <= 0 ||
        args.maxSeconds > 600)
    )
      throw new Error("maxSeconds must be in (0,600].");
    if (args.mode !== undefined && !["path", "routine"].includes(args.mode)) throw new Error("mode must be path or routine.");
    if (args.actions !== undefined) {
      const callbacks = new Set(routine.nodes.flatMap(node => [...(node.during ?? []), ...(node.action ? [node.action] : [])]));
      if (!args.actions || typeof args.actions !== "object" || Array.isArray(args.actions)) throw new Error("actions must map callback IDs to statuses.");
      for (const [id, status] of Object.entries(args.actions))
        if (!callbacks.has(id) || !["running", "succeeded", "failed"].includes(status)) throw new Error(`Invalid action status for ${id}`);
    }
    const result = simulate(project, routine, signals, args);
    return {
      mode: args.mode ?? "routine",
      status: result.status,
      time: result.frame.time,
      pose: result.frame.pose,
      events: result.frame.events,
      steps: result.frames.length - 1,
      // Event markers (pickups) that fire with the robot front > 45° off its travel direction.
      headingWarnings: headingLints(result.frames, undefined, (id) => routine.nodes.find((n) => n.id === id)?.name ?? id)
        .map(({ time, key, node, degrees, message }) => ({ time, key, node, degrees: Math.round(degrees), message })),
    };
  }
  if (
    ["list_log_channels", "log_table", "log_anomalies", "log_what_changed", "log_events", "log_states"].includes(name)
  ) {
    const recording = await loadLog(path, args.mapping);
    if (name === "log_states") return machineStates(recording, args);
    if (name === "list_log_channels") return listChannels(recording, args);
    if (name === "log_table") return logTable(recording, args);
    if (name === "log_anomalies") return findAnomalies(recording, args);
    if (name === "log_what_changed") return whatChanged(recording, args);
    return logEvents(recording, args);
  }
  if (name === "analyze_log") {
    const bytes = await readFile(path);
    const recording = path.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          path,
        )
      : parseRecordingJSON(bytes.toString("utf8"));
    const result = analyze(recording, args.mapping, args.policy);
    if (args.detail === "full")
      return {
        name: recording.name,
        duration: recording.duration,
        channels: recording.channels.map((c) => ({ name: c.name, type: c.type, samples: c.samples.length })),
        warnings: recording.warnings,
        ...result,
      };
    const { estimatedCurrent, ...rest } = result;
    const from = Number.isFinite(args.from) ? args.from : -Infinity;
    const to = Number.isFinite(args.to) ? args.to : Infinity;
    const maxSamples = args.maxSamples ?? 40;
    const maxChannels = args.maxChannels ?? 30;
    const pool = estimatedCurrent
      ? [...recording.channels, estimatedCurrent]
      : recording.channels;
    const byType = {};
    for (const c of recording.channels) {
      const e = (byType[c.type] ??= { count: 0, withSamples: 0 });
      e.count++;
      if (c.samples.length) e.withSamples++;
    }
    const prefixes = {};
    for (const c of recording.channels) {
      const key = c.name.split("/").slice(0, 3).join("/");
      prefixes[key] = (prefixes[key] ?? 0) + 1;
    }
    const out = {
      name: recording.name,
      duration: recording.duration,
      warnings: recording.warnings,
      ...rest,
      channelOverview: {
        total: recording.channels.length,
        byType,
        topPrefixes: Object.entries(prefixes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([prefix, count]) => ({ prefix, count })),
      },
      topCurrentDraws: currentBreakdown(
        recording,
        rest.mapping?.current,
        12,
        rest.power?.currentChannels,
      ),
    };
    if (estimatedCurrent)
      out.estimatedCurrentSummary = channelStats(estimatedCurrent, from, to, maxSamples);
    if (Array.isArray(args.channels) && args.channels.length) {
      const needles = args.channels.map((n) => String(n).toLowerCase());
      const matched = pool.filter((c) =>
        needles.some((n) => c.name.toLowerCase().includes(n)),
      );
      out.query = {
        window: { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : recording.duration },
        matched: matched.length,
        truncated: matched.length > maxChannels,
        channels: matched.slice(0, maxChannels).map((c) => channelStats(c, from, to, maxSamples)),
      };
    }
    return out;
  }
  throw new Error(`Unknown tool ${name}`);
}
async function main() {
  const [command, path, json] = process.argv.slice(2);
  if (command === "mcp") {
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      let request;
      try {
        request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result;
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mayhem-suite", version: "0.1.0" },
            instructions:
              "Use live-pose goals and measured-condition transitions by default. You may implement arbitrary C++ and custom action callbacks. The visual model documents behavior, not a restriction on capabilities. See docs/SUITE_AGENTS.md.",
          };
        else if (request.method === "tools/list") result = { tools };
        else if (request.method === "tools/call") {
          try {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    await execute(
                      request.params.name,
                      request.params.arguments ?? {},
                    ),
                  ),
                },
              ],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        } else if (request.method === "ping") result = {};
        else {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            }) + "\n",
          );
          continue;
        }
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32700, message: error.message },
          }) + "\n",
        );
      }
    }
    return;
  }
  if (command === "cpp") {
    // cpp <project> [--out <header>] [--check <header>]
    const flags = process.argv.slice(4);
    let out, check;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--out" && flags[i + 1]) out = flags[++i];
      else if (flags[i] === "--check" && flags[i + 1]) check = flags[++i];
      else throw new Error("Usage: node scripts/mayhem.mjs cpp <project> [--out <header>] [--check <header>]");
    }
    const { code } = await execute("export_cpp", { path });
    if (check) {
      let current = null;
      try {
        current = (await readFile(check, "utf8")).replace(/\r\n/g, "\n");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (current !== code) {
        console.error(`${check} is ${current === null ? "missing" : "stale"}. Regenerate: node scripts/mayhem.mjs cpp ${path} --out ${check}`);
        process.exitCode = 1;
      }
      return;
    }
    if (out) {
      // Leave an up-to-date header untouched so builds do not recompile it.
      const current = await readFile(out, "utf8").catch(() => null);
      if (current !== code) {
        await mkdir(dirname(resolve(out)), { recursive: true });
        const temporary = `${out}.${process.pid}.tmp`;
        await writeFile(temporary, code);
        await rename(temporary, out);
      }
      return;
    }
    process.stdout.write(code);
    return;
  }
  if (command === "machine" || command === "route") {
    // machine apply <project> <spec> | machine spec <project> <id> | route import-mtraj <project> <spec>
    const [sub, project, specArg, ...flags] = process.argv.slice(3);
    const usage = "Usage: node scripts/mayhem.mjs machine apply <project> <spec.json|-|JSON> [--dry-run] [--expect-revision N] | machine spec <project> <machine id> | route import-mtraj <project> <spec.json|-|JSON> [--dry-run] [--expect-revision N]";
    if (!project || !specArg) throw new Error(usage);
    if (command === "machine" && sub === "spec") {
      console.log(JSON.stringify(await execute("machine_spec", { path: project, machine: specArg }), null, 2));
      return;
    }
    const tool = command === "machine" && sub === "apply" ? "apply_machine_spec" : command === "route" && sub === "import-mtraj" ? "import_mtraj_route" : null;
    if (!tool) throw new Error(usage);
    const args = { path: project };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--dry-run") args.dryRun = true;
      else if (flags[i] === "--expect-revision" && /^\d+$/.test(flags[i + 1] ?? "")) args.expectedRevision = Number(flags[++i]);
      else throw new Error(usage);
    }
    const text =
      specArg === "-"
        ? await new Promise((done) => { let t = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (t += c)); process.stdin.on("end", () => done(t)); })
        : /^\s*[[{]/.test(specArg) ? specArg : await readFile(specArg, "utf8");
    args.spec = JSON.parse(text);
    console.log(JSON.stringify(await execute(tool, args), null, 2));
    return;
  }
  if (command === "vendor") {
    // vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check]
    const flags = process.argv.slice(4);
    const options = {};
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--check") options.check = true;
      else if ((flags[i] === "--dest" || flags[i] === "--snapshot") && flags[i + 1]) options[flags[i].slice(2)] = flags[++i];
      else throw new Error("Usage: node scripts/mayhem.mjs vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check]");
    }
    const result = await vendorCpp(path, options);
    if (options.check && !result.upToDate) {
      console.error(`Vendored Mayhem C++ headers are stale:\n  ${result.problems.join("\n  ")}\nRun: node scripts/mayhem.mjs vendor ${path}${options.dest ? ` --dest ${options.dest}` : ""}${options.snapshot ? ` --snapshot ${options.snapshot}` : ""}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "review") {
    // review <repo> [before] [after] [--json]
    const rest = process.argv.slice(4);
    const full = rest.includes("--json");
    const [before, after] = rest.filter((a) => a !== "--json");
    const result = await behaviorDiff({ repo: path, before, after, detail: full ? "full" : "summary" });
    if (full) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.before.label}\n  → ${result.after.label}\nRisk: ${result.level}`);
      for (const f of result.findings) console.log(`  [${f.level}] ${f.area}: ${f.text}`);
      for (const e of result.errors) console.log(`  error: ${e}`);
    }
    return;
  }
  if (command === "sim") {
    // sim <repo> [after] [--before <rev>] [--only button,auto,custom] [--json]
    const rest = process.argv.slice(4);
    const args = { repo: path };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--before") args.before = rest[++i];
      else if (rest[i] === "--only") args.groups = rest[++i].split(",");
      else if (rest[i] === "--json") args.json = true;
      else args.after = rest[i];
    }
    const result = await runScenarios(args, (text, done, total) => process.stderr.write(`\r${done}/${total} ${text.padEnd(60).slice(0, 60)}`));
    process.stderr.write("\n");
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.passed ? "PASSED" : "FAILED"}${args.before ? ` · ${result.changed} scenario(s) behave differently` : ""}`);
      for (const r of result.results) {
        if (!r.failed && !r.differences) continue;
        console.log(`  ${r.failed ? "✗" : "≠"} ${r.scenario}`);
        for (const c of r.checks ?? []) if (!c.pass) console.log(`      expected: ${c.text} — ${c.detail}`);
        for (const d of r.differences ?? []) console.log(`      ${d}`);
        if (r.error) console.log(`      ${r.error.split("\n")[0]}`);
      }
      for (const e of result.errors) console.log(`  error: ${e}`);
    }
    return;
  }
  if (command === "example") {
    console.log(JSON.stringify(sampleProject, null, 2));
    return;
  }
  const names = {
    inspect: "inspect_project",
    validate: "validate_project",
    save: "save_project",
    simulate: "simulate_auto",
    analyze: "analyze_log",
    cpp: "export_cpp",
    live: "inspect_live_robot",
    open: "open_in_app",
  };
  if (!names[command])
    throw new Error(
      "Usage: node scripts/mayhem.mjs example | review <robot repo> [before] [after] [--json] | sim <robot repo> [after] [--before <rev>] [--only button,auto,custom] [--json] | inspect <file> | validate <file> | simulate <file> [options JSON] | analyze <log> [options JSON] | save <file> <{project,expectedRevision}> | cpp <file> [--out <header>] [--check <header>] | vendor <robot dir> [--dest <dir>] [--snapshot <file>] [--check] | machine apply <file> <spec> [--dry-run] | machine spec <file> <machine> | route import-mtraj <file> <spec> [--dry-run] | open <file> | live <robot-address> [options JSON] | mcp",
    );
  const args = { ...(json ? JSON.parse(json) : {}), path };
  if (command === "validate")
    args.project = JSON.parse(await readFile(path, "utf8"));
  if (command === "live") args.host = path;
  const result = await execute(names[command], args);
  console.log(
    command === "cpp" ? result.code : JSON.stringify(result, null, 2),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
