import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Copy, FilePlus2, FolderOpen, X } from "lucide-react";
import type { SuiteProject } from "./core/model";
import { download, listProjects, newProject } from "./storage";

export function ProjectPicker({
  project,
  path,
  activate,
  rename,
  open,
  close,
  notify,
}: {
  project: SuiteProject;
  path: string | null;
  activate: (project: SuiteProject) => Promise<void>;
  rename: (name: string) => boolean;
  open: () => void;
  close: () => void;
  notify: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(project.name);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [{ projects, error }] = useState(() => {
    try {
      const saved = listProjects();
      return {
        projects: saved.some((p) => p.id === project.id)
          ? saved
          : [project, ...saved],
        error: "",
      };
    } catch (error) {
      return { projects: [], error: String(error) };
    }
  });
  useEffect(() => {
    if (error) notify(error);
  }, [error, notify]);
  useEffect(() => {
    const element = dialog.current!;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (element.close) element.close();
    };
  }, []);
  const switchTo = async (next: SuiteProject) => {
    setBusy(true);
    try {
      await activate(next);
      close();
    } catch (error) {
      notify(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="mx-dialog"
      aria-label="Projects"
      onCancel={close}
    >
      <div className="mx-dialog-head">
        <div>
          <h2>Projects</h2>
          <p>Each project has its own robot, routines, inputs and state machines.</p>
        </div>
        <button
          type="button"
          className="mx-icon-btn"
          aria-label="Close projects"
          onClick={close}
          disabled={busy}
        >
          <X size={18} />
        </button>
      </div>
      <div className="mx-project-list">
        {projects.map((saved) => (
          <button
            type="button"
            className={`mx-project ${saved.id === project.id ? "is-current" : ""}`}
            key={saved.id}
            disabled={busy || saved.id === project.id}
            onClick={() => void switchTo(saved)}
          >
            <span className="mx-project-mark">{saved.name.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{saved.name}</strong>
              <small>
                {saved.routines.length} routines · revision {saved.revision}
                {saved.id === project.id ? " · Current" : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
      <form
        className="mx-dialog-section"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            if (rename(name.trim())) close();
          }
        }}
      >
        <h3>This project</h3>
        <label className="mx-field">
          <span className="mx-field-label">Project name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <span className="mx-field-hint">
          {path ? `Linked file: ${path}` : "Saved on this computer."}
        </span>
        <div className="mx-dialog-actions">
          <button className="mx-btn mx-btn-secondary mx-btn-md" disabled={busy || !name.trim()}>
            Rename
          </button>
          <button
            type="button"
            className="mx-btn mx-btn-secondary mx-btn-md"
            disabled={busy}
            onClick={() =>
              void switchTo(newProject(`${project.name} copy`, project))
            }
          >
            <Copy size={16} />
            Duplicate project
          </button>
          <button
            type="button"
            className="mx-btn mx-btn-secondary mx-btn-md"
            onClick={() =>
              download(
                `${project.id}.mayhem.json`,
                JSON.stringify(project, null, 2),
              )
            }
          >
            <ArrowDownToLine size={16} />
            Export project
          </button>
        </div>
      </form>
      <form
        className="mx-dialog-section"
        onSubmit={(event) => {
          event.preventDefault();
          if (newName.trim()) void switchTo(newProject(newName));
        }}
      >
        <h3>Start another</h3>
        <label className="mx-field">
          <span className="mx-field-label">New project name</span>
          <input
            value={newName}
            placeholder="e.g. 2027 competition robot"
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <div className="mx-dialog-actions">
          <button
            className="mx-btn mx-btn-primary mx-btn-md"
            disabled={busy || !newName.trim()}
          >
            <FilePlus2 size={16} />
            Create project
          </button>
          <button
            type="button"
            className="mx-btn mx-btn-secondary mx-btn-md"
            disabled={busy}
            onClick={() => {
              close();
              open();
            }}
          >
            <FolderOpen size={16} />
            Open project file
          </button>
        </div>
      </form>
    </dialog>
  );
}
