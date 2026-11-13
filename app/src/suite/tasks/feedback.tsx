import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageSquarePlus, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { createItem, move, parseItem, serializeItem, type Anchor, type FeedbackKind, type Move, type ReviewItem } from "../core/review/tasks.ts";
import { desktop, invoke } from "../native";
import { useAuthor, useRobotRepo } from "../robotRepo";
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
      setItems(
        raw.flatMap(({ text }) => {
          try {
            return [{ item: parseItem(text), text }];
          } catch {
            return [];
          }
        }),
      );
      setError(undefined);
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
    await invoke("review_item_save", { repo, id, text: serializeItem(next), expected: entry.text });
    await load();
  };
  return { repo, author, items: items.map((x) => x.item), error, load, add, act };
}

interface Draft {
  kind?: FeedbackKind;
  title?: string;
  text?: string;
  anchor?: Anchor;
  /** Where the dialog was opened, shown above the text. */
  context?: string;
}

const Context = createContext<(ReturnType<typeof useTaskStore> & { openFeedback: (draft: Draft) => void }) | null>(null);

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
    a.behavior,
    a.pose && `field (${a.pose.x.toFixed(1)}, ${a.pose.y.toFixed(1)}) m`,
    a.revision && `code ${a.revision === "WORKTREE" ? "on this computer" : a.revision.slice(0, 7)}`,
  ]
    .filter(Boolean)
    .join(" · ");

function FeedbackDialog({ draft, close }: { draft: Draft; close: () => void }) {
  const tasks = useTasks();
  const [author, setAuthor] = useAuthor();
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
      {desktop && !tasks.repo && <p className="mx-help is-bad">Choose the robot code folder on the Tasks page first.</p>}
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
  const value = useMemo(() => ({ ...store, openFeedback: setDraft }), [store]);
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
