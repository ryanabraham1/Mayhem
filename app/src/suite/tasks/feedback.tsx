import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, FolderGit2, MessageSquarePlus, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { registerTaskAction } from "../ContextMenu";
import { createItem, move, parseItem, recordProof, serializeItem, type Anchor, type FeedbackKind, type Move, type ProofSummary, type ReviewItem } from "../core/review/tasks.ts";
import { desktop, invoke } from "../native";
import { chooseRepo, useAuthor, useRobotRepo } from "../robotRepo";
import { download } from "../storage";
import { Button } from "../ui";
import "./tasks.css";

/** Feedback and tasks in the robot repo, for every page. */
function useTaskStore(notify: (m: string) => void) {
  const [repo] = useRobotRepo();
  const [author] = useAuthor();
  const [items, setItems] = useState<{ item: ReviewItem; text: string }[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!desktop || !repo) return setItems([]);
    try {
      const raw = await invoke<{ id: string; text: string }[]>("review_items", { repo });
      const unreadable: string[] = [];
      const next = [...raw].sort((a, b) => a.id.localeCompare(b.id)).flatMap(({ id, text }) => {
        try {
          return [{ item: parseItem(text), text }];
        } catch {
          unreadable.push(id);
          return [];
        }
      });
      // Polled every few seconds: keep the same list when nothing changed, so pages don't redraw.
      setItems((current) => (current.length === next.length && current.every((x, i) => x.text === next[i].text) ? current : next));
      // A task file someone hand-edited into something unreadable is said, not silently dropped.
      setError(unreadable.length ? `${unreadable.length === 1 ? "A task file" : `${unreadable.length} task files`} in tools/mayhem/review can't be read: ${unreadable.slice(0, 3).join(", ")}${unreadable.length > 3 ? "…" : ""}` : undefined);
    } catch (e) {
      setError(String(e));
    }
  }, [repo]);
  useEffect(() => {
    void load();
    if (!desktop || !repo) return;
    // Agents update tasks from outside the app: check the folder every few seconds.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load, repo]);

  const add = async (input: Parameters<typeof createItem>[0]) => {
    const item = createItem(input);
    if (!desktop || !repo) {
      download(`${item.id}.json`, serializeItem(item), "application/json");
      notify("Saved as a file: put it in the robot repo's tools/mayhem/review/ folder (the desktop app does this for you).");
      return item;
    }
    await invoke("review_item_save", { repo, id: item.id, text: serializeItem(item), expected: null });
    await load();
    return item;
  };
  const act = async (id: string, action: Move, extra: Parameters<typeof move>[3] = {}) => {
    const entry = items.find((x) => x.item.id === id);
    if (!entry) throw new Error("That task is gone.");
    const next = move(entry.item, action, author || "someone", extra);
    try {
      await invoke("review_item_save", { repo, id, text: serializeItem(next), expected: entry.text });
    } catch (e) {
      // An agent wrote to the task between our last look and this click: show what it is now, and
      // let the person decide again rather than applying their choice to something they haven't read.
      await load();
      throw new Error(/meanwhile/i.test(String(e)) ? "This task just changed. Read it again, then choose." : String(e).replace(/^Error:\s*/, ""));
    }
    await load();
  };
  /** Keeps a sim proof the app just ran on the task's commit it ran on. */
  const saveProof = async (id: string, revision: string, proof: Omit<ProofSummary, "at">) => {
    const entry = items.find((x) => x.item.id === id);
    if (!entry) return;
    await invoke("review_item_save", { repo, id, text: serializeItem(recordProof(entry.item, revision, proof)), expected: entry.text });
    await load();
  };
  const list = useMemo(() => items.map((x) => x.item), [items]);
  return { repo, author, items: list, error, load, add, act, saveProof };
}

interface Draft {
  kind?: FeedbackKind;
  title?: string;
  text?: string;
  anchor?: Anchor;
  /** Where the dialog was opened, shown above the text. */
  context?: string;
}

const Context = createContext<
  | (ReturnType<typeof useTaskStore> & {
      openFeedback: (draft: Draft) => void;
      /** The task shown in detail on the Tasks page; set from any page to land on it. */
      openTask?: string;
      setOpenTask: (id?: string) => void;
    })
  | null
>(null);

export function useTasks() {
  const value = useContext(Context);
  if (!value) throw new Error("useTasks outside FeedbackProvider");
  return value;
}

export const anchorText = (a: Anchor) =>
  [
    a.match,
    a.log && `${a.log}${a.time !== undefined ? ` @ ${a.time.toFixed(1)} s` : ""}`,
    !a.log && a.scenario && `${a.scenario}${a.time !== undefined ? ` @ ${a.time.toFixed(1)} s` : ""}`,
    a.routine && !a.scenario && `auto ${a.routine}`,
    a.step && `step “${a.step.name}”${a.step.x !== undefined ? ` at (${a.step.x.toFixed(1)}, ${a.step.y!.toFixed(1)}) m` : ""}`,
    a.machine && `${a.machine}${a.state ? ` · state ${a.state}` : ""}${a.transition ? ` · transition ${a.transition}` : ""}`,
    a.behavior,
    a.page && [a.page, a.section, a.element].filter(Boolean).join(" › "),
    a.pose && a.step?.x === undefined && `field (${a.pose.x.toFixed(1)}, ${a.pose.y.toFixed(1)}) m`,
    a.revision && `code ${a.revision === "WORKTREE" ? "on this computer" : a.revision.slice(0, 7)}`,
  ]
    .filter(Boolean)
    .join(" · ");

function FeedbackDialog({ draft, close }: { draft: Draft; close: () => void }) {
  const tasks = useTasks();
  const [author, setAuthor] = useAuthor();
  const [, setRepo] = useRobotRepo();
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<FeedbackKind>(draft.kind ?? "comment");
  const [text, setText] = useState(draft.text ?? "");
  const [title, setTitle] = useState(draft.title ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => dialog.current?.showModal?.(), []);
  const save = async () => {
    setSaving(true);
    try {
      await tasks.add({ author, kind, title, text, anchor: draft.anchor });
      close();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setSaving(false);
    }
  };
  const anchor = draft.anchor ? anchorText(draft.anchor) : "";
  return (
    <dialog ref={dialog} className="mx-dialog mx-feedback-dialog" aria-label="Feedback" onCancel={close}>
      <div className="mx-dialog-head">
        <div>
          <h2>{kind === "thumbs-up" ? "Looks good" : kind === "thumbs-down" ? "Something's wrong" : "Feedback"}</h2>
          <p>{draft.context ?? "Becomes a task an agent can pick up, with this context attached."}</p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {anchor && <p className="mx-anchor">{anchor}</p>}
      <div className="mx-kind-row" role="group" aria-label="Kind">
        <button type="button" className={kind === "thumbs-up" ? "is-active" : ""} onClick={() => setKind("thumbs-up")}>
          <ThumbsUp size={15} /> Good
        </button>
        <button type="button" className={kind === "thumbs-down" ? "is-active" : ""} onClick={() => setKind("thumbs-down")}>
          <ThumbsDown size={15} /> Problem
        </button>
        <button type="button" className={kind === "comment" || kind === "field-point" || kind === "pit-note" ? "is-active" : ""} onClick={() => setKind(draft.kind && draft.kind !== "thumbs-up" && draft.kind !== "thumbs-down" ? draft.kind : "comment")}>
          <MessageSquarePlus size={15} /> Note
        </button>
      </div>
      <label className="mx-form-field">
        <span>Short title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Shooter keeps spinning after I let go of A" />
      </label>
      <label className="mx-form-field">
        <span>What happened, or what should change?</span>
        <textarea rows={4} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="mx-form-field">
        <span>Your name</span>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="So the agent and team know who to ask" />
      </label>
      {!desktop && <p className="mx-help">In the browser, feedback downloads as a file for the robot repo.</p>}
      {desktop && !tasks.repo && (
        <p className="mx-help mx-need-repo">
          Feedback is saved in the robot code folder, where agents read it.
          <Button size="sm" icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>
            Choose robot code folder
          </Button>
        </p>
      )}
      {failure && <p className="mx-help is-bad">{failure}</p>}
      <div className="mx-dialog-actions">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={saving || (!text.trim() && !title.trim() && kind !== "thumbs-up") || (desktop && !tasks.repo)} onClick={() => void save()}>
          {saving ? "Saving…" : kind === "thumbs-up" ? "Save" : "Send to agents"}
        </Button>
      </div>
    </dialog>
  );
}

export function FeedbackProvider({ notify, children }: { notify: (m: string) => void; children: ReactNode }) {
  const store = useTaskStore(notify);
  const [draft, setDraft] = useState<Draft>();
  const [openTask, setOpenTask] = useState<string>();
  const value = useMemo(() => ({ ...store, openFeedback: setDraft, openTask, setOpenTask }), [store, openTask]);
  // Every right-click menu offers to turn what's under the pointer into an agent task.
  useEffect(
    () =>
      registerTaskAction(({ title, anchor, context }) => ({
        label: "Make this an agent task",
        icon: Bot,
        onSelect: () => setDraft({ title, anchor: anchor as Anchor, context }),
      })),
    [],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {draft && <FeedbackDialog draft={draft} close={() => setDraft(undefined)} />}
    </Context.Provider>
  );
}

/** "Comment" button for anything worth feedback. */
export function FeedbackButton({ draft, label = "Comment", size = "sm" }: { draft: () => Draft; label?: string; size?: "sm" | "md" }) {
  const { openFeedback } = useTasks();
  return (
    <Button size={size} variant="ghost" icon={MessageSquarePlus} onClick={() => openFeedback(draft())}>
      {label}
    </Button>
  );
}
