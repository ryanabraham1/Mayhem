import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { ago, describeRevision, revisionSections, type Choice } from "./revisionChoices";
import type { Review } from "./useReview";

/**
 * Picks the before or after version: a button showing the choice, opening a searchable list
 * (suggested versions, each branch once, newest first, tags, recent commits). Typing anything git
 * understands (a sha, HEAD~3) compares it directly.
 */
export function RevisionPicker({ review, side, named }: { review: Review; side: "before" | "after"; named?: string }) {
  const value = side === "before" ? review.before : review.after;
  const set = side === "before" ? review.setBefore : review.setAfter;
  const label = side === "before" ? "Before" : "After";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => revisionSections(review.info, query, expanded), [review.info, query, expanded]);
  const flat = useMemo(() => sections.flatMap((s) => s.choices), [sections]);
  const current = describeRevision(review.info, value, named);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEffect(() => setActive(Math.max(0, flat.findIndex((c) => c.value === value))), [open, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (c: Choice) => {
    set(c.value);
    setOpen(false);
    setQuery("");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => Math.min(flat.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && flat[active]) choose(flat[active]);
    else if (e.key === "Escape") setOpen(false);
    else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <div className="mx-rev-picker" ref={root}>
      <span id={`mx-rev-${side}`}>{label}</span>
      <button
        type="button"
        className="mx-rev-trigger"
        aria-label={`${label} version`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        title={current.detail ? `${current.title} · ${current.detail}` : current.title}
        onClick={() => setOpen(!open)}
      >
        <strong>{current.title}</strong>
        <small>{[current.detail, ago(current.date)].filter(Boolean).join(" · ")}</small>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="mx-rev-pop" role="dialog" aria-label={`Choose the ${side} version`}>
          <label className="mx-rev-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search branches and commits, or paste a commit"
              aria-label={`Search ${side} versions`}
              role="combobox"
              aria-expanded="true"
              aria-controls={`mx-rev-list-${side}`}
            />
          </label>
          <div className="mx-rev-list" id={`mx-rev-list-${side}`} role="listbox" aria-labelledby={`mx-rev-${side}`} ref={list}>
            {sections.map((s) => (
              <div key={s.title} role="group" aria-label={s.title}>
                <div className="mx-rev-section">{s.title}</div>
                {s.choices.map((c) => {
                  const i = ++index;
                  return (
                    <div
                      key={`${s.title}:${c.value}`}
                      role="option"
                      data-value={c.value}
                      data-index={i}
                      aria-selected={c.value === value}
                      className={`mx-rev-choice${i === active ? " is-active" : ""}${c.child ? " is-child" : ""}`}
                      onPointerEnter={() => setActive(i)}
                      onClick={() => choose(c)}
                    >
                      <span className="mx-rev-choice-title">
                        <strong>{c.title}</strong>
                        {c.notes.map((n) => (
                          <em key={n}>{n}</em>
                        ))}
                      </span>
                      <span className="mx-rev-choice-detail">{c.detail}</span>
                      <time dateTime={c.date}>{ago(c.date)}</time>
                    </div>
                  );
                })}
                {s.hidden > 0 && (
                  <button type="button" className="mx-rev-more" onClick={() => setExpanded(new Set([...expanded, s.title]))}>
                    Show {s.hidden} older {s.title === "Recent commits" ? "commits" : s.title.toLowerCase()}
                  </button>
                )}
              </div>
            ))}
            {!flat.length && <p className="mx-help">Nothing matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
