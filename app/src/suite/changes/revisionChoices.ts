/**
 * The version picker's list: a few obvious choices first, then each branch once (this computer's
 * copy and GitHub's merged), newest first, then tags and recent commits. Long lists show their
 * newest few until someone searches or asks for more.
 */
import { WORKTREE } from "../core/review/report.ts";
import type { RepoInfo, Revision } from "./useReview.ts";

export interface Choice {
  /** What the review compares (a branch name, remote ref, sha, HEAD or WORKTREE). */
  value: string;
  title: string;
  detail: string;
  /** ISO date of the commit, when known. */
  date?: string;
  /** Short notes: "only on GitHub", "GitHub is newer", … */
  notes: string[];
  /** Indented under the branch above (GitHub's copy when it differs). */
  child?: boolean;
}
export interface Section {
  title: string;
  choices: Choice[];
  /** Choices left out until "show more" (or a search). */
  hidden: number;
}

/** How many branches (and commits) show before "show more". */
export const SHOWN = 8;

const REMOTE = /^[^/]+\//;

export function ago(date: string | undefined, now = Date.now()) {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400 / 7)} wk ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const newest = (a?: string, b?: string) => (Date.parse(b ?? "") || 0) - (Date.parse(a ?? "") || 0);

/** One entry per branch name: this computer's copy, GitHub's, or both. */
function branches(revisions: Revision[]): Choice[] {
  const byName = new Map<string, { local?: Revision; remote?: Revision }>();
  for (const r of revisions) {
    if (r.kind === "branch") (byName.get(r.rev) ?? byName.set(r.rev, {}).get(r.rev)!).local = r;
    else if (r.kind === "remote") {
      // "origin" alone is GitHub's default-branch pointer, already listed as origin/main.
      if (!REMOTE.test(r.rev) || r.rev.endsWith("/HEAD")) continue;
      const name = r.rev.replace(REMOTE, "");
      const entry = byName.get(name) ?? byName.set(name, {}).get(name)!;
      entry.remote ??= r;
    }
  }
  const out: { choice: Choice; extra?: Choice }[] = [];
  for (const [name, { local, remote }] of byName) {
    const main = local ?? remote!;
    const notes: string[] = [];
    let extra: Choice | undefined;
    if (!local) notes.push("only on GitHub");
    else if (!remote) notes.push("only on this computer");
    else if (local.sha !== remote.sha) {
      const githubNewer = newest(local.date, remote.date) > 0;
      notes.push(githubNewer ? "GitHub has newer commits" : "not pushed to GitHub yet");
      extra = { value: remote.rev, title: "GitHub's copy", detail: remote.label, date: remote.date, notes: [], child: true };
    }
    out.push({ choice: { value: main.rev, title: name, detail: main.label, date: main.date, notes }, extra });
  }
  out.sort((a, b) => newest(a.choice.date, b.choice.date));
  return out.flatMap(({ choice, extra }) => (extra ? [choice, extra] : [choice]));
}

const matches = (c: Choice, words: string[]) => {
  const text = `${c.title} ${c.detail} ${c.value}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

/** Keeps the first `n` top-level choices (with their indented children). */
function firstChoices(list: Choice[], n: number) {
  const out: Choice[] = [];
  let top = 0;
  for (const c of list) {
    if (!c.child && ++top > n) break;
    out.push(c);
  }
  return { shown: out, hidden: list.filter((c) => !c.child).length - Math.min(n, top) };
}

export function revisionSections(info: RepoInfo | undefined, query: string, expanded: Set<string>): Section[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const revs = info?.revisions ?? [];
  const main = revs.find((r) => r.kind === "remote" && r.rev === "origin/main") ?? revs.find((r) => r.kind === "branch" && r.rev === "main");
  const head = revs.find((r) => r.sha === info?.head);
  const suggested: Choice[] = [
    {
      value: WORKTREE,
      title: "This computer (not committed)",
      detail: info?.dirty.length ? `${info.dirty.length} file${info.dirty.length === 1 ? "" : "s"} edited` : "nothing edited",
      notes: [],
    },
    { value: "HEAD", title: `Last commit${info ? ` on ${info.branch}` : ""}`, detail: head?.label ?? "", date: head?.date, notes: [] },
    ...(main ? [{ value: main.rev, title: "main", detail: main.label, date: main.date, notes: main.kind === "remote" ? ["GitHub's copy"] : [] }] : []),
  ];
  const groups: [string, Choice[]][] = [
    ["Suggested", suggested],
    // main is already suggested; it stays here only when its two copies differ.
    ["Branches", branches(revs).filter((c, i, all) => !(main && c.title === main.rev.replace(REMOTE, "") && !c.child && !all[i + 1]?.child))],
    ["Tags", revs.filter((r) => r.kind === "tag").map((r) => ({ value: r.rev, title: r.rev, detail: r.label, date: r.date, notes: [] }))],
    ["Recent commits", revs.filter((r) => r.kind === "commit").map((r) => ({ value: r.rev, title: r.sha.slice(0, 7), detail: r.label, date: r.date, notes: [] }))],
  ];
  const sections: Section[] = [];
  for (const [title, list] of groups) {
    if (words.length) {
      // A branch's GitHub copy stays with its branch when the branch matches.
      const kept = list.filter((c, i) => matches(c, words) || (c.child && matches(list[i - 1], words)));
      if (kept.length) sections.push({ title, choices: kept, hidden: 0 });
    } else if (list.length) {
      const { shown, hidden } = title === "Suggested" || expanded.has(title) ? { shown: list, hidden: 0 } : firstChoices(list, SHOWN);
      sections.push({ title, choices: shown, hidden });
    }
  }
  // Anything git understands (a sha from a message, HEAD~3, a tag): compare it directly.
  const typed = query.trim();
  if (typed && !/\s/.test(typed) && !sections.some((s) => s.choices.some((c) => c.value === typed || c.title === typed)))
    sections.push({ title: "Other", choices: [{ value: typed, title: `Use “${typed}”`, detail: "a commit, tag or branch name", notes: [] }], hidden: 0 });
  return sections;
}

/** The trigger's text for the current value. */
export function describeRevision(info: RepoInfo | undefined, value: string, named?: string): { title: string; detail: string; date?: string } {
  for (const s of revisionSections(info, "", new Set(["Branches", "Tags", "Recent commits"])))
    for (const c of s.choices) if (c.value === value) return { title: c.child ? `${value}` : c.title, detail: c.detail, date: c.date };
  const r = info?.revisions.find((x) => x.rev === value || x.sha === value);
  if (r) return { title: named ?? (r.kind === "commit" ? r.sha.slice(0, 7) : r.rev), detail: r.label, date: r.date };
  return { title: named ?? (/^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value), detail: "" };
}
