import { History, Keyboard, LifeBuoy, Monitor, Moon, Palette, Route, Sun } from "lucide-react";
import { recoverySnapshot, download } from "../storage";
import { Button, PageHeader, Panel, Segmented } from "../ui";

export type ThemeChoice = "light" | "dark" | "system";

const shortcuts: [string, string][] = [
  ["V or Esc", "Select tool"],
  ["W", "Place a pose goal"],
  ["T", "Place a translation goal"],
  ["G", "Place a moving handoff"],
  ["Space", "Play or pause the preview"],
  ["Delete", "Remove the selected step"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
  ["Shift + drag knob", "Snap heading to 15°"],
];

export function SettingsPage({
  theme,
  setTheme,
  openLegacy,
  notify,
  version,
}: {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  openLegacy: () => void;
  notify: (m: string) => void;
  version: string;
}) {
  return (
    <div className="mx-page-scroll">
      <PageHeader title="Settings" subtitle={`Mayhem ${version}`} />
      <div className="mx-robot-grid">
        <div className="mx-col">
          <Panel title="Appearance" icon={Palette}>
            <Segmented<ThemeChoice>
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
                { value: "system", label: "Match system", icon: Monitor },
              ]}
            />
          </Panel>
          <Panel title="Keyboard shortcuts" icon={Keyboard}>
            <dl className="mx-shortcuts">
              {shortcuts.map(([keys, action]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
        <div className="mx-col">
          <Panel title="Recovery" icon={LifeBuoy}>
            <p className="mx-help">
              Mayhem keeps the previous valid save. If a saved project is ever damaged, the original is set aside here
              before anything replaces it.
            </p>
            <Button
              icon={History}
              onClick={() => {
                try {
                  const raw = recoverySnapshot();
                  if (raw) download("mayhem-recovery.json", raw);
                  else notify("There's no recovery snapshot. Nothing has been damaged.");
                } catch (e) {
                  notify(String(e));
                }
              }}
            >
              Export recovery snapshot
            </Button>
          </Panel>
          <Panel title="Classic trajectory planner" icon={Route}>
            <p className="mx-help">
              The original time-optimal trajectory solver from Mayhem 0.8. New autos should use pose goals; the classic
              planner stays available for existing paths.
            </p>
            <Button onClick={openLegacy}>Open classic planner</Button>
          </Panel>
        </div>
      </div>
    </div>
  );
}
