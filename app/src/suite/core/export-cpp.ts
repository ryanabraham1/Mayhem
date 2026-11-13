import {
  resolveNodeConstraints,
  type Condition,
  type SuiteProject,
} from "./model.ts";
import { parseMachineManifest, type MachineManifest } from "./machines.ts";
import { autoNext, isIntermediate } from "./runtime.ts";

/** Machine name robot code reports autonomous routines under (mayhem::kAutonomousMachine). */
export const AUTONOMOUS_MACHINE = "Autonomous";
/** Transition IDs repeat across routines; the Autonomous manifest and C++ observers use this. */
export const qualifiedTransitionId = (routine: string, transition: string) =>
  `${routine}/${transition}`;

/**
 * One manifest covering every routine, for the live viewer and log replay: the union of
 * routine nodes (a node ID shared by several routines is one state) and every routine's
 * transitions with qualified IDs. Matches what AutoRunner::Attach reports.
 */
export function autonomousManifest(project: SuiteProject): MachineManifest | undefined {
  if (!project.routines.length) return undefined;
  const states = new Map<string, MachineManifest["states"][number]>();
  for (const r of project.routines)
    for (const n of r.nodes)
      if (!states.has(n.id))
        states.set(n.id, {
          id: n.id,
          name: n.name || n.id,
          ...(n.description ? { description: n.description } : {}),
          ...(n.source ? { source: n.source } : {}),
        });
  return parseMachineManifest({
    format: "mayhem-machine",
    version: 1,
    id: AUTONOMOUS_MACHINE,
    name: AUTONOMOUS_MACHINE,
    initial: project.routines[0].initial,
    states: [...states.values()],
    transitions: project.routines.flatMap((r) =>
      r.transitions.map((t) => ({ ...t, id: qualifiedTransitionId(r.id, t.id) })),
    ),
    inputs: project.signals,
  });
}

/** `extensions.machines`, validated. Absent means none. */
export function projectMachines(project: SuiteProject): MachineManifest[] {
  const machines = project.extensions?.machines;
  if (machines === undefined) return [];
  if (!Array.isArray(machines))
    throw new Error("extensions.machines must be an array of mayhem-machine manifests.");
  const seen = new Set<string>();
  return machines.map((m, i) => {
    let machine: MachineManifest;
    try {
      machine = parseMachineManifest(m);
    } catch (e) {
      throw new Error(`extensions.machines[${i}]: ${(e as Error).message}`);
    }
    if (seen.has(machine.id) || machine.id === AUTONOMOUS_MACHINE)
      throw new Error(`extensions.machines[${i}]: machine ID ${machine.id} is not unique.`);
    seen.add(machine.id);
    return machine;
  });
}

/** JSON with object keys sorted, so embedded manifests do not depend on file key order. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

const CPP_KEYWORDS = new Set(
  ("alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t " +
    "char32_t class compl concept const consteval constexpr constinit const_cast continue co_await " +
    "co_return co_yield decltype default delete do double dynamic_cast else enum explicit export " +
    "extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq " +
    "nullptr operator or or_eq private protected public register reinterpret_cast requires return " +
    "short signed sizeof static static_assert static_cast struct switch template this thread_local " +
    "throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while " +
    "xor xor_eq std mayhem").split(" "),
);
const GENERATED_NAMES = new Set(["startPose", "fieldLength", "fieldWidth", "routines", "machines", "autonomous"]);
// Standard C/C++ macros a generated name must not collide with.
const CPP_MACROS = new Set(["NULL", "EOF", "INFINITY", "NAN", "errno", "assert", "stdin", "stdout", "stderr"]);

/**
 * C++ identifiers for manifest names (state IDs, input keys), in order: other characters become
 * `_`, a name not starting with a letter gets a `k` prefix, keywords and macros get a trailing `_`,
 * and repeats get `_2`, `_3`. `intake.requested` becomes `intake_requested`.
 */
export function cppIdentifiers(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let id = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/__+/g, "_");
    if (!/^[A-Za-z]/.test(id)) id = "k" + id;
    if (CPP_KEYWORDS.has(id) || CPP_MACROS.has(id)) id += "_";
    let unique = id;
    for (let k = 2; used.has(unique); k++) unique = `${id}_${k}`;
    used.add(unique);
    return unique;
  });
}

/**
 * Header-only C++17 export for the optional Mayhem runtime. Output depends only on
 * project content (not its revision or key order), so it can be checked in CI.
 */
export function exportCpp(project: SuiteProject): string {
  const quoted = (text: string) =>
    '"' +
    [...new TextEncoder().encode(text)]
      .map((c) =>
        c === 34
          ? '\\"'
          : c === 92
            ? "\\\\"
            : c >= 32 && c < 127
              ? String.fromCharCode(c)
              : "\\" + c.toString(8).padStart(3, "0"),
      )
      .join("") +
    '"';
  const signal = (value: boolean | number | string) =>
    typeof value === "boolean"
      ? `mayhem::SignalValue{${value}}`
      : typeof value === "number"
        ? `mayhem::SignalValue{double{${value}}}`
        : `mayhem::SignalValue{std::string_view{${quoted(value)}}}`;
  const expression = (c: Condition): string => {
    if (c.kind === "always") return "std::optional<bool>{true}";
    if (c.kind === "signal")
      return `mayhem::Compare(h.Signal(${quoted(c.key)}), mayhem::CompareOp::${c.op === "eq" ? "Eq" : c.op === "gt" ? "Gt" : "Lt"}, ${signal(c.value)})`;
    if (c.kind === "not") return `mayhem::Not(${expression(c.condition)})`;
    return `mayhem::${c.kind === "all" ? "All" : "Any"}({${c.conditions.map(expression).join(", ")}})`;
  };
  const declare = (type: string, name: string, items: string[]) =>
    items.length
      ? [`inline constexpr std::array<${type},${items.length}> ${name} = {{`, ...items.map((i) => `  ${i},`), "}};"]
      : [`inline constexpr std::array<${type},0> ${name} = {};`];
  // A manifest as ~2 KB literals (MSVC caps one literal at 64 KB), joined by ManifestView::Text().
  const manifest = (machine: MachineManifest) => {
    const parts: string[] = [];
    let part = "",
      bytes = 0;
    for (const ch of canonicalJson(machine)) {
      part += ch;
      bytes += new TextEncoder().encode(ch).length;
      if (bytes >= 2000) parts.push(part), (part = ""), (bytes = 0);
    }
    if (part) parts.push(part);
    return [
      ...declare("std::string_view", "manifestParts", parts.map(quoted)),
      "inline constexpr mayhem::ManifestView manifest{manifestParts.data(),manifestParts.size()};",
    ];
  };
  const pose = (p: { x: number; y: number; heading: number }) => `{${p.x},${p.y},${p.heading}}`;
  const op = (o: "eq" | "gt" | "lt") => `mayhem::CompareOp::${o === "eq" ? "Eq" : o === "gt" ? "Gt" : "Lt"}`;
  const inputType = (t: string) => `mayhem::InputType::${t === "boolean" ? "Boolean" : t === "number" ? "Number" : "String"}`;
  const literal = (value: boolean | number | string) =>
    typeof value === "boolean" ? `${value}` : typeof value === "number" ? `double{${value}}` : `std::string_view{${quoted(value)}}`;
  /** A machine's typed API: State enum, Inputs struct, and guards that read the struct. */
  const typedMachine = (m: MachineManifest, ns: string): string[] => {
    const states = cppIdentifiers(m.states.map((st) => st.id));
    const declared = m.inputs.filter((i) => i.key !== "stateTime");
    const fields = new Map(declared.map((i, k) => [i.key, { input: i, name: cppIdentifiers(declared.map((d) => d.key))[k] }]));
    const typed = (c: Condition): string => {
      if (c.kind === "always") return "std::optional<bool>{true}";
      if (c.kind === "not") return `mayhem::Not(${typed(c.condition)})`;
      if (c.kind !== "signal")
        return `mayhem::${c.kind === "all" ? "All" : "Any"}({${c.conditions.map(typed).join(", ")}})`;
      const field = fields.get(c.key);
      const actual = !field ? "stateTime" : field.input.type === "string" ? `std::string_view{in.${field.name}}` : `in.${field.name}`;
      return `mayhem::CompareTyped(${actual}, ${op(c.op)}, ${literal(c.value)})`;
    };
    const cppType = (t: string) => (t === "boolean" ? "bool" : t === "number" ? "double" : "std::string");
    const initial = (v: boolean | number | string) => (typeof v === "string" ? quoted(v) : `${v}`);
    const comment = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\*\//g, "* /");
    return [
      "// Typed API: mayhem::TypedMachine<Def> (alias Machine). A misspelled state or input does not compile.",
      `enum class State : int { ${states.join(", ")} };`,
      "struct Inputs {",
      ...declared.map((i) => {
        const f = fields.get(i.key)!;
        const note = [
          f.name !== i.key ? `"${i.key}"` : "",
          i.name !== i.key ? i.name : "",
          i.category ?? "",
          i.event ? "event: reset after the first step of each loop" : "",
        ].filter(Boolean).join(" · ");
        return `  ${cppType(i.type)} ${f.name} = ${initial(i.initial)};${note ? ` // ${comment(note)}` : ""}`;
      }),
      "};",
      "struct Def {",
      `  using State = mayhem_generated::${ns}::State; using Inputs = mayhem_generated::${ns}::Inputs;`,
      "  static constexpr const mayhem::MachineView& view = machine;",
      "  static bool Guard([[maybe_unused]] const Inputs& in, std::size_t transition, [[maybe_unused]] double stateTime) {",
      ...(m.transitions.length
        ? [
            "    switch (transition) {",
            ...m.transitions.map((t, i) => `      case ${i}: return (${typed(t.condition)}).value_or(false);`),
            "      default: return false;",
            "    }",
          ]
        : ["    (void)transition; return false;"]),
      "  }",
      "  static mayhem::SignalValue Signal([[maybe_unused]] const Inputs& in, [[maybe_unused]] std::string_view key) {",
      ...declared.map((i) => {
        const f = fields.get(i.key)!;
        return `    if (key == ${quoted(i.key)}) return mayhem::SignalValue{${i.type === "string" ? `std::string_view{in.${f.name}}` : `in.${f.name}`}};`;
      }),
      "    return {};",
      "  }",
      "  static void ClearEvents([[maybe_unused]] Inputs& in) {",
      ...declared.filter((i) => i.event).map((i) => `    in.${fields.get(i.key)!.name} = ${initial(i.initial)};`),
      "  }",
      "};",
      "using Machine = mayhem::TypedMachine<Def>;",
    ];
  };

  const machines = projectMachines(project);
  const autonomous = autonomousManifest(project);
  const output = [
    "// Generated by Mayhem. Edit the project or your custom robot code, then regenerate.",
    `// Project ${project.id.replace(/[\r\n\u2028\u2029]/g, " ")}. SI units, blue-origin coordinates.`,
    "// Depends only on project content; `node scripts/mayhem.mjs cpp <project> --check <this file>` verifies it.",
    "#pragma once",
    "#include <array>",
    "#include <cstddef>",
    "#include <optional>",
    "#include <string>",
    "#include <string_view>",
    '#include "mayhem/auto_runner.hpp"',
    '#include "mayhem/state_machine.hpp"',
    "namespace mayhem_generated {",
    `// Field size for mayhem::AllianceRoutine / FlipPose (project field width x height).`,
    `inline constexpr double fieldLength = ${project.field.width};`,
    `inline constexpr double fieldWidth = ${project.field.height};`,
    `inline constexpr mayhem::Pose startPose${pose(project.robot.start)};`,
  ];
  project.routines.forEach((r, ri) => {
    output.push(`namespace routine_${ri} {`);
    output.push(`inline constexpr std::string_view name = ${quoted(r.name)};`);
    output.push(`inline constexpr mayhem::Pose startPose${pose(r.start ?? project.robot.start)};`);
    r.transitions.forEach((t, i) =>
      output.push(
        `inline bool guard_${i}([[maybe_unused]] const mayhem::RobotHooks& h) { return (${expression(t.condition)}).value_or(false); }`,
      ),
    );
    r.nodes.forEach((n, i) => {
      const markers = n.goal?.markers ?? [];
      if (markers.length)
        output.push(
          `inline constexpr std::array<mayhem::PathMarker,${markers.length}> markers_${i} = {{${markers
            .map((m) =>
              m.kind === "rotation"
                ? `{mayhem::MarkerKind::Rotation,${m.t},${m.heading},{},${m.profiled ?? true}}`
                : `{mayhem::MarkerKind::Event,${m.t},0,std::string_view{${quoted(m.key)}},true}`,
            )
            .join(",")}}};`,
        );
      if (n.during?.length)
        output.push(
          `inline constexpr std::array<std::string_view,${n.during.length}> during_${i} = {${n.during.map(quoted).join(",")}};`,
        );
    });
    const nodes = r.nodes.map((n, i) => {
      const g = n.goal,
        c = resolveNodeConstraints(project, r, n);
      const markers = g?.markers?.length ? `markers_${i}.data(),markers_${i}.size()` : "nullptr,0";
      const goal = g
        ? `{{${g.x},${g.y},${g.heading}},${g.translationTolerance},${g.rotationTolerance},${g.velocityTolerance},${g.settleTime},${g.handoffRadius},mayhem::HeadingMode::${g.headingMode === "pointAt" ? "PointAt" : g.headingMode === "motion" ? "Motion" : g.headingMode === "free" ? "Free" : "Fixed"},${g.aimX ?? 0},${g.aimY ?? 0},${!!g.stop},${g.projectedHandoff ?? false},${g.profiled ?? true},${markers},${g.headingOffset ?? 0}}`
        : "{}";
      const next = autoNext(r, n);
      const nextIndex = next ? r.nodes.indexOf(next) : -1;
      return `{${quoted(n.id)},mayhem::NodeKind::${n.kind === "pose" ? "Pose" : n.kind === "finish" ? "Finish" : n.kind === "custom" ? "Custom" : "Action"},${goal},${n.timeout},${quoted(n.action ?? "")},{${c.maxVelocity},${c.maxAcceleration},${c.maxAngularVelocity},${c.maxAngularAcceleration},${c.translationKp},${c.rotationKp},${c.handoffRadius},${c.crossTrackKp},${c.minVelocity},${c.anticipateSpeedCaps}},${n.during?.length ? `during_${i}.data(),during_${i}.size()` : "nullptr,0"},${nextIndex},${isIntermediate(r, n)}}`;
    });
    output.push(
      ...declare("mayhem::AutoNode", "nodes", nodes),
      ...declare(
        "mayhem::AutoTransition",
        "transitions",
        r.transitions.map((t, i) => `{${quoted(t.id)},${quoted(t.from)},${quoted(t.to)},guard_${i}}`),
      ),
      `inline constexpr mayhem::RoutineView routine{${quoted(r.id)},${quoted(r.initial)},nodes.data(),nodes.size(),transitions.data(),transitions.size()};`,
      `inline constexpr mayhem::RoutineInfo info{name,routine,startPose};`,
      "}",
    );
  });
  output.push(
    "// Every routine in project order: {name (chooser label), routine, startPose}.",
    ...declare("mayhem::RoutineInfo", "routines", project.routines.map((_, i) => `routine_${i}::info`)),
  );
  if (autonomous)
    output.push(
      `// All routines as one "${AUTONOMOUS_MACHINE}" mayhem-machine manifest; transition IDs are "<routine>/<transition>".`,
      "namespace autonomous {",
      ...manifest(autonomous),
      "}",
    );
  const aliases = new Set<string>();
  machines.forEach((m, mi) => {
    output.push(`namespace machine_${mi} {`, `inline constexpr std::string_view id = ${quoted(m.id)};`);
    m.transitions.forEach((t, i) => {
      output.push(
        `inline bool guard_${i}([[maybe_unused]] const mayhem::SignalSource& h) { return (${expression(t.condition)}).value_or(false); }`,
      );
      if (t.except?.length) output.push(...declare("std::string_view", `except_${i}`, t.except.map(quoted)));
    });
    output.push(
      ...declare("mayhem::MachineState", "states", m.states.map((s) => `{${quoted(s.id)}}`)),
      ...declare(
        "mayhem::MachineTransition",
        "transitions",
        m.transitions.map(
          (t, i) =>
            `{${quoted(t.id)},${quoted(t.from)},${quoted(t.to)},guard_${i}${t.except?.length ? `,except_${i}.data(),except_${i}.size()` : ""}}`,
        ),
      ),
      "// Declared inputs: key, log channel (empty: Mayhem/States/<id>/inputs/<key>), type, one-shot event, initial value.",
      ...declare(
        "mayhem::MachineInput",
        "inputs",
        m.inputs.map(
          (i) =>
            `{${quoted(i.key)},${quoted(i.channel ?? "")},${inputType(i.type)},${!!i.event},mayhem::SignalValue{${literal(i.initial)}}}`,
        ),
      ),
      ...manifest(m),
      `inline constexpr mayhem::MachineView machine{id,${quoted(m.initial)},states.data(),states.size(),transitions.data(),transitions.size(),manifest,${m.selection === "priority"},${m.inputs.length ? "inputs.data(),inputs.size()" : "nullptr,0"}};`,
      ...typedMachine(m, `machine_${mi}`),
      "}",
    );
    const alias = m.id;
    if (
      /^[A-Za-z][A-Za-z0-9_]*$/.test(alias) &&
      !alias.includes("__") &&
      !CPP_KEYWORDS.has(alias) &&
      !GENERATED_NAMES.has(alias) &&
      !/^(routine|machine)_\d+$/.test(alias) &&
      !aliases.has(alias)
    ) {
      aliases.add(alias);
      output.push(`namespace ${alias} = machine_${mi};`);
    }
  });
  output.push(
    "// Every extensions.machines graph in project order; run one with mayhem::StateMachine.",
    ...declare("mayhem::MachineView", "machines", machines.map((_, i) => `machine_${i}::machine`)),
    "} // namespace mayhem_generated",
    "",
  );
  return output.join("\n");
}
