import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Braces,
  Check,
  ClipboardCopy,
  Code2,
  FileText,
  Link2,
  Plug,
  TerminalSquare,
} from "lucide-react";
import { conditionLabel } from "../core/model.ts";
import { downloadCpp } from "../cppExport";
import { desktop } from "../native";
import { download } from "../storage";
import type { SuiteState } from "../useSuiteProject";
import { Badge, Button, PageHeader, Panel } from "../ui";

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-code">
      <pre>{text}</pre>
      <button
        type="button"
        className="mx-code-copy"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** A compact, plain-text description of the project for an agent's context. */
export function agentBrief(s: SuiteState) {
  const { project } = s;
  const lines = [
    `Mayhem project "${project.name}" (format mayhem-suite v1, revision ${project.revision}).`,
    `Robot ${project.robot.name}: ${project.robot.length} × ${project.robot.width} m, max ${project.robot.constraints.maxVelocity} m/s, ${project.robot.constraints.maxAcceleration} m/s².`,
    `Field ${project.field.name}: ${project.field.width} × ${project.field.height} m, blue-alliance origin, meters/radians/seconds.`,
    s.projectPath ? `Linked file: ${s.projectPath} (edit it with revision checks; the app reloads it).` : "Not linked to a file yet.",
    "",
    "Inputs:",
    ...(project.signals.length
      ? project.signals.map((sig) => `- ${sig.key} (${sig.type}) "${sig.name}"`)
      : ["- none"]),
    "",
    "Routines:",
  ];
  for (const r of project.routines) {
    lines.push(`- ${r.id} "${r.name}" starts at ${r.initial}`);
    for (const n of r.nodes) {
      const detail =
        n.kind === "pose" && n.goal
          ? `pose (${n.goal.x.toFixed(2)}, ${n.goal.y.toFixed(2)}) ${((n.goal.heading * 180) / Math.PI).toFixed(0)}°${n.goal.handoffRadius ? ` handoff ${n.goal.handoffRadius} m` : ""}`
          : n.kind === "finish"
            ? "finish"
            : `${n.kind} ${n.action}`;
      const next = r.transitions
        .filter((t) => t.from === n.id)
        .map((t) => `${t.to}${t.condition.kind === "always" ? "" : ` if ${conditionLabel(t.condition)}`}`)
        .join("; ");
      lines.push(`    ${n.id}: ${detail}${next ? ` → ${next}` : ""}`);
    }
  }
  const errors = s.issues.filter((i) => i.severity === "error");
  lines.push("", errors.length ? `Validation errors: ${errors.map((e) => e.message).join(" ")}` : "Project validates cleanly.");
  lines.push(
    "",
    "Tools: node scripts/mayhem.mjs inspect|validate|simulate|cpp|analyze|live|save, or the MCP server (node scripts/mayhem.mjs mcp). Contract: app/src/suite/core/model.ts. Guide: docs/SUITE_AGENTS.md.",
  );
  return lines.join("\n");
}

export function AgentsPage({ s }: { s: SuiteState }) {
  const [json, setJson] = useState(() => JSON.stringify(s.project, null, 2));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setJson(JSON.stringify(s.project, null, 2));
  }, [s.project, dirty]);
  const mcp = JSON.stringify(
    {
      mcpServers: {
        mayhem: { command: "node", args: ["/path/to/Mayhem/scripts/mayhem.mjs", "mcp"] },
      },
    },
    null,
    2,
  );
  return (
    <div className="mx-page-scroll">
      <PageHeader
        title="Agents"
        subtitle="Agents write the autos and robot code. Mayhem gives them tools and shows you exactly what they changed."
      />
      <div className="mx-agent-grid">
        <Panel title="Share this project with an agent" icon={FileText}>
          <p className="mx-help">
            Paste this into your agent’s chat. It describes the robot, inputs and every routine step in plain text.
          </p>
          <CopyBlock text={agentBrief(s)} label="agent brief" />
        </Panel>

        <Panel
          title="Live file link"
          icon={Link2}
          actions={<Badge tone={s.projectPath ? (s.diskConflict ? "bad" : "good") : "neutral"}>{s.projectPath ? (s.diskConflict ? "Conflict" : "Linked") : "Not linked"}</Badge>}
        >
          <p className="mx-help">
            Save the project as a file in your robot repository. Agents edit that file; this window updates within a
            couple of seconds, and your own edits save back to it with revision checks.
          </p>
          {s.projectPath && <code className="mx-path">{s.projectPath}</code>}
          {s.diskConflict && (
            <p className="mx-help is-bad">
              Someone else changed the file while you were editing. Your edits are kept here; reopen the file to
              reconcile.
            </p>
          )}
          <div className="mx-btn-row">
            {desktop ? (
              <>
                <Button variant="primary" icon={Link2} onClick={() => void s.saveNativeProject()}>
                  {s.projectPath ? "Save as another file" : "Save project file"}
                </Button>
                <Button onClick={() => void s.openNativeProject()}>Open project file</Button>
              </>
            ) : (
              <Button
                icon={ArrowDownToLine}
                onClick={() => download(`${s.project.id}.mayhem.json`, JSON.stringify(s.project, null, 2))}
              >
                Download project file
              </Button>
            )}
          </div>
          {!desktop && <p className="mx-help">Live file links need the desktop app.</p>}
        </Panel>

        <Panel title="Connect over MCP" icon={Plug}>
          <p className="mx-help">
            Add Mayhem to your agent’s MCP servers. It can inspect, validate, simulate and save projects, export C++,
            analyze logs and read live robot values. It cannot deploy code or command the robot.
          </p>
          <CopyBlock text={mcp} label="MCP configuration" />
        </Panel>

        <Panel title="Command line" icon={TerminalSquare}>
          <p className="mx-help">The same tools as plain commands. Requires Node 22.18 or later.</p>
          <CopyBlock
            label="commands"
            text={[
              "node scripts/mayhem.mjs validate robot.mayhem.json",
              "node scripts/mayhem.mjs simulate robot.mayhem.json '{\"mode\":\"path\"}'",
              "node scripts/mayhem.mjs cpp robot.mayhem.json > robot_autos.hpp",
              "node scripts/mayhem.mjs analyze match.wpilog",
              "node scripts/mayhem.mjs live roborio-3256-frc.local",
            ].join("\n")}
          />
        </Panel>

        <Panel
          title="C++ library"
          icon={Code2}
          actions={
            <Button
              size="sm"
              icon={ArrowDownToLine}
              onClick={() => downloadCpp(s.project)}
            >
              Export routines
            </Button>
          }
        >
          <p className="mx-help">
            <code>lib-cpp</code> provides the pose controller, the routine runner and NetworkTables/log observers.
            Exported routines compile against it. Custom C++ can use the controller on its own.
          </p>
          <ul className="mx-list">
            <li>Pose goals with moving handoffs and measured arrival</li>
            <li>Transitions on typed robot inputs</li>
            <li>Any named C++ callback as a step or alongside one</li>
            <li>State publishing so this app can show it live</li>
          </ul>
        </Panel>
      </div>

      <Panel
        title="Project document"
        icon={Braces}
        className="mx-json-panel"
        actions={
          <>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDirty(false);
                  setJson(JSON.stringify(s.project, null, 2));
                }}
              >
                Discard
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty}
              onClick={() => {
                if (s.applyJson(json)) setDirty(false);
              }}
            >
              Validate and apply
            </Button>
          </>
        }
      >
        <textarea
          className="mx-json"
          aria-label="Project JSON"
          spellCheck={false}
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setDirty(true);
          }}
        />
      </Panel>
    </div>
  );
}
