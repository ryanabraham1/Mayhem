import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Copy,
  Flag,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { autoStepLabel, type AutoNode } from "../core/model.ts";
import type { SuiteState } from "../useSuiteProject";
import { IconButton } from "../ui";

function StepGlyph({ node, index }: { node: AutoNode; index: number }) {
  if (node.kind === "finish") return <Flag size={12} />;
  if (node.kind === "action") return <Zap size={12} />;
  if (node.kind === "custom") return <Code2 size={12} />;
  return <>{index + 1}</>;
}

export function RoutineRail({
  s,
  inspect,
  create,
}: {
  s: SuiteState;
  inspect: (id: string) => void;
  create: () => void;
}) {
  const { project, routine } = s;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  return (
    <aside className="mx-rail" aria-label="Autonomous routines">
      <div className="mx-rail-head">
        <h2>Routines</h2>
        <IconButton label="Create routine" icon={Plus} onClick={create} />
      </div>
      <div className="mx-routines">
        {project.routines.map((r) => {
          const active = r.id === routine.id;
          return (
            <div key={r.id} className={`mx-routine ${active ? "is-active" : ""}`}>
              {renaming === r.id ? (
                <input
                  autoFocus
                  aria-label="Routine name"
                  className="mx-routine-rename"
                  defaultValue={r.name}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== r.name) s.renameRoutine(r.id, name);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  className="mx-routine-name"
                  onClick={() => s.selectRoutine(r.id)}
                  onDoubleClick={() => setRenaming(r.id)}
                >
                  {r.name}
                </button>
              )}
              <span className="mx-routine-count">
                {r.nodes.filter((n) => n.kind !== "finish").length}
              </span>
              <IconButton
                label={`More actions for ${r.name}`}
                icon={MoreHorizontal}
                className="mx-routine-more"
                aria-expanded={menu === r.id}
                onClick={() => setMenu(menu === r.id ? null : r.id)}
              />
              {menu === r.id && (
                <div className="mx-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                  <button role="menuitem" onClick={() => { setRenaming(r.id); setMenu(null); }}>
                    <Pencil size={14} /> Rename
                  </button>
                  <button
                    role="menuitem"
                    aria-label={`Duplicate routine ${r.name}`}
                    onClick={() => { s.duplicateRoutine(r.id); setMenu(null); }}
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  <button
                    role="menuitem"
                    className="is-danger"
                    aria-label={`Delete routine ${r.name}`}
                    disabled={project.routines.length <= 1}
                    onClick={() => { s.deleteRoutine(r.id); setMenu(null); }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mx-rail-head is-steps">
        <h2>Steps</h2>
        <span className="mx-rail-sub">{routine.name}</span>
      </div>
      <ol className="mx-steps">
        <li>
          <button
            aria-label="Starting pose"
            className={`mx-step is-start ${s.selected === "@start" ? "is-selected" : ""}`}
            onClick={() => inspect("@start")}
          >
            <span className="mx-step-glyph">S</span>
            <span className="mx-step-text">
              <strong>Starting pose</strong>
              <small>{routine.start ? "Routine start" : "Robot default"}</small>
            </span>
          </button>
        </li>
        {routine.nodes.map((n, i) => {
          const running = s.frame.node === n.id && s.frame.time > 0;
          return (
            <li
              key={n.id}
              className={dragOver === i ? "is-drop" : ""}
              draggable={n.kind !== "finish"}
              onDragStart={(e) => e.dataTransfer.setData("text/plain", n.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                s.reorder(e.dataTransfer.getData("text/plain"), i);
              }}
            >
              <button
                aria-label={`${i + 1} ${n.name}`}
                className={`mx-step is-${n.kind === "pose" && n.goal?.headingMode === "free" ? "translation" : n.kind} ${n.id === s.selected ? "is-selected" : ""} ${running ? "is-running" : ""}`}
                onClick={() => inspect(n.id)}
              >
                {n.kind !== "finish" && <GripVertical size={13} className="mx-grip" aria-hidden="true" />}
                <span className="mx-step-glyph">
                  <StepGlyph node={n} index={i} />
                </span>
                <span className="mx-step-text">
                  <strong>{n.name}</strong>
                  <small>
                    {n.kind === "action" || n.kind === "custom"
                      ? n.action
                      : autoStepLabel(n)}
                    {n.goal && n.goal.handoffRadius > 0 ? " · moving handoff" : ""}
                  </small>
                </span>
              </button>
              {n.kind !== "finish" && (
                <span className="mx-step-move">
                  <IconButton
                    label={`Move ${n.name} up`}
                    icon={ArrowUp}
                    disabled={i === 0}
                    onClick={() => s.reorder(n.id, i - 1)}
                  />
                  <IconButton
                    label={`Move ${n.name} down`}
                    icon={ArrowDown}
                    disabled={i >= routine.nodes.length - 2}
                    onClick={() => s.reorder(n.id, i + 1)}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mx-rail-add">
        <button onClick={() => s.addActionStep("action")}>
          <Zap size={14} /> Add action after selected
        </button>
      </div>
    </aside>
  );
}
