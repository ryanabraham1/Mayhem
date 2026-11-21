import { CalendarDays, History, Keyboard, LifeBuoy, Monitor, Moon, Palette, RefreshCw, Sun } from "lucide-react";
import { SEASONS } from "../core/seasons.ts";
import { recoverySnapshot, download } from "../storage";
import { Button, PageHeader, Panel, Segmented } from "../ui";
import { shortcutGroups } from "../autos/ShortcutSheet";
import { checkForUpdate, installUpdate, useUpdater } from "../../updater";
import { AgentsPage } from "../agents/AgentsPage";
import type { SuiteState } from "../useSuiteProject";

export type ThemeChoice = "light" | "dark" | "system";

export function SettingsPage({
  theme,
  setTheme,
  notify,
  version,
  s,
}: {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  notify: (m: string) => void;
  version: string;
  s: SuiteState;
}) {
  const u = useUpdater();
  const busy = ["checking", "downloading", "restarting"].includes(u.phase);
  const ready = u.version && (u.phase === "available" || u.phase === "error");
  return (
    <div className="mx-page-scroll">
      <PageHeader title="Settings" subtitle={`Mayhem ${version}`} />
      <div className="mx-robot-grid">
        <div className="mx-col">
          <Panel title="Game" icon={CalendarDays}>
            <Segmented<string>
              label="Game year"
              value={String(s.season.year)}
              onChange={(year) => {
                const next = SEASONS.find((g) => String(g.year) === year);
                if (next) s.setSeason(next);
              }}
              options={SEASONS.map((g) => ({ value: String(g.year), label: g.name, title: `${g.autoSeconds} s auto period` }))}
            />
            <p className="mx-help">
              Sets the field the autos are drawn and checked on, its size in the exported header, and the length of the
              auto period ({s.season.autoSeconds} s in {s.season.year}). Autos keep their goals; undo switches back.
            </p>
          </Panel>
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
            {shortcutGroups.map((group) => (
              <section className="mx-dialog-section" key={group.title}>
                <h3>{group.title}</h3>
                <dl className="mx-shortcuts">
                  {group.keys.map(([keys, action]) => (
                    <div key={keys}>
                      <dt><kbd>{keys}</kbd></dt>
                      <dd>{action}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </Panel>
        </div>
        <div className="mx-col">
          <Panel title="Updates" icon={RefreshCw}>
            <p className="mx-help">{u.current ? `Mayhem v${u.current}` : `Mayhem ${version}`}</p>
            {ready ? (
              <Button variant="primary" onClick={() => void installUpdate()}>
                Install {u.version}
              </Button>
            ) : (
              <Button icon={RefreshCw} disabled={busy} onClick={() => void checkForUpdate(true, notify)}>
                {u.phase === "checking"
                  ? "Checking…"
                  : u.phase === "downloading"
                    ? "Downloading…"
                    : u.phase === "restarting"
                      ? "Restarting…"
                      : "Check for updates"}
              </Button>
            )}
          </Panel>
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
        </div>
      </div>
      <section className="mx-settings-agents" aria-label="Agents and the project file">
        <h2>Agents and the project file</h2>
        <AgentsPage key={s.project.id} s={s} />
      </section>
    </div>
  );
}
