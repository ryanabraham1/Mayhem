#!/usr/bin/env node
// Node 22.18+ strips TypeScript: UI and agents share the exact authoring/preview core.
import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  mkdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseProject, validateProject } from "../app/src/suite/core/model.ts";
import { sampleProject } from "../app/src/suite/core/sample.ts";
import { exportCpp } from "../app/src/suite/core/export-cpp.ts";
import { simulate } from "../app/src/suite/core/runtime.ts";
import { analyze, parseRecordingJSON } from "../app/src/suite/core/analysis.ts";
import { NT4Observer } from "../app/src/suite/core/nt4.ts";
import { parseWPILog } from "../app/src/suite/core/wpilog.ts";
const tools = [
  {
    name: "inspect_live_robot",
    description:
      "Read current NT4 states, schema manifests, and explicitly requested signal topics. This client cannot publish or command the robot.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        topics: { type: "array", items: { type: "string" } },
        durationMs: { type: "integer", minimum: 100, maximum: 5000 },
      },
      required: ["host"],
    },
  },
  {
    name: "export_cpp",
    description:
      "Generate a standalone C++ header for the optional Mayhem AutoRunner. Custom robot code remains unrestricted. Returns code; does not deploy.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "inspect_project",
    description:
      "Read the full Mayhem project. Extensions and custom action IDs are open; the editor is not a limit on robot code.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "validate_project",
    description: "Validate a Mayhem project and return actionable issues.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "object" } },
      required: ["project"],
    },
  },
  {
    name: "save_project",
    description:
      "Atomically replace a valid project with optimistic revision checking. expectedRevision=null creates a new file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        project: { type: "object" },
        expectedRevision: { type: ["integer", "null"] },
      },
      required: ["path", "project", "expectedRevision"],
    },
  },
  {
    name: "simulate_auto",
    description:
      "Run a deterministic pose/condition preview. This ideal plant cannot validate real mechanism code. Sensors change only through supplied signal values. Frozen drive must fail its watchdog.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        routine: { type: "string" },
        signals: { type: "object" },
        freezeDrive: { type: "boolean" },
        maxSeconds: { type: "number" },
        mode: { type: "string", enum: ["path", "routine"] },
        actions: { type: "object", additionalProperties: { type: "string", enum: ["running", "succeeded", "failed"] } },
      },
      required: ["path"],
    },
  },
  {
    name: "analyze_log",
    description:
      "Read a local WPILOG 1.0 or recording JSON and return measured power findings and logging coverage. Optionally map voltage/current/brownout names.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, mapping: { type: "object" }, policy: { type: "object" } },
      required: ["path"],
    },
  },
];
function pathFor(path) {
  if (typeof path !== "string" || !path.trim())
    throw new Error("A file path is required.");
  return resolve(path);
}
export async function execute(name, args) {
  if (name === "validate_project")
    return { issues: validateProject(args.project) };
  if (name === "inspect_live_robot") {
    if (typeof args.host !== "string" || !args.host)
      throw new Error("A robot address is required");
    const duration = args.durationMs ?? 1000;
    if (!Number.isInteger(duration) || duration < 100 || duration > 5000)
      throw new Error("durationMs must be 100–5000");
    if (
      args.topics !== undefined &&
      (!Array.isArray(args.topics) ||
        args.topics.some((t) => typeof t !== "string"))
    )
      throw new Error("Topics must be strings");
    return await new Promise((resolve, reject) => {
      let latest = { status: "disconnected", topics: {} };
      const observer = new NT4Observer(args.host, (value) => {
        latest = value;
      });
      observer.setExtraTopics(args.topics ?? []);
      observer.connect();
      setTimeout(() => {
        const result = latest;
        observer.disconnect();
        if (result.status !== "connected")
          reject(new Error(result.error ?? "Could not read a connected robot"));
        else resolve(result);
      }, duration);
    });
  }
  const path = pathFor(args.path);
  if (name === "export_cpp")
    return { code: exportCpp(parseProject(await readFile(path, "utf8"))) };
  if (name === "inspect_project")
    return parseProject(await readFile(path, "utf8"));
  if (name === "save_project") {
    const project = parseProject(JSON.stringify(args.project));
    await mkdir(dirname(path), { recursive: true });
    const lock = await open(path + ".lock", "wx");
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      let previous = null;
      try {
        previous = parseProject(await readFile(path, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (args.expectedRevision !== (previous?.revision ?? null))
        throw new Error(
          `Revision conflict: current revision is ${previous?.revision ?? "new"}. Re-read before editing.`,
        );
      project.revision = previous ? previous.revision + 1 : 0;
      await writeFile(temporary, JSON.stringify(project, null, 2) + "\n");
      await rename(temporary, path);
      return { path, revision: project.revision };
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(path + ".lock");
    }
  }
  if (name === "simulate_auto") {
    const project = parseProject(await readFile(path, "utf8"));
    const routine = args.routine
      ? project.routines.find((r) => r.id === args.routine)
      : project.routines[0];
    if (!routine) throw new Error("Routine ID does not exist.");
    const signals = Object.fromEntries(
      project.signals.map((s) => [s.key, s.initial]),
    );
    for (const [key, value] of Object.entries(args.signals ?? {})) {
      const definition = project.signals.find((s) => s.key === key);
      if (
        !definition ||
        typeof value !== definition.type ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new Error(`Invalid signal ${key}`);
      signals[key] = value;
    }
    if (
      args.maxSeconds !== undefined &&
      (!Number.isFinite(args.maxSeconds) ||
        args.maxSeconds <= 0 ||
        args.maxSeconds > 600)
    )
      throw new Error("maxSeconds must be in (0,600].");
    if (args.mode !== undefined && !["path", "routine"].includes(args.mode)) throw new Error("mode must be path or routine.");
    if (args.actions !== undefined) {
      const callbacks = new Set(routine.nodes.flatMap(node => [...(node.during ?? []), ...(node.action ? [node.action] : [])]));
      if (!args.actions || typeof args.actions !== "object" || Array.isArray(args.actions)) throw new Error("actions must map callback IDs to statuses.");
      for (const [id, status] of Object.entries(args.actions))
        if (!callbacks.has(id) || !["running", "succeeded", "failed"].includes(status)) throw new Error(`Invalid action status for ${id}`);
    }
    const result = simulate(project, routine, signals, args);
    return {
      mode: args.mode ?? "routine",
      status: result.status,
      time: result.frame.time,
      pose: result.frame.pose,
      events: result.frame.events,
      steps: result.frames.length - 1,
    };
  }
  if (name === "analyze_log") {
    const bytes = await readFile(path);
    const recording = path.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          path,
        )
      : parseRecordingJSON(bytes.toString("utf8"));
    return {
      name: recording.name,
      duration: recording.duration,
      channels: recording.channels.map((c) => ({
        name: c.name,
        type: c.type,
        samples: c.samples.length,
      })),
      warnings: recording.warnings,
      ...analyze(recording, args.mapping, args.policy),
    };
  }
  throw new Error(`Unknown tool ${name}`);
}
async function main() {
  const [command, path, json] = process.argv.slice(2);
  if (command === "mcp") {
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      let request;
      try {
        request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result;
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mayhem-suite", version: "0.1.0" },
            instructions:
              "Use BLine-style live-pose goals and measured-condition transitions by default. You may implement arbitrary C++ and custom action callbacks. The visual model documents behavior, not a restriction on capabilities. See docs/SUITE_AGENTS.md.",
          };
        else if (request.method === "tools/list") result = { tools };
        else if (request.method === "tools/call") {
          try {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    await execute(
                      request.params.name,
                      request.params.arguments ?? {},
                    ),
                  ),
                },
              ],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        } else if (request.method === "ping") result = {};
        else {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            }) + "\n",
          );
          continue;
        }
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32700, message: error.message },
          }) + "\n",
        );
      }
    }
    return;
  }
  if (command === "example") {
    console.log(JSON.stringify(sampleProject, null, 2));
    return;
  }
  const names = {
    inspect: "inspect_project",
    validate: "validate_project",
    save: "save_project",
    simulate: "simulate_auto",
    analyze: "analyze_log",
    cpp: "export_cpp",
    live: "inspect_live_robot",
  };
  if (!names[command])
    throw new Error(
      "Usage: node scripts/mayhem.mjs example | inspect <file> | validate <file> | simulate <file> [options JSON] | analyze <log> [options JSON] | save <file> <{project,expectedRevision}> | cpp <file> | live <robot-address> [options JSON] | mcp",
    );
  const args = { ...(json ? JSON.parse(json) : {}), path };
  if (command === "validate")
    args.project = JSON.parse(await readFile(path, "utf8"));
  if (command === "live") args.host = path;
  const result = await execute(names[command], args);
  console.log(
    command === "cpp" ? result.code : JSON.stringify(result, null, 2),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
