import { useEffect, useRef, useState } from "react";
import { Bot, Check, ClipboardList, FlaskConical, FolderGit2, GitCompare, MapPin, MessageSquare, NotebookPen, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { DRIVER_FORM, STALLED_HOURS, STATUS_NAMES, agentActivity, hoursWithAgent, latestProof, parseFinding, proofText, taskBase, type ProofSummary, type ReviewItem, type TaskStatus } from "../core/review/tasks.ts";
import { WORKTREE } from "../core/review/report.ts";
import { useLogLibrary } from "../logLibrary";
import { desktop } from "../native";
import { chooseRepo, requestCompare, useAuthor, useRobotRepo } from "../robotRepo";
import type { SuiteState } from "../useSuiteProject";
import { AgentsPage } from "../agents/AgentsPage";
import { Badge, Button, EmptyState, PageHeader, timeAgo, type Tone } from "../ui";
import { setRobotTab } from "../robot/RobotPage";
import { deliveryStage, useDelivery, type Delivery } from "./delivery";
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

/** How a recorded proof reads at a glance: failed, behaves differently, or clean. */
const proofTone = (proof: ProofSummary): Tone => (proof.failed.length ? "bad" : proof.different.length || proof.partial ? "warn" : "good");

/** The sim proof of a commit: the recorded run, or that there is none, with a way to run it. */
function ProofLine({ proof, run }: { proof?: ProofSummary; run?: () => void }) {
  if (!proof)
    return (
      <p className="mx-proof is-none">
        <FlaskConical size={14} />
        <span>Sim proof not run on this commit</span>
        {run && (
          <Button size="sm" onClick={run}>
            Run sim proof
          </Button>
        )}
      </p>
    );
  const names = proof.failed.length ? proof.failed : proof.different;
  return (
    <div className={`mx-proof is-${proofTone(proof)}`}>
      <p>
        <FlaskConical size={14} />
        <strong>Sim proof: {proofText(proof)}</strong>
        {proof.partial && <Badge tone="warn">some scenarios only</Badge>}
        <small>
          run by {proof.by} · {timeAgo(Date.parse(proof.at))}
        </small>
        {run && (
          <button type="button" className="mx-link" onClick={run}>
            {names.length ? "Watch them" : "Run again"}
          </button>
        )}
      </p>
      {names.length > 0 && (
        <ul>
          {names.slice(0, 5).map((n) => (
            <li key={n}>{n}</li>
          ))}
          {names.length > 5 && <li className="is-more">and {names.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

/** After a change is accepted: has it been merged, is it on the robot, has it run. */
function DeliveryLane({ item, delivery, go }: { item: ReviewItem; delivery?: Delivery; go: (page: "robot" | "logs") => void }) {
  const lib = useLogLibrary();
  const accepted = [...item.history].reverse().find((h) => h.what.startsWith("accepted the change"));
  const main = delivery?.main ?? "main";
  const log = delivery?.log;
  const steps: { done: boolean | undefined; title: string; detail: string; action?: { label: string; run: () => void } }[] = [
    { done: true, title: "Accepted", detail: accepted ? `${accepted.by} · ${timeAgo(Date.parse(accepted.at))}` : "" },
    {
      done: delivery?.inMain,
      title: delivery?.inMain ? `In ${main}` : `Not in ${main} yet`,
      detail: delivery?.inMain ? "Merged" : delivery?.inMain === false ? "Its pull request is not merged" : "No main branch found in this folder",
    },
    {
      done: delivery?.onRobot,
      title: delivery?.onRobot ? "On the robot" : "Not on the robot",
      detail: delivery?.robotCheckedAt ? `as of the check ${timeAgo(delivery.robotCheckedAt)}` : "The robot has not been checked",
      action: delivery?.onRobot
        ? undefined
        : {
            label: "Check robot",
            run: () => {
              setRobotTab("now");
              go("robot");
            },
          },
    },
    {
      done: !!log,
      title: log ? "In a log" : "No log with it yet",
      detail: log
        ? `${log.name.replace(/\.wpilog$/i, "")} · ${log.summary?.errors ? `${log.summary.errors} red flag${log.summary.errors === 1 ? "" : "s"}` : "no red flags"}${delivery!.logs > 1 ? ` · ${delivery!.logs} logs` : ""}`
        : "Logs name the code they ran",
      action: log
        ? {
            label: "Open log",
            run: () => {
              void lib.open(log);
              go("logs");
            },
          }
        : undefined,
    },
  ];
  return (
    <section aria-label="Where this change is now">
      <h3>Where it is now</h3>
      <ol className="mx-delivery">
        {steps.map((step) => (
          <li key={step.title} className={step.done ? "is-done" : step.done === false ? "is-todo" : "is-unknown"}>
            <i aria-hidden="true">{step.done && <Check size={12} />}</i>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
            {step.action && (
              <button type="button" className="mx-link" onClick={step.action.run}>
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Card({ item, open, delivery }: { item: ReviewItem; open: () => void; delivery?: Delivery }) {
  const last = item.changes[item.changes.length - 1];
  const stage = deliveryStage(delivery);
  // An agent that has held a task this long without touching it has probably stopped.
  const idle = hoursWithAgent(item);
  const stalled = idle !== undefined && idle >= STALLED_HOURS;
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
        {item.status === "review" && last && (last.proof ? <Badge tone={proofTone(last.proof)}>sim proof {last.proof.failed.length ? "failed" : last.proof.different.length ? "differs" : last.proof.partial ? "partial" : "passed"}</Badge> : <Badge>no sim proof</Badge>)}
        {stage && <Badge tone={stage.tone}>{stage.text}</Badge>}
        {item.status === "declined" && <Badge>declined</Badge>}
        {stalled && <Badge tone="warn">no update for {idle! < 48 ? `${Math.round(idle!)} h` : `${Math.round(idle! / 24)} days`}</Badge>}
      </span>
    </button>
  );
}

function Detail({
  item,
  close,
  openChanges,
  delivery,
  go,
}: {
  item: ReviewItem;
  close: () => void;
  openChanges: (before: string, after: string, sim?: boolean) => void;
  delivery?: Delivery;
  go: (page: "robot" | "logs") => void;
}) {
  const tasks = useTasks();
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string>();
  useEffect(() => dialog.current?.showModal?.(), []);
  const act = async (action: Parameters<typeof tasks.act>[1]) => {
    try {
      await tasks.act(item.id, action, note.trim() ? { note: note.trim() } : {});
      setNote("");
      setFailure(undefined);
    } catch (e) {
      setFailure((e as Error).message ?? String(e));
    }
  };
  const lastRev = item.changes[item.changes.length - 1]?.revision;
  const newest = latestProof(item);
  const compareFrom = taskBase(item);
  // Sending work back needs a reason the agent can act on.
  const sendsBack = item.status === "plan" || item.status === "review";
  const hasNote = note.trim().length > 0;
  const withAgent = item.status === "claimed" || item.status === "approved";
  return (
    <dialog ref={dialog} className="mx-dialog mx-task-detail" aria-label={item.title} onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>{item.title}</h2>
          <p>
            <Badge tone={item.status === "plan" || item.status === "review" ? "warn" : item.status === "done" ? "good" : "neutral"}>{STATUS_NAMES[item.status]}</Badge> {item.author} ·{" "}
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
                {c.findings?.length ? (
                  <ul className="mx-change-findings">
                    {c.findings.slice(0, 6).map((line) => {
                      const f = parseFinding(line);
                      return (
                        <li key={line} className={f.level ? `is-${f.level}` : undefined}>
                          {f.text}
                        </li>
                      );
                    })}
                    {c.findings.length > 6 && <li className="is-more">and {c.findings.length - 6} more on the Changes page</li>}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {newest && item.status !== "approved" && (
            <ProofLine proof={newest.proof} run={desktop && compareFrom ? () => openChanges(compareFrom, newest.revision, true) : undefined} />
          )}
          {desktop && lastRev && compareFrom && (
            <Button size="sm" icon={GitCompare} onClick={() => openChanges(compareFrom, lastRev)}>
              See what changed on the robot
            </Button>
          )}
        </section>
      )}
      {item.status === "done" && item.changes.length > 0 && desktop && <DeliveryLane item={item} delivery={delivery} go={(page) => (close(), go(page))} />}
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
            <span>{sendsBack ? "Note for the agent" : "Note (optional)"}</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={item.status === "plan" ? "What should the plan do differently?" : item.status === "review" ? "What is not right about the change?" : "Why?"}
            />
            {sendsBack && !hasNote && <small>Needed to send it back; optional when you {item.status === "plan" ? "approve" : "accept"}.</small>}
          </label>
          {failure && <p className="mx-help is-bad">{failure}</p>}
          <div className="mx-dialog-actions">
            {item.status === "plan" && (
              <>
                <Button disabled={!hasNote} onClick={() => void act("reject")}>
                  Ask for a different plan
                </Button>
                <Button variant="primary" onClick={() => void act("approve")}>
                  Approve plan
                </Button>
              </>
            )}
            {item.status === "review" && (
              <>
                <Button disabled={!hasNote} onClick={() => void act("reopen")}>
                  Not right, send back
                </Button>
                <Button variant="primary" onClick={() => void act("accept")}>
                  Accept the change
                </Button>
              </>
            )}
            {withAgent && (
              <Button onClick={() => void act("reopen")} title={`Take it back from ${item.agent ?? "the agent"} so any agent can pick it up`}>
                Back to New
              </Button>
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

export function TasksPage({ s, go }: { s: SuiteState; go: (page: "changes" | "robot" | "logs") => void }) {
  const tasks = useTasks();
  const [author, setAuthor] = useAuthor();
  const { openTask: open, setOpenTask: setOpen } = tasks;
  const [form, setForm] = useState(false);
  const [note, setNote] = useState("");
  const [, setRepo] = useRobotRepo();
  const connect = useRef<HTMLDetailsElement>(null);
  const openItem = tasks.items.find((t) => t.id === open);
  const agents = agentActivity(tasks.items);
  const unclaimed = tasks.items.filter((t) => t.status === "open").length;
  const showConnect = () => {
    if (connect.current) connect.current.open = true;
    connect.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const delivery = useDelivery(tasks.items);
  const openChanges = (before: string, after: string, sim = false) => {
    requestCompare(before, after === WORKTREE ? WORKTREE : after, { sim });
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
      {tasks.repo && (agents.length > 0 || unclaimed > 0) && (
        <p className="mx-agents-line" role="status" aria-label="Agents on this queue">
          <Bot size={14} />
          {agents.length ? (
            agents.slice(0, 4).map((a) => (
              <span key={a.agent}>
                <strong>{a.agent}</strong> {a.holding ? `has ${a.holding} · ` : ""}last active {timeAgo(Date.parse(a.lastAt))}
              </span>
            ))
          ) : (
            <span>
              No agent has picked anything up yet.{" "}
              <button type="button" className="mx-link" onClick={showConnect}>
                Start one
              </button>
            </span>
          )}
        </p>
      )}
      {desktop && !tasks.repo ? (
        <EmptyState
          icon={FolderGit2}
          title="Choose the robot code folder"
          action={
            <Button variant="primary" icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>
              Choose robot code folder
            </Button>
          }
        >
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
                  <Card key={t.id} item={t} open={() => setOpen(t.id)} delivery={delivery.get(t.id)} />
                ))}
              </section>
            );
          })}
        </div>
      )}
      <details className="mx-agent-connect" ref={connect}>
        <summary>
          <Bot size={16} /> Connect an agent
        </summary>
        <AgentsPage key={s.project.id} s={s} repo={tasks.repo} />
      </details>
      {openItem && <Detail item={openItem} close={() => setOpen(undefined)} openChanges={openChanges} delivery={delivery.get(openItem.id)} go={go} />}
      {form && <DriverForm close={() => setForm(false)} />}
    </div>
  );
}
