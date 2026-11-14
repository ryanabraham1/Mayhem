import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Copy,
  FolderOpen,
  Flag,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import { openContextMenu } from "../ContextMenu";
import { autoStepLabel, type AutoNode } from "../core/model.ts";
import type { SuiteState } from "../useSuiteProject";
import { IconButton } from "../ui";

// Every step gets its number (matching the field labels); the glyph color tells actions apart.
function StepGlyph({ node, index }: { node: AutoNode; index: number }) {
  if (node.kind === "finish") return <Flag size={12} />;
  return <>{index + 1}</>;
}

function stepDetail(node: AutoNode) {
  if (node.kind === "action" || node.kind === "custom")
    return `${node.kind === "custom" ? "Custom" : "Action"} · ${node.action}`;
  if (node.kind === "pose") {
    if (node.goal && node.goal.handoffRadius > 0) return "Pass through";
    return node.goal?.headingMode === "free" ? "Any heading" : "Drive to pose";
  }
  return autoStepLabel(node);
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
  // Menu actions run after a re-render (right-click selects first), so read the latest state.
  const live = useRef(s);
  live.current = s;
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
            <div
              key={r.id}
              className={`mx-routine ${active ? "is-active" : ""}`}
              onContextMenu={(e) => {
                if (renaming === r.id) return;
                setMenu(null);
                openContextMenu(
                  e,
                  [
                    !active && { label: "Open", icon: FolderOpen, onSelect: () => live.current.selectRoutine(r.id) },
                    { label: "Rename", icon: Pencil, onSelect: () => setRenaming(r.id) },
                    { label: "Duplicate", icon: Copy, onSelect: () => live.current.duplicateRoutine(r.id) },
                    { label: "New routine", icon: Plus, onSelect: create },
                    "separator",
                    {
                      label: "Delete",
                      icon: Trash2,
                      danger: true,
                      disabled: project.routines.length <= 1,
                      onSelect: () => {
                        if (window.confirm(`Delete routine "${r.name}"?`)) live.current.deleteRoutine(r.id);
                      },
                    },
                  ],
                  r.name,
                );
              }}
            >
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
            onContextMenu={(e) => {
              inspect("@start");
              openContextMenu(
                e,
                [
                  { label: "Edit starting pose", icon: Pencil, onSelect: () => inspect("@start") },
                  { label: "Add goal after start", icon: Plus, onSelect: () => live.current.addGoal("pose") },
                  routine.start && {
                    label: "Use robot default start",
                    icon: RotateCcw,
                    onSelect: () =>
                      live.current.editRoutine((r) => {
                        delete r.start;
                      }),
                  },
                ],
                "Starting pose",
              );
            }}
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
                onContextMenu={(e) => {
                  inspect(n.id);
                  const last = routine.nodes.length - 2;
                  openContextMenu(
                    e,
                    [
                      { label: "Edit details", icon: Pencil, onSelect: () => inspect(n.id) },
                      n.kind === "pose" && {
                        label: "Duplicate",
                        icon: Copy,
                        onSelect: () => live.current.addGoal("pose", undefined, n.id),
                      },
                      n.kind !== "finish" && {
                        label: "Add pose goal after",
                        icon: Plus,
                        onSelect: () => live.current.addGoal("pose"),
                      },
                      n.kind !== "finish" && {
                        label: "Add action after",
                        icon: Zap,
                        onSelect: () => live.current.addActionStep("action"),
                      },
                      n.kind !== "finish" && {
                        label: "Add custom C++ after",
                        icon: Code2,
                        onSelect: () => live.current.addActionStep("custom"),
                      },
                      "separator",
                      n.kind !== "finish" && {
                        label: "Move up",
                        icon: ArrowUp,
                        disabled: i === 0,
                        onSelect: () => live.current.reorder(n.id, i - 1),
                      },
                      n.kind !== "finish" && {
                        label: "Move down",
                        icon: ArrowDown,
                        disabled: i >= last,
                        onSelect: () => live.current.reorder(n.id, i + 1),
                      },
                      n.kind !== "finish" && {
                        label: "Move to top",
                        disabled: i === 0,
                        onSelect: () => live.current.reorder(n.id, 0),
                      },
                      "separator",
                      n.kind !== "finish" && {
                        label: "Delete step",
                        icon: Trash2,
                        danger: true,
                        hint: "Del",
                        onSelect: () => live.current.removeNode(n.id),
                      },
                    ],
                    n.name,
                  );
                }}
              >
                {n.kind !== "finish" && <GripVertical size={13} className="mx-grip" aria-hidden="true" />}
                <span className="mx-step-glyph">
                  <StepGlyph node={n} index={i} />
                </span>
                <span className="mx-step-text">
                  <strong>{n.name}</strong>
                  <small>{stepDetail(n)}</small>
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
