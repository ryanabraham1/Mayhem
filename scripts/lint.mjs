// Mayhem's own lint. Each rule is a correction made once and checked forever after, instead of a
// line in CLAUDE.md that an agent may or may not read. When you correct an agent (or it corrects
// itself), add the rule here first, with a message that names the root fix, then fix the code.
//
//   node scripts/lint.mjs            every tracked and new file; exit 1 on a problem
//   node scripts/lint.mjs --json     the same as JSON
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE = "app/src/suite/core/";
const LOG_CORE = ["analysis.ts", "wpilog.ts", "plot.ts"].map((f) => CORE + f);
const CODE = /\.(ts|tsx|mjs|js)$/;
const imports = (text) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
const resolved = (from, spec) => normalize(join(dirname(from), spec));

/**
 * Each rule: `files` picks paths, `check(path, text)` returns problems ({ line, text }). `message`
 * says what to do instead (the root fix), `from` the correction it came from.
 */
export const RULES = [
  {
    id: "core-is-portable",
    from: "core runs in the CLI/MCP server, the log worker and the 3256-Tools site, not only in the app",
    files: (p) => p.startsWith(CORE) && CODE.test(p) && !p.includes(".test."),
    message: "Code in app/src/suite/core may import only other core files and type-only libraries. Move UI, desktop (Tauri) and browser code to the page that uses it and pass the data into core.",
    check: (path, text) =>
      imports(text)
        .filter((spec) => (spec.startsWith(".") ? !resolved(path, spec).startsWith(CORE) : /^(react|react-dom|@tauri-apps|lucide-react|zustand)\b/.test(spec)))
        .map((spec) => ({ text: `imports ${spec}` })),
  },
  {
    id: "log-core-standalone",
    from: "CLAUDE.md: analysis.ts, wpilog.ts and plot.ts are copied into 3256-Tools by scripts/sync-team-log-core.mjs",
    files: (p) => LOG_CORE.includes(p),
    message: "analysis.ts, wpilog.ts and plot.ts are synced to 3256-Tools as three files on their own: they may import only ./analysis.ts. Put anything else they need in one of the three, or keep it in the caller.",
    check: (_path, text) => imports(text).filter((spec) => spec !== "./analysis.ts").map((spec) => ({ text: `imports ${spec}` })),
  },
  {
    id: "scripts-use-core",
    from: "the CLI and MCP server must not depend on React pages",
    files: (p) => /^scripts\/[^/]+\.mjs$/.test(p),
    message: "Scripts (the CLI and MCP server) may only use app/src/suite/core. Move the logic you need out of the page into core and import it from both.",
    check: (_path, text) => [...text.matchAll(/["'](?:\.\.\/)+app\/src\/([^"']+)["']/g)].map((m) => m[1]).filter((p) => !p.startsWith("suite/core/")).map((p) => ({ text: `imports app/src/${p}` })),
  },
  {
    id: "no-deferred-fix",
    from: "quick fixes considered harmful: setTimeout(…, 0) to 'fix' a flicker gets copied everywhere",
    files: (p) => p.startsWith("app/src/") && CODE.test(p),
    message: "Deferring work to the next tick (setTimeout 0, queueMicrotask) hides an ordering bug instead of fixing it. Find what runs in the wrong order (an effect, a store update, an event) and fix that.",
    check: (_path, text) => lines(text, /\bsetTimeout\s*\((?:[^()]|\([^()]*\))*?,\s*0\s*\)|\bsetTimeout\s*\(\s*[^,()]+\s*\)|\bqueueMicrotask\s*\(/),
  },
  {
    id: "no-workaround-comments",
    from: "comments that justify a workaround give the next agent permission to copy it",
    files: (p) => (p.startsWith("app/src/") || p.startsWith("scripts/") || p.startsWith("lib-cpp/")) && /\.(ts|tsx|mjs|js|cpp|h)$/.test(p),
    message: "A comment that explains a workaround (hack, for now, temporary, in case, quick fix) is a fix that was not made. Fix the cause, or delete the code; don't explain it.",
    check: (_path, text) => lines(text, /(?:\/\/|\/\*|\*)\s.*\b(hack|hacky|workaround|work around|quick fix|for now|temporary fix|in case it comes back|xxx)\b/i),
  },
  {
    id: "no-focused-tests",
    from: "a focused or unconditionally skipped test silently turns the rest of the suite off",
    files: (p) => /^app\/(tests|e2e)\//.test(p) && CODE.test(p),
    message: "Remove .only, and skip a test only on a condition with a reason (test.skip(!repo, \"needs a robot repo\")). Fix or delete a failing test instead of skipping it.",
    check: (_path, text) => lines(text, /\b(?:it|test|describe)\.only\s*\(|\b(?:it|test|describe)\.skip\s*\(\s*["'`]/),
  },
  {
    id: "no-unsolicited-markdown",
    from: "stop agents from writing unsolicited markdown: notes and summaries belong in the PR or the docs page",
    files: (p) => p.endsWith(".md"),
    message: "Don't add Markdown files for notes, plans or summaries. Put the content in the docs page it belongs to (docs/, site/), the pull request, or your reply. A new docs page goes in docs/ or site/.",
    check: (path) =>
      /^(docs|site)\//.test(path) || ["README.md", "CLAUDE.md", "THIRD_PARTY_NOTICES.md"].includes(path) || /(^|\/)README\.md$/.test(path) ? [] : [{ text: "Markdown file outside docs/ and site/" }],
  },
];

function lines(text, pattern) {
  const out = [];
  text.split("\n").forEach((l, i) => pattern.test(l) && out.push({ line: i + 1, text: l.trim().slice(0, 120) }));
  return out;
}

/** Problems in `files` ({ path, text }), as { rule, path, line?, text, message }. */
export function lintFiles(files, rules = RULES) {
  const out = [];
  for (const { path, text } of files)
    for (const rule of rules) if (rule.files(path)) for (const p of rule.check(path, text)) out.push({ rule: rule.id, path, ...p, message: rule.message });
  return out;
}

function repoFiles(root) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return listed
    .split("\0")
    .filter((p) => p && !p.includes("node_modules/") && (CODE.test(p) || /\.(md|cpp|h)$/.test(p)))
    .flatMap((path) => {
      try {
        return [{ path, text: readFileSync(join(root, path), "utf8") }];
      } catch {
        return []; // deleted, not yet committed
      }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = lintFiles(repoFiles(root));
  if (process.argv.includes("--json")) console.log(JSON.stringify(problems, null, 2));
  else {
    for (const p of problems) console.log(`${p.path}${p.line ? `:${p.line}` : ""}  [${p.rule}] ${p.text}\n    ${p.message}`);
    console.log(problems.length ? `\n${problems.length} problem(s).` : "Lint: no problems.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
