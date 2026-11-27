// The outer loop ("factory"): run by a person, it finds what's wrong on main, sorts it into NEW and PRE-EXISTING against a baseline, and hands each
// NEW problem to an agent on its own branch. The agent fixes it test-first; the factory then runs
// the same gate a person would trust (verify_change) itself, sends the agent the reasons when it
// fails, and leaves a branch that passes for a person to review in the Mayhem app (or opens a PR).
// It never merges: on a robot, a person decides what goes on main.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (repo, args) => (await run("git", ["-C", repo, ...args], { maxBuffer: 64 << 20 })).stdout.trim();
const MAYHEM = join(dirname(fileURLToPath(import.meta.url)), "mayhem.mjs");
const SEVERITY = ["high", "medium", "low"];

/** Team settings in the robot repo: tools/mayhem/factory.json. */
export const FACTORY_FILE = "tools/mayhem/factory.json";
const DEFAULTS = { max: 3, rounds: 3, ignore: [], includeExisting: false, minSeverity: "medium", agentTimeoutMinutes: 45 };

export function stateDir(repo) {
  return join(homedir(), ".mayhem", "factory", `${basename(repo)}-${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`);
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Every problem on one side of a sim proof (`after` is main, `before` the baseline), keyed by an
 * id that is the same in both runs: failed scenarios, log_diagnose findings in each scenario's log
 * (errors high, warnings medium), and auto motion issues.
 */
export async function findingsOf(sim, side, diagnose, ignore = []) {
  const out = new Map();
  const add = (f) => {
    if (ignore.some((i) => f.id.includes(i) || f.kind === i)) return;
    const seen = out.get(f.id);
    if (seen) seen.scenarios = [...new Set([...seen.scenarios, ...f.scenarios])];
    else out.set(f.id, f);
  };
  for (const r of sim.results) {
    const failed = side === "after" ? r.failed : r.beforeFailed;
    if (failed)
      add({
        id: `scenario:${r.scenario}`,
        kind: "scenario-fails",
        severity: "high",
        title: `“${r.scenario}” fails`,
        detail: side === "after" ? (r.error?.split("\n")[0] ?? (r.checks ?? []).filter((c) => !c.pass).map((c) => `${c.text}: ${c.detail}`).join("; ")) : "fails on the baseline",
        scenarios: [r.scenario],
      });
    const log = r.logs?.[side];
    if (!log) continue;
    let diagnosis;
    try {
      diagnosis = await diagnose(log);
    } catch {
      continue; // a log the diagnosis can't read is not a finding
    }
    for (const f of diagnosis.findings ?? [])
      if (f.severity !== "info")
        add({ id: `diagnose:${f.id}`, kind: f.kind, severity: f.severity === "error" ? "high" : "medium", title: f.title, detail: f.detail, scenarios: [r.scenario], log, ...(f.next ? { next: f.next } : {}) });
  }
  return [...out.values()];
}

/** Model-check problems: unknown inputs and loops are high, the rest medium. */
export function modelFindings(problems) {
  return problems.map((p) => ({ id: `model:${p.id}`, kind: p.kind, severity: p.kind === "loops" || p.kind === "unknown-input" ? "high" : "medium", title: p.text.split(":")[0] + `: ${p.kind}`, detail: p.text, scenarios: [], ...(p.inputs ? { inputs: p.inputs } : {}) }));
}

/** NEW (not on the baseline) first, then by severity; the rest are PRE-EXISTING. */
export function classify(current, baseline) {
  const known = baseline ? new Set(baseline.map((f) => f.id)) : undefined;
  const order = (a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity);
  const fresh = current.filter((f) => !known || !known.has(f.id)).sort(order);
  const existing = current.filter((f) => known?.has(f.id)).sort(order);
  return { new: fresh, existing, fixed: baseline ? baseline.filter((f) => !current.some((c) => c.id === f.id)) : [] };
}

const counts = (list) => SEVERITY.map((s) => `${list.filter((f) => f.severity === s).length} ${s}`).join(", ");

/** The report, in the shape of a thread: the summary, then one entry per finding, NEW first. */
export function reportText({ repo, main, baseline, sorted, dispatched }) {
  const lines = [
    `# Mayhem factory: ${basename(repo)} at ${main.slice(0, 7)}`,
    "",
    `We ran the full sim proof on main at ${main.slice(0, 7)}${baseline ? ` and compared every finding with ${baseline.label}` : " (no baseline: every finding counts as new)"}.`,
    `NEW: ${sorted.new.length} (${counts(sorted.new)}). PRE-EXISTING: ${sorted.existing.length} (${counts(sorted.existing)}).${sorted.fixed.length ? ` FIXED since the baseline: ${sorted.fixed.length}.` : ""}`,
    "",
  ];
  const entry = (tag) => (f) => {
    const d = dispatched.find((x) => x.finding.id === f.id);
    lines.push(`## [${tag}] [${f.severity}] ${f.title}`, "", `id \`${f.id}\``, "", f.detail, "");
    if (f.scenarios.length) lines.push(`Scenarios: ${f.scenarios.map((s) => `“${s}”`).join(", ")}`, "");
    if (d) lines.push(`Agent: ${d.status}${d.branch ? ` on \`${d.branch}\`` : ""}${d.pr ? ` (${d.pr})` : ""}${d.reasons?.length ? `\n\n${d.reasons.map((r) => `- ${r}`).join("\n")}` : ""}`, "");
  };
  sorted.new.forEach(entry("NEW"));
  sorted.existing.forEach(entry("PRE-EXISTING"));
  return lines.join("\n");
}

/** What the agent is told for one finding. */
export function agentPrompt(finding, { repo, base }) {
  const mayhem = `node ${MAYHEM}`;
  return [
    `The Mayhem factory found this problem on ${base} of this robot repository. Fix it on the current branch (already created for you), test first.`,
    "",
    "Finding:",
    JSON.stringify(finding, null, 2),
    "",
    "How:",
    `1. Reproduce it with a scenario that fails on the unfixed code: ${mayhem} tool run_scenarios '{"repo":".","after":"WORKTREE","before":"HEAD","scenarios":[{"name":"…","steps":[…],"expect":[…]}]}'. Its tests verdict must be still-failing (it catches the problem). Scenario format: docs in ${resolve(MAYHEM, "../../docs/SUITE_AGENTS.md")} ("Sim proof"). For a model-check finding, check it with ${mayhem} check . and reproduce the behavior it describes in a scenario.`,
    finding.log ? `   The log that shows it: ${finding.log}. Start with ${mayhem} diagnose ${finding.log}${finding.next ? ` and ${JSON.stringify(finding.next)}` : ""}.` : "",
    "2. Fix the cause in the robot code (not the symptom; no timers, retries or comments that explain a workaround). Run the scenario again until its verdict is red-green.",
    "3. Add the scenario to tools/mayhem/scenarios.json, commit everything on this branch.",
    `4. Run the gate: ${mayhem} verify . HEAD --base ${base} --by factory-agent. Keep going until it prints READY.`,
    "",
    "Never: remove or loosen an existing scenario, edit tools/mayhem/factory.json, push, merge, or touch main.",
    `If the finding is a simulation artifact or can't be fixed in this repository, commit nothing and end with a line "FACTORY: skip <why>".`,
  ]
    .filter(Boolean)
    .join("\n");
}

function runAgent({ cwd, prompt, resume, timeoutMinutes, agent }) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(node:*)",
    "Bash(git:*)",
    "Bash(./gradlew:*)",
    "Bash(ls:*)",
    ...(resume ? ["--resume", resume] : []),
  ];
  return new Promise((done) => {
    const child = spawn(agent, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMinutes * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        parsed = undefined;
      }
      done({ code, session: parsed?.session_id, text: String(parsed?.result ?? out).slice(-4000) });
    });
  });
}

/** One finding, one branch, one agent: write → verify (by the factory) → fix the reasons → … */
async function dispatch(finding, ctx) {
  const branch = `factory/${slug(finding.id)}`;
  if (await git(ctx.repo, ["branch", "--list", branch]))
    return { finding, branch, status: "skipped", reasons: ["A factory branch for this finding already exists: review or delete it first."] };
  const dir = join(ctx.state, "worktrees", slug(finding.id));
  await rm(dir, { recursive: true, force: true });
  await git(ctx.repo, ["worktree", "add", "-b", branch, dir, ctx.main]);
  try {
    let session, reasons = [], text = "";
    for (let round = 1; round <= ctx.config.rounds; round++) {
      const prompt = round === 1 ? agentPrompt(finding, { repo: ctx.repo, base: ctx.base }) : `The gate says this branch is not ready:\n${reasons.map((r) => `- ${r}`).join("\n")}\nFix the first reason, commit, and run the gate again.`;
      ctx.log(`  agent round ${round} on ${branch}`);
      const result = await runAgent({ cwd: dir, prompt, resume: session, timeoutMinutes: ctx.config.agentTimeoutMinutes, agent: ctx.agent });
      session = result.session ?? session;
      text = result.text;
      const skip = /FACTORY: skip (.*)/.exec(text);
      const ahead = Number(await git(dir, ["rev-list", "--count", `${ctx.main}..HEAD`]));
      if (skip && !ahead) return { finding, branch: undefined, status: "skipped", reasons: [skip[1]], cleanup: branch };
      if (!ahead) {
        reasons = ["Nothing was committed on the branch."];
        continue;
      }
      // The factory's own check, not the agent's account of it.
      const verdict = await ctx.verify({ repo: dir, base: ctx.main, after: "HEAD", by: "mayhem factory" });
      if (verdict.ready) {
        const pr = ctx.pr ? await openPullRequest(ctx, dir, branch, finding, verdict) : undefined;
        return { finding, branch, status: "ready", fixes: verdict.fixes ?? [], warnings: verdict.warnings, ...(pr ? { pr } : {}) };
      }
      reasons = verdict.reasons;
    }
    return { finding, branch, status: "not-ready", reasons, agent: text.slice(-800) };
  } finally {
    await git(ctx.repo, ["worktree", "remove", "--force", dir]).catch(() => {});
  }
}

async function openPullRequest(ctx, dir, branch, finding, verdict) {
  await git(dir, ["push", "-u", "origin", branch]);
  await git(dir, ["push", "origin", "refs/notes/mayhem-proof"]).catch(() => {});
  const body = [
    `Found by the Mayhem factory on main at ${ctx.main.slice(0, 7)}: **[${finding.severity}] ${finding.title}**`,
    "",
    finding.detail,
    "",
    `Sim proof: ${verdict.recorded?.summary ?? "recorded on the head commit"}`,
    ...verdict.tests.filter((t) => t.verdict === "red-green").map((t) => `- red → green: “${t.scenario}”`),
    ...(verdict.warnings.length ? ["", "Warnings:", ...verdict.warnings.map((w) => `- ${w}`)] : []),
    "",
    "Review it in the Mayhem app (Changes). The factory never merges.",
  ].join("\n");
  const { stdout } = await run("gh", ["pr", "create", "--head", branch, "--base", ctx.baseBranch, "--title", `Fix: ${finding.title}`.slice(0, 120), "--body", body], { cwd: dir });
  return stdout.trim();
}

/** The baseline to compare with: --baseline, else the newest tag on main, else the last run's main. */
async function baselineOf(repo, main, explicit, last) {
  if (explicit) return { rev: await git(repo, ["rev-parse", explicit]), label: explicit };
  const tag = await git(repo, ["describe", "--tags", "--abbrev=0", `${main}^`]).catch(() => "");
  if (tag) return { rev: await git(repo, ["rev-parse", `${tag}^{commit}`]), label: tag };
  if (last?.main && last.main !== main) return { rev: last.main, label: `the last factory run (${last.main.slice(0, 7)})` };
  return undefined;
}

/**
 * deps: { runScenarios, verifyChange, modelDiff, gitShow, diagnose(log) , mainRef } from mayhem.mjs.
 * args: { repo, baseline?, max?, rounds?, pr?, dryRun?, agent?, includeExisting? }
 */
export async function runFactory(deps, args, log = (t) => process.stderr.write(`${t}\n`)) {
  const repo = resolve(args.repo);
  const state = stateDir(repo);
  await mkdir(state, { recursive: true });
  const last = JSON.parse(await readFile(join(state, "last.json"), "utf8").catch(() => "null"));
  const ref = await deps.mainRef(repo);
  if (!ref) throw new Error("No main branch in this repository.");
  const main = ref.sha;
  const configText = await deps.gitShow(repo, main, FACTORY_FILE);
  const config = { ...DEFAULTS, ...(configText ? JSON.parse(configText) : {}), ...Object.fromEntries(Object.entries({ max: args.max, rounds: args.rounds, includeExisting: args.includeExisting }).filter(([, v]) => v !== undefined)) };
  const baseline = await baselineOf(repo, main, args.baseline, last);
  log(`Factory: main ${main.slice(0, 7)}${baseline ? `, baseline ${baseline.label}` : ", no baseline"}`);

  const sim = await deps.runScenarios({ repo, after: main, ...(baseline ? { before: baseline.rev } : {}), by: "mayhem factory" }, (text, done, total) => log(`  ${done}/${total} ${text}`));
  const ignore = config.ignore ?? [];
  const current = await findingsOf(sim, "after", deps.diagnose, ignore);
  const previous = baseline ? await findingsOf(sim, "before", deps.diagnose, ignore) : undefined;
  const model = deps.modelDiff(baseline ? await deps.gitShow(repo, baseline.rev, "tools/mayhem/machines.json") : undefined, await deps.gitShow(repo, main, "tools/mayhem/machines.json"));
  current.push(...modelFindings([...model.new, ...model.existing]));
  previous?.push(...modelFindings([...model.existing, ...model.fixed]));
  const unique = [...new Map(current.map((f) => [f.id, f])).values()];
  const sorted = classify(unique, previous);

  const rank = (s) => SEVERITY.indexOf(s);
  const targets = [...sorted.new, ...(config.includeExisting ? sorted.existing : [])]
    .filter((f) => rank(f.severity) <= rank(args.minSeverity ?? config.minSeverity));
  const dispatched = [];
  let coveredState;
  if (!args.dryRun) {
    const ctx = { repo, state, main, base: main, baseBranch: ref.rev.replace(/^origin\//, ""), config, pr: !!args.pr, agent: args.agent ?? "claude", verify: deps.verifyChange, log };
    // Findings a branch already fixes (from an earlier run or this one): one cause, one agent.
    const covered = new Map(Object.entries(last?.covered ?? {}));
    for (const [id, branch] of covered) if (!(await git(repo, ["branch", "--list", branch]))) covered.delete(id);
    for (const f of targets) {
      if (covered.has(f.id)) {
        dispatched.push({ finding: f, branch: covered.get(f.id), status: "covered" });
        log(`Covered by ${covered.get(f.id)}: ${f.title}`);
        continue;
      }
      if (dispatched.filter((d) => d.status !== "covered").length >= config.max) break;
      log(`Dispatching [${f.severity}] ${f.title}`);
      const d = await dispatch(f, ctx);
      if (d.cleanup) await git(repo, ["branch", "-D", d.cleanup]).catch(() => {});
      delete d.cleanup;
      dispatched.push(d);
      log(`  → ${d.status}${d.branch ? ` (${d.branch})` : ""}`);
      if (d.status === "ready") {
        covered.set(f.id, d.branch);
        for (const name of d.fixes) covered.set(`scenario:${name}`, d.branch);
      }
    }
    coveredState = Object.fromEntries(covered);
  }
  const at = new Date().toISOString();
  const report = reportText({ repo, main, baseline, sorted, dispatched });
  const stamp = at.replace(/[:.]/g, "-");
  await mkdir(join(state, "runs"), { recursive: true });
  const result = { at, main, baseline, new: sorted.new, existing: sorted.existing, fixed: sorted.fixed, dispatched, ...(args.dryRun ? { dryRun: true, wouldDispatch: targets.slice(0, config.max).map((f) => f.id) } : {}) };
  await writeFile(join(state, "runs", `${stamp}.json`), JSON.stringify(result, null, 2));
  await writeFile(join(state, "runs", `${stamp}.md`), report);
  await writeFile(join(state, "last.json"), JSON.stringify({ at, main, covered: coveredState ?? last?.covered ?? {} }));
  return { ...result, report: join(state, "runs", `${stamp}.md`), text: report };
}
