import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export const shortcutGroups: { title: string; keys: [string, string][] }[] = [
  {
    title: "Tools",
    keys: [
      ["V or Esc", "Select and move"],
      ["W", "Place a pose"],
      ["T", "Place a goal with any heading"],
      ["G", "Place a pass-through point"],
    ],
  },
  {
    title: "Editing",
    keys: [
      ["Double-click", "Add a pose on the field"],
      ["Right-click", "Goal menu: turn, duplicate, delete"],
      ["Click a stack", "Spread out goals on top of each other"],
      ["Shift + drag knob", "Snap heading to 15°"],
      ["Delete", "Remove the selected step"],
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
    ],
  },
  {
    title: "Moving around",
    keys: [
      [", and .", "Previous / next goal"],
      ["[ and ]", "Previous / next leg"],
      ["Drag", "Pan the field"],
      ["Space", "Play or pause the preview"],
      ["?", "Show this list"],
    ],
  },
];

export function ShortcutSheet({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (element.close) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mx-dialog mx-shortcut-sheet"
      aria-label="Keyboard shortcuts"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="mx-dialog-head">
        <div>
          <h2>Keyboard shortcuts</h2>
          <p>For the autonomous editor. Press ? any time to bring this back.</p>
        </div>
        <button type="button" className="mx-icon-btn" aria-label="Close shortcuts" onClick={close}>
          <X size={18} />
        </button>
      </div>
      {shortcutGroups.map((group) => (
        <section className="mx-dialog-section" key={group.title}>
          <h3>{group.title}</h3>
          <dl className="mx-shortcuts">
            {group.keys.map(([key, action]) => (
              <div key={key}>
                <dt>
                  <kbd>{key}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </dialog>
  );
}
