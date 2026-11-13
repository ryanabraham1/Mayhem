/**
 * A small, deterministic reader for the constants in robot C++ headers: `constexpr`/`const`
 * declarations at namespace or class scope, and CTRE-style configuration chains
 * (`TalonFXConfiguration{}.WithCurrentLimits(CurrentLimitsConfigs{}.WithStatorCurrentLimit(80_A))`)
 * in functions or initializers. It is not a C++ parser: it reads the declaration shapes robot code
 * uses for tunable values and reports, never guesses, anything it cannot evaluate.
 */

export interface CppConstant {
  /** Fully qualified, e.g. `shooter::kMotorIds` or `TunerConstants::kPigeonId`. */
  name: string;
  /** The declared name only. */
  short: string;
  /** Enclosing namespaces/classes, outermost first. */
  scope: string[];
  type: string;
  /** Initializer as written, comments removed and whitespace collapsed. */
  expression: string;
  /** Per-element trailing comments of a brace list (`44,  // top left`). */
  elementNotes?: string[];
  /** The doc comment above it, or a trailing comment on its line. */
  doc?: string;
  file: string;
  line: number;
}

export interface CppConfig {
  /** Function or variable that builds the configuration, fully qualified. */
  name: string;
  short: string;
  scope: string[];
  /** Another configuration this one starts from (`auto c = RightMotorConfigs();`). */
  base?: string;
  /** `CurrentLimits.StatorCurrentLimit` → `80_A`, in application order (last write wins). */
  settings: Record<string, string>;
  doc?: string;
  file: string;
  line: number;
}

export interface CppFile {
  constants: CppConstant[];
  configs: CppConfig[];
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

interface Scope {
  kind: "namespace" | "class" | "function" | "block";
  name: string;
  /** Function bodies: their text, comments removed. */
  body?: string;
  line?: number;
  doc?: string;
}

/** Splits `text` into statements, tracking namespace/class/function scopes. */
export function readCpp(file: string, text: string): CppFile {
  const constants: CppConstant[] = [];
  const configs: CppConfig[] = [];
  const scopes: Scope[] = [];
  let buffer = "";
  let raw = "";
  let doc: string | undefined;
  let lastCommentLine = -10;
  let statementLine = 0;
  let line = 1;
  let nest = 0; // braces inside the current statement (brace initializers)
  const names = () => scopes.filter((s) => s.kind === "namespace" || s.kind === "class").flatMap((s) => s.name.split("::"));
  const inFunction = () => scopes.find((s) => s.kind === "function");

  const finish = () => {
    const code = collapse(buffer.replace(/\b(public|private|protected)\s*:/g, ""));
    const fn = inFunction();
    if (fn) fn.body = (fn.body ?? "") + " " + code + ";";
    else if (code && !scopes.some((s) => s.kind === "block")) declaration(code, raw, statementLine);
    buffer = "";
    raw = "";
    doc = undefined;
  };

  const declaration = (code: string, rawText: string, at: number) => {
    if (!/\b(constexpr|const)\b/.test(code) || /^(using|typedef|template|friend|return|static_assert)\b/.test(code)) return;
    // The first `=` or `{` outside template brackets ends the declarator.
    let angle = 0,
      split = -1;
    for (let k = 0; k < code.length; k++) {
      const ch = code[k];
      if (ch === "<") angle++;
      else if (ch === ">") angle = Math.max(0, angle - 1);
      else if (angle === 0 && (ch === "=" || ch === "{")) {
        split = k;
        break;
      }
    }
    if (split < 0) return;
    const head = code.slice(0, split).trim();
    if (head.includes("(")) return; // a function declaration
    const match = /([A-Za-z_]\w*)\s*$/.exec(head);
    if (!match) return;
    const short = match[1];
    const type = collapse(head.slice(0, match.index).replace(/\b(inline|static|constexpr|const|extern|constinit)\b/g, ""));
    if (!type) return;
    let expression = code.slice(split).trim();
    expression = expression.startsWith("=") ? expression.slice(1).trim() : expression;
    const scope = names();
    const name = [...scope, short].join("::");
    if (expression.includes(".With")) {
      configs.push({ name, short, scope, settings: chainSettings(expression), ...(doc ? { doc } : {}), file, line: at });
      return;
    }
    const notes = elementNotes(rawText);
    constants.push({
      name,
      short,
      scope,
      type,
      expression,
      ...(notes ? { elementNotes: notes } : {}),
      ...(doc ? { doc } : {}),
      file,
      line: at,
    });
  };

  const closeFunction = (fn: Scope) => {
    const body = fn.body ?? "";
    if (!body.includes(".With")) return;
    const scope = names();
    const base = /=\s*([\w:]+)\s*\(\s*\)\s*;/.exec(body)?.[1];
    const settings: Record<string, string> = {};
    // Every chain in the body, in order: `return X{}.With…;` and `c.With…;`.
    for (const statement of body.split(";")) if (statement.includes(".With")) Object.assign(settings, chainSettings(statement));
    configs.push({
      name: [...scope, fn.name].join("::"),
      short: fn.name,
      scope,
      ...(base ? { base: resolveName(base, scope) } : {}),
      settings,
      ...(fn.doc ? { doc: fn.doc } : {}),
      file,
      line: fn.line ?? 0,
    });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") {
      line++;
      if (buffer.trim()) raw += "\n";
      continue;
    }
    // Comments.
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const comment = text.slice(i + 2, end < 0 ? text.length : end).trim();
      const trailing = buffer.trim().length > 0;
      if (trailing) raw += ` /*${comment}*/`;
      else {
        doc = lastCommentLine === line - 1 && doc ? `${doc} ${comment}` : comment;
        lastCommentLine = line;
      }
      // A trailing comment on a finished declaration's line (`x = 0;  // dk yet`).
      if (!trailing && constants.length && constants[constants.length - 1].line === line && !constants[constants.length - 1].doc)
        constants[constants.length - 1].doc = comment;
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const body = text.slice(i + 2, end < 0 ? text.length : end);
      line += (body.match(/\n/g) ?? []).length;
      if (!buffer.trim())
        doc = collapse(body.replace(/^\s*\*+/gm, " ").replace(/^\*/, ""));
      lastCommentLine = line;
      i = (end < 0 ? text.length : end + 2) - 1;
      continue;
    }
    // Strings and characters, copied verbatim.
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < text.length && text[k] !== ch) k += text[k] === "\\" ? 2 : 1;
      buffer += text.slice(i, k + 1);
      raw += text.slice(i, k + 1);
      i = k;
      continue;
    }
    // Preprocessor lines.
    if (ch === "#" && !buffer.trim()) {
      let end = text.indexOf("\n", i);
      while (end > 0 && text[end - 1] === "\\") end = text.indexOf("\n", end + 1);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (!buffer.trim() && /\S/.test(ch)) {
      statementLine = line;
      // Only a comment directly above documents the declaration (not the license header).
      if (lastCommentLine < line - 1) doc = undefined;
    }
    if (ch === "{") {
      if (nest > 0) {
        nest++;
        buffer += ch;
        raw += ch;
        continue;
      }
      const head = collapse(buffer);
      const ns = /(?:^|\s)namespace\s*([\w:]*)\s*$/.exec(head);
      const cls = /(?:^|\s)(?:class|struct|union|enum(?:\s+class)?)\s+(\w+)[^{]*$/.exec(head);
      if (ns) {
        scopes.push({ kind: "namespace", name: ns[1] || "(anonymous)" });
        buffer = raw = "";
        doc = undefined;
      } else if (cls && !/=/.test(head)) {
        scopes.push({ kind: "class", name: cls[1] });
        buffer = raw = "";
        doc = undefined;
      } else if (/\)\s*(const|noexcept|override|final|\s)*$/.test(head) || /^(else|do|try)$/.test(head) || /^extern "C"$/.test(head)) {
        const name = /([\w:~]+)\s*\([^()]*(\([^()]*\)[^()]*)*\)[\s\w]*$/.exec(head)?.[1] ?? "";
        const control = /^(if|for|while|switch|catch|else|do|try)\b/.test(head) || inFunction() !== undefined;
        scopes.push(control ? { kind: "block", name: "" } : { kind: "function", name: name.split("::").pop() ?? name, body: "", line: statementLine, doc });
        buffer = raw = "";
        doc = undefined;
      } else {
        nest = 1;
        buffer += ch;
        raw += ch;
      }
      continue;
    }
    if (ch === "}") {
      if (nest > 0) {
        nest--;
        buffer += ch;
        raw += ch;
        continue;
      }
      if (buffer.trim()) finish();
      const closed = scopes.pop();
      if (closed?.kind === "function") closeFunction(closed);
      buffer = raw = "";
      doc = undefined;
      continue;
    }
    // `public:` etc. end nothing but must not glue onto the next declaration or its comments.
    if (ch === ":" && next !== ":" && nest === 0 && /^\s*(public|private|protected)\s*$/.test(buffer)) {
      buffer = raw = "";
      continue;
    }
    if (ch === ";" && nest === 0) {
      finish();
      continue;
    }
    buffer += ch;
    raw += ch;
  }
  return { constants, configs };
}

/** `a::b` relative to the scope it is written in, as a qualified name guess (the first match wins later). */
function resolveName(name: string, scope: string[]) {
  return name.includes("::") ? name : [...scope, name].join("::");
}

/** Trailing per-element comments in a brace list, when every element has one. */
function elementNotes(raw: string): string[] | undefined {
  if (!raw.includes("/*")) return undefined;
  const notes = [...raw.matchAll(/,?\s*\/\*([^*]*)\*\//g)].map((m) => m[1].trim());
  return notes.length > 1 ? notes : undefined;
}

/** Splits `a, b(c, d), e` at top-level commas. */
export function splitTop(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, k).trim());
      start = k + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** Flattens `.WithX(Y{}.WithZ(1))` into `{ "X.Z": "1" }` (later calls overwrite earlier ones). */
export function chainSettings(expression: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const call = /\.With(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(expression))) {
    // The call's argument, balanced.
    let depth = 1,
      k = call.lastIndex;
    for (; k < expression.length && depth > 0; k++) {
      if (expression[k] === "(") depth++;
      else if (expression[k] === ")") depth--;
    }
    const argument = expression.slice(call.lastIndex, k - 1).trim();
    const key = prefix ? `${prefix}.${m[1]}` : m[1];
    if (argument.includes(".With")) Object.assign(out, chainSettings(argument, key));
    else out[key] = collapse(argument);
    call.lastIndex = k;
  }
  return out;
}
