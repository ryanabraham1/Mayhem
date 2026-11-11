import { useState } from "react";
import {
  ArrowDownToLine,
  Cable,
  CloudUpload,
  Gauge,
  HardDriveDownload,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Unplug,
} from "lucide-react";
import { desktop } from "../native";
import { robotAddresses, useRobot } from "../robot";
import { useLogLibrary } from "../logLibrary";
import { SignalsEditor } from "../SignalsEditor";
import type { SuiteState } from "../useSuiteProject";
import {
  Badge,
  Button,
  Dot,
  Field,
  NumberField,
  PageHeader,
  Panel,
  Segmented,
  Toggle,
  formatBytes,
  timeAgo,
} from "../ui";

const constraintLabels: Record<string, [string, string]> = {
  maxVelocity: ["Max speed", "m/s"],
  maxAcceleration: ["Max acceleration", "m/s²"],
  maxAngularVelocity: ["Max turn rate", "rad/s"],
  maxAngularAcceleration: ["Max turn acceleration", "rad/s²"],
  translationKp: ["Translation kP", ""],
  rotationKp: ["Rotation kP", ""],
};

export function ConnectionPanel() {
  const robot = useRobot();
  const { live } = robot;
  const status = live.snapshot.status;
  const [team, setTeam] = useState(String(robot.config.team));
  const topics = Object.keys(live.snapshot.topics).length;
  return (
    <Panel title="Connection" icon={Cable} className="mx-connection">
      <div className="mx-connection-status">
        <span className={`mx-robot-glyph is-${status}`}>
          {status === "connected" ? <Plug size={22} /> : <Unplug size={22} />}
        </span>
        <div>
          <strong>
            {status === "connected"
              ? "Connected"
              : status === "connecting" || status === "reconnecting"
                ? "Connecting…"
                : "Not connected"}
          </strong>
          <span>
            {robot.host}
            {status === "connected" && ` · ${topics} live values`}
          </span>
        </div>
        <Button
          variant={status === "disconnected" ? "primary" : "secondary"}
          onClick={() => (status === "disconnected" ? live.connect() : live.disconnect())}
        >
          {status === "disconnected" ? "Connect" : "Disconnect"}
        </Button>
      </div>
      <div className="mx-pair">
        <Field label="Team number">
          <input
            inputMode="numeric"
            aria-label="Team number"
            value={team}
            onChange={(e) => {
              setTeam(e.target.value.replace(/\D/g, "").slice(0, 5));
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n > 0) robot.update({ team: n });
            }}
          />
        </Field>
        <Field label="Address override">
          <input
            aria-label="Robot address"
            placeholder={robotAddresses(robot.config.team)[0]}
            value={robot.config.address}
            list="mx-robot-addresses"
            onChange={(e) => robot.update({ address: e.target.value.trim() })}
          />
          <datalist id="mx-robot-addresses">
            {robotAddresses(robot.config.team).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
      </div>
      <p className="mx-help">
        Plug into the robot over Ethernet or USB. Live values are read-only: Mayhem never commands the robot.
        {live.snapshot.error && <span className="is-bad"> {live.snapshot.error}</span>}
      </p>
    </Panel>
  );
}

function CollectionPanel() {
  const { sync } = useLogLibrary();
  const c = sync.config;
  return (
    <Panel
      title="Automatic log collection"
      icon={HardDriveDownload}
      className="mx-collection"
      actions={
        <Badge tone={!c.autoPull ? "neutral" : sync.reach === "reachable" ? "good" : sync.reach === "unreachable" ? "warn" : "accent"}>
          {!c.autoPull ? "Off" : sync.reach === "reachable" ? "Robot found" : sync.reach === "unreachable" ? "Waiting for robot" : "Starting"}
        </Badge>
      }
    >
      {!desktop && (
        <p className="mx-callout">
          Robot collection runs in the Mayhem desktop app. In the browser you can still import and analyze logs.
        </p>
      )}
      <Segmented<"robot" | "folder">
        label="Log source"
        value={c.source}
        onChange={(source) => sync.update({ source })}
        options={[
          { value: "robot", label: "Robot over Ethernet" },
          { value: "folder", label: "Folder (simulation, USB)" },
        ]}
      />
      <Toggle
        label={c.source === "folder" ? "Collect new logs from the folder automatically" : "Collect logs whenever the robot is plugged in"}
        hint="Checks every 15 seconds while Mayhem is open. Files are only copied once they stop growing."
        checked={c.autoPull}
        disabled={!desktop}
        onChange={(autoPull) => sync.update({ autoPull })}
      />
      <Toggle
        label="Take every new log"
        hint="Otherwise only the files you tick below, plus any matching the name filter."
        checked={c.collectAll}
        disabled={!desktop}
        onChange={(collectAll) => sync.update({ collectAll })}
      />
      {!c.collectAll && (
        <div className="mx-inline">
          <Toggle
            label="Also take future logs named"
            checked={c.includeNew}
            disabled={!desktop}
            onChange={(includeNew) => sync.update({ includeNew })}
          />
          <input
            aria-label="Filename contains"
            placeholder="e.g. FRC_2026"
            value={c.nameContains}
            disabled={!c.includeNew}
            onChange={(e) => sync.update({ nameContains: e.target.value })}
          />
        </div>
      )}
      {c.source === "folder" ? (
        <Field label="Folder on this computer">
          <div className="mx-inline">
            <input
              aria-label="Local log folder"
              placeholder="/path/to/robot/project/logs"
              value={c.folder}
              onChange={(e) => sync.update({ folder: e.target.value })}
            />
            <Button
              size="sm"
              disabled={!desktop}
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const folder = await open({ directory: true, multiple: false });
                if (typeof folder === "string") sync.update({ folder });
              }}
            >
              Choose…
            </Button>
          </div>
        </Field>
      ) : (
      <Field label="Log folder on the robot">
        <input
          aria-label="Log folder"
          list="mx-log-directories"
          placeholder="/home/lvuser/wpilogs"
          value={c.directory}
          disabled={sync.busy}
          onChange={(e) => sync.changeDirectory(e.target.value)}
        />
        <datalist id="mx-log-directories">
          <option value="/home/lvuser/wpilogs" />
          <option value="/U/wpilogs" />
          <option value="/home/lvuser/logs" />
          <option value="/u/logs" />
        </datalist>
      </Field>
      )}
      <div className="mx-remote-head">
        <Button icon={RefreshCw} size="sm" disabled={!desktop || sync.busy} onClick={() => void sync.refresh()}>
          {sync.busy ? "Working…" : c.source === "folder" ? "List folder logs" : "List robot logs"}
        </Button>
        <Button
          icon={ArrowDownToLine}
          size="sm"
          disabled={!desktop || sync.busy || !c.selected.length}
          onClick={() => void sync.downloadSelected()}
        >
          Download selected ({c.selected.length})
        </Button>
        <span className="mx-remote-status" role="status">
          {sync.status}
          {sync.lastChecked && !sync.status && `Checked ${timeAgo(sync.lastChecked)}`}
        </span>
      </div>
      <div className="mx-remote-list">
        {sync.remote.map((log) => (
          <label key={log.path}>
            <input
              type="checkbox"
              checked={c.selected.includes(log.path)}
              onChange={(e) => sync.toggleSelected(log.path, e.target.checked)}
            />
            <span>{log.name}</span>
            <small>{formatBytes(log.size)}</small>
          </label>
        ))}
        {!sync.remote.length && (
          <p>{c.source === "folder" ? "List the folder to pick specific logs." : "List the robot’s files to pick specific logs."}</p>
        )}
      </div>
    </Panel>
  );
}

function UploadPanel() {
  const { sync, logs } = useLogLibrary();
  const c = sync.config;
  const uploaded = logs.filter((l) => l.upload === "uploaded").length;
  return (
    <Panel
      title="Team upload"
      icon={CloudUpload}
      actions={
        <Badge tone={sync.uploading ? "accent" : sync.queued ? "warn" : "neutral"}>
          {sync.uploading ? "Uploading…" : `${sync.queued} queued · ${uploaded} uploaded`}
        </Badge>
      }
    >
      <Toggle
        label="Upload new logs automatically"
        hint="Collected and imported logs join the upload queue. Failed uploads retry with backoff."
        checked={c.autoUpload}
        disabled={!desktop}
        onChange={(autoUpload) => sync.update({ autoUpload })}
      />
      <Field label="Team website">
        <input aria-label="Team website" value={c.site} onChange={(e) => sync.update({ site: e.target.value })} />
      </Field>
      <Field
        label="Device upload token"
        hint={
          <>
            Sign in to the team website, open Logs, and choose <strong>Connect Mayhem</strong> to create a token for
            this computer.{" "}
            <button
              type="button"
              className="mx-link"
              onClick={() => {
                const url = `${c.site.replace(/\/+$/, "")}/logs`;
                if (desktop) void import("@tauri-apps/plugin-shell").then((m) => m.open(url));
                else window.open(url, "_blank", "noopener");
              }}
            >
              Get a token
            </button>
          </>
        }
      >
        <input
          type="password"
          aria-label="Device upload token"
          autoComplete="off"
          value={sync.token}
          onChange={(e) => sync.setToken(e.target.value)}
          placeholder="mhm_…"
        />
      </Field>
      <Toggle
        label="Remember the token on this computer"
        hint="Needed for uploads to resume after Mayhem restarts."
        checked={c.rememberToken}
        onChange={sync.setRemember}
      />
      <Toggle label="Pause uploads" checked={c.cloudPaused} onChange={(cloudPaused) => sync.update({ cloudPaused })} />
    </Panel>
  );
}

function ViewerPanel() {
  const { sync } = useLogLibrary();
  return (
    <Panel title="AdvantageScope" icon={Gauge}>
      <Field label="Application path" hint="Optional. Mayhem finds the WPILib installation automatically.">
        <input
          aria-label="AdvantageScope path"
          value={sync.config.viewer}
          placeholder="Detected automatically"
          onChange={(e) => sync.update({ viewer: e.target.value })}
        />
      </Field>
    </Panel>
  );
}

export function RobotPage({ s }: { s: SuiteState }) {
  const { project } = s;
  return (
    <div className="mx-page-scroll">
      <PageHeader
        title="Robot"
        subtitle={`${project.robot.name} · connection, log collection and the limits autos are planned with.`}
      />
      <div className="mx-robot-grid">
        <div className="mx-col">
          <ConnectionPanel />
          <CollectionPanel />
        </div>
        <div className="mx-col">
          <UploadPanel />
          <Panel title="Drive limits and size" icon={SlidersHorizontal}>
            <p className="mx-help">Used by the autonomous preview and exported to the C++ pose controller.</p>
            <div className="mx-grid-fields">
              <NumberField
                label="Robot length"
                value={project.robot.length}
                min={0.01}
                unit="m"
                change={(v) =>
                  s.commit((p) => {
                    p.robot.length = v;
                  })
                }
              />
              <NumberField
                label="Robot width"
                value={project.robot.width}
                min={0.01}
                unit="m"
                change={(v) =>
                  s.commit((p) => {
                    p.robot.width = v;
                  })
                }
              />
              {Object.entries(project.robot.constraints).map(([key, value]) => (
                <NumberField
                  key={key}
                  label={constraintLabels[key]?.[0] ?? key}
                  unit={constraintLabels[key]?.[1]}
                  value={value}
                  min={0.001}
                  change={(v) =>
                    s.commit((p) => {
                      p.robot.constraints[key as keyof typeof p.robot.constraints] = v;
                    })
                  }
                />
              ))}
            </div>
          </Panel>
          <ViewerPanel />
        </div>
      </div>
      <div className="mx-robot-wide">
        <SignalsEditor project={project} commit={s.commit} />
      </div>
      <p className="mx-foot-note">
        <Dot /> Units are meters, radians and seconds. Field coordinates use the blue-alliance origin.
      </p>
    </div>
  );
}
