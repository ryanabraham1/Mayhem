import { useEffect, useRef, useState } from "react";
import { Bot, ClipboardList, FolderGit2, GitCompare, MapPin, MessageSquare, NotebookPen, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { DRIVER_FORM, STATUS_NAMES, type ReviewItem, type TaskStatus } from "../core/review/tasks.ts";
import { WORKTREE } from "../core/review/report.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop } from "../native";
import { chooseRepo, requestCompare, useAuthor, useRobotRepo } from "../robotRepo";
import type { SuiteState } from "../useSuiteProject";
import { AgentsPage } from "../agents/AgentsPage";
import { Badge, Button, EmptyState, PageHeader, timeAgo, type Tone } from "../ui";
import { anchorText, useTasks } from "./feedback";
import "./tasks.css";

const COLUMNS: { title: string; statuses: TaskStatus[]; hint: string }[] = [
  { title: "New", statuses: ["open"], hint: "Waiting for an agent" },
  { title: "Agent planning", statuses: ["claimed"], hint: "An agent took it" },
  { title: "Plan to approve", statuses: ["plan"], hint: "Read the plan, approve or ask for another" },
  { title: "Agent working", statuses: ["approved"], hint: "Plan approved, code changing" },
  { title: "Ready to check", statuses: ["review"], hint: "Check the change, then accept" },
  { title: "Done", statuses: ["done", "declined", "noted"], hint: "Finished, declined, or just noted" },
];
const LEVEL_TONE: Record<string, Tone> = { red: "bad", yellow: "warn", green: "good", none: "neutral" };
const LEVEL_WORD: Record<string, string> = { red: "safety change", yellow: "review", green: "auto-OK", none: "no behavior change" };

const KindIcon = ({ kind }: { kind: ReviewItem["kind"] }) => {
  const Icon = kind === "thumbs-up" ? ThumbsUp : kind === "thumbs-down" ? ThumbsDown : kind === "field-point" ? MapPin : kind === "driver-form" ? ClipboardList : kind === "pit-note" ? NotebookPen : MessageSquare;
  return <Icon size={14} />;
};

function Card({ item, open }: { item: ReviewItem; open: () => void }) {
  const last = item.changes[item.changes.length - 1];
  return (
    <button type="button" className={`mx-task-card is-${item.status}`} onClick={open}>
      <span className="mx-task-title">
        <KindIcon kind={item.kind} />
        {item.title}
      </span>
      <small>
        {item.author} · {timeAgo(Date.parse(item.createdAt))}
      </small>
      {anchorText(item.anchor) && <small className="mx-anchor">{anchorText(item.anchor)}</small>}
      <span className="mx-task-chips">
        {item.agent && (
          <Badge tone="accent">
            <Bot size={11} /> {item.agent}
          </Badge>
        )}
        {last?.level && <Badge tone={LEVEL_TONE[last.level]}>{LEVEL_WORD[last.level]}</Badge>}
      </span>
    </button>
  );
}

function Detail({ item, close, openChanges }: { item: ReviewItem; close: () => void; openChanges: (before: string, after: string) => void }) {
  const tasks = useTasks();
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string>();
  useEffect(() => dialog.current?.showModal?.(), []);
  const act = async (action: Parameters<typeof tasks.act>[1]) => {
    try {
      await tasks.act(item.id, action, note.trim() ? { note: note.trim() } : {});
      setNote("");
    } catch (e) {
      setFailure(String(e));
    }
  };
  const lastRev = item.changes[item.changes.length - 1]?.revision;
  return (
    <dialog ref={dialog} className="mx-dialog mx-task-detail" aria-label={item.title} onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>{item.title}</h2>
          <p>
            <Badge tone={item.status === "plan" ? "warn" : item.status === "done" ? "good" : "neutral"}>{STATUS_NAMES[item.status]}</Badge> {item.author} ·{" "}
            {new Date(item.createdAt).toLocaleString()}
            {item.agent ? ` · agent ${item.agent}` : ""}
          </p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {anchorText(item.anchor) && <p className="mx-anchor">{anchorText(item.anchor)}</p>}
      {item.text && <p className="mx-task-text">{item.text}</p>}
      {item.form && (
        <dl className="mx-form-answers">
          {DRIVER_FORM.filter((q) => item.form![q.key] !== undefined && item.form![q.key] !== "").map((q) => (
            <div key={q.key}>
              <dt>{q.label}</dt>
              <dd>{q.kind === "yesno" ? (item.form![q.key] ? "Yes" : "No") : q.kind === "scale" ? `${item.form![q.key]} / 5` : String(item.form![q.key])}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.plan && (
        <section className={`mx-plan ${item.status === "plan" ? "is-pending" : ""}`}>
          <h3>Agent's plan</h3>
          <p>{item.plan}</p>
          {item.planDecision && (
            <small>
              {item.planDecision.approved ? "Approved" : "Sent back"} by {item.planDecision.by}
              {item.planDecision.note ? `: ${item.planDecision.note}` : ""}
            </small>
          )}
        </section>
      )}
      {item.changes.length > 0 && (
        <section>
          <h3>Changes</h3>
          <ul className="mx-change-list">
            {item.changes.map((c) => (
              <li key={c.revision}>
                <code>{c.revision.slice(0, 7)}</code> {c.summary}
                {c.level && <Badge tone={LEVEL_TONE[c.level]}>{LEVEL_WORD[c.level]}</Badge>}
                {c.findings?.length ? <div className="mx-before-after">{c.findings.slice(0, 4).join(" · ")}</div> : null}
              </li>
            ))}
          </ul>
          {desktop && lastRev && (
            <Button size="sm" icon={GitCompare} onClick={() => openChanges(item.base ?? `${item.changes[0].revision}~1`, lastRev)}>
              See what changed on the robot
            </Button>
          )}
        </section>
      )}
      <details className="mx-history">
        <summary>History</summary>
        <ul>
          {item.history.map((h, i) => (
            <li key={i}>
              {new Date(h.at).toLocaleString()} · {h.by} {h.what}
            </li>
          ))}
        </ul>
      </details>
      {desktop && (
        <>
          <label className="mx-form-field">
            <span>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={item.status === "plan" ? "What should the plan do differently?" : "Why?"} />
          </label>
          {failure && <p className="mx-help is-bad">{failure}</p>}
          <div className="mx-dialog-actions">
            {item.status === "plan" && (
              <>
                <Button onClick={() => void act("reject")}>Ask for a different plan</Button>
                <Button variant="primary" onClick={() => void act("approve")}>
                  Approve plan
                </Button>
              </>
            )}
            {item.status === "review" && (
              <>
                <Button onClick={() => void act("reopen")}>Not right, reopen</Button>
                <Button variant="primary" onClick={() => void act("accept")}>
                  Accept the change
                </Button>
              </>
            )}
            {["open", "claimed", "approved"].includes(item.status) && <Button onClick={() => void act("decline")}>Decline</Button>}
            {["done", "declined", "noted"].includes(item.status) && <Button onClick={() => void act("reopen")}>Reopen</Button>}
          </div>
        </>
      )}
    </dialog>
  );
}

/** Post-match: a few quick questions, attached to the match's log. */
function DriverForm({ close }: { close: () => void }) {
  const tasks = useTasks();
  const lib = useLogLibrary();
  const [author, setAuthor] = useAuthor();
  const dialog = useRef<HTMLDialogElement>(null);
  const logs = [...lib.logs].sort((a, b) => b.added - a.added).slice(0, 15);
  const [logId, setLogId] = useState(logs[0]?.id ?? "");
  const [match, setMatch] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [failure, setFailure] = useState<string>();
  useEffect(() => dialog.current?.showModal?.(), []);
  const log = logs.find((l) => l.id === logId);
  const save = async () => {
    try {
      const notes = [answers.broke, answers.change].filter(Boolean).join("\n");
      await tasks.add({
        author,
        kind: "driver-form",
        title: `Driver form${match ? `: ${match}` : ""}${answers.change ? ` · ${String(answers.change).slice(0, 60)}` : ""}`,
        text: notes,
        anchor: { ...(log ? { log: log.name, ...(log.nativePath ? { logPath: log.nativePath } : {}) } : {}), ...(match ? { match } : {}) },
        form: answers,
      });
      close();
    } catch (e) {
      setFailure(String(e));
    }
  };
  return (
    <dialog ref={dialog} className="mx-dialog mx-driver-form" aria-label="Post-match driver form" onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>Post-match driver form</h2>
          <p>Takes a minute. Attached to the match's log so agents can look at exactly what happened.</p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <div className="mx-form-grid">
        <label className="mx-form-field">
          <span>Match</span>
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Qual 14" />
        </label>
        <label className="mx-form-field">
          <span>Log</span>
          <select value={logId} onChange={(e) => setLogId(e.target.value)}>
            <option value="">No log</option>
            {logs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {DRIVER_FORM.map((q) => (
        <div key={q.key} className="mx-form-field">
          <span>{q.label}</span>
          {q.kind === "scale" ? (
            <div className="mx-scale" role="group" aria-label={q.label}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" className={answers[q.key] === n ? "is-active" : ""} onClick={() => setAnswers((a) => ({ ...a, [q.key]: n }))}>
                  {n}
                </button>
              ))}
            </div>
          ) : q.kind === "yesno" ? (
            <div className="mx-scale" role="group" aria-label={q.label}>
              {[true, false].map((v) => (
                <button key={String(v)} type="button" className={answers[q.key] === v ? "is-active" : ""} onClick={() => setAnswers((a) => ({ ...a, [q.key]: v }))}>
                  {v ? "Yes" : "No"}
                </button>
              ))}
            </div>
          ) : (
            <textarea rows={2} aria-label={q.label} value={String(answers[q.key] ?? "")} onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))} />
          )}
        </div>
      ))}
      <label className="mx-form-field">
        <span>Your name</span>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      {failure && <p className="mx-help is-bad">{failure}</p>}
      <div className="mx-dialog-actions">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>
          Send
        </Button>
      </div>
    </dialog>
  );
}

export function TasksPage({ s, go }: { s: SuiteState; go: (page: "changes") => void }) {
  const tasks = useTasks();
  const [author, setAuthor] = useAuthor();
  const [open, setOpen] = useState<string>();
  const [form, setForm] = useState(false);
  const [note, setNote] = useState("");
  const [, setRepo] = useRobotRepo();
  const openItem = tasks.items.find((t) => t.id === open);
  const openChanges = (before: string, after: string) => {
    requestCompare(before, after === WORKTREE ? WORKTREE : after);
    go("changes");
  };
  const waiting = tasks.items.filter((t) => t.status === "plan" || t.status === "review").length;
  return (
    <div className="mx-page-scroll mx-tasks">
      <PageHeader
        title="Tasks"
        subtitle="Feedback from the team becomes tasks for the agents. Approve their plans before they change code, and check their changes when they're done."
        actions={
          <>
            {desktop && (
              <Button icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>
                {tasks.repo ? tasks.repo.split("/").pop() : "Choose robot code folder"}
              </Button>
            )}
            <Button icon={ClipboardList} onClick={() => setForm(true)}>
              Driver form
            </Button>
            <Button variant="primary" icon={MessageSquare} onClick={() => tasks.openFeedback({})}>
              Add feedback
            </Button>
          </>
        }
      />
      <form
        className="mx-pit-note"
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          void tasks.add({ author, kind: "pit-note", text: note }).then(() => setNote(""));
        }}
      >
        <NotebookPen size={16} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Quick pit note: “left intake roller rubbing”, “drivers want slower slow mode”…" aria-label="Pit note" />
        {!author && <input className="mx-pit-name" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Your name" aria-label="Your name" />}
        <Button type="submit" size="sm" disabled={!note.trim()}>
          Save
        </Button>
      </form>
      {waiting > 0 && (
        <div className="mx-callout is-warn" role="status">
          <span>
            <strong>{waiting} waiting for you:</strong> plans to approve and changes to check.
          </span>
        </div>
      )}
      {tasks.error && <p className="mx-help is-bad">{tasks.error}</p>}
      {desktop && !tasks.repo ? (
        <EmptyState icon={FolderGit2} title="Choose the robot code folder">
          Feedback and tasks are saved in the robot repo (tools/mayhem/review), so agents and teammates see them with the code.
        </EmptyState>
      ) : (
        <div className="mx-board">
          {COLUMNS.map((col) => {
            const list = tasks.items
              .filter((t) => col.statuses.includes(t.status))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, col.title === "Done" ? 12 : undefined);
            return (
              <section key={col.title} className={`mx-column ${col.statuses.includes("plan") || col.statuses.includes("review") ? "is-action" : ""}`} aria-label={col.title}>
                <header>
                  <strong>{col.title}</strong>
                  <Badge>{list.length}</Badge>
                </header>
                <small className="mx-help">{col.hint}</small>
                {list.map((t) => (
                  <Card key={t.id} item={t} open={() => setOpen(t.id)} />
                ))}
              </section>
            );
          })}
        </div>
      )}
      <details className="mx-agent-connect">
        <summary>
          <Bot size={16} /> Connect an agent
        </summary>
        <p className="mx-help">
          Agents use the Mayhem MCP tools <code>list_tasks</code>, <code>claim_task</code>, <code>propose_plan</code>, <code>report_progress</code> and{" "}
          <code>finish_task</code>. See docs/SUITE_AGENTS.md, Tasks.
        </p>
        <AgentsPage key={s.project.id} s={s} />
      </details>
      {openItem && <Detail item={openItem} close={() => setOpen(undefined)} openChanges={openChanges} />}
      {form && <DriverForm close={() => setForm(false)} />}
    </div>
  );
}
