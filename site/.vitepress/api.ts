// The MayhemLib API reference. lib/src/doclet exports the public API and its Javadoc to
// api/mayhemlib.json (`./gradlew apiJson` in lib/); this turns it into the sidebar and one
// markdown page per type at /api/<package>/<Type>.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DefaultTheme } from "vitepress";

export const BASE = "/Mayhem/";
const REPO = "https://github.com/ryanabraham1/Mayhem";

export interface ApiParam {
  name: string;
  type: string;
  typeText: string;
  doc?: string;
}
export interface ApiMember {
  name: string;
  kind?: "method" | "constructor";
  anchor: string;
  modifiers?: string[];
  doc?: string;
  summary?: string;
  mayhemOnly?: boolean;
  deprecated?: string;
  since?: string;
  see?: string[];
  // fields
  type?: string;
  typeText?: string;
  default?: string;
  // methods and constructors
  typeParams?: string;
  returns?: string;
  returnsText?: string;
  returnDoc?: string;
  params?: ApiParam[];
  shortSignature?: string;
  throws?: { type: string; doc: string }[];
  thrownTypes?: string[];
  specifiedBy?: string;
}
export interface ApiType {
  name: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  url: string;
  modifiers: string[];
  signature: string;
  doc?: string;
  summary?: string;
  see?: string[];
  deprecated?: string;
  enclosing?: string;
  enumConstants: ApiMember[];
  fields: ApiMember[];
  constructors: ApiMember[];
  methods: ApiMember[];
  nested: { name: string; kind: string; url: string; summary?: string }[];
}
export interface ApiPackage {
  name: string;
  slug: string;
  doc?: string;
  summary?: string;
  types: ApiType[];
}
export interface Api {
  version: string;
  packages: ApiPackage[];
}

const jsonPath = fileURLToPath(new URL("../api/mayhemlib.json", import.meta.url));

export function loadApi(): Api {
  return JSON.parse(readFileSync(jsonPath, "utf-8"));
}

/** Packages most teams never touch, shown last and collapsed. */
export const INTERNAL_PACKAGES = new Set(["runner", "telemetry", "geometry"]);

export const KIND_LETTER: Record<string, string> = {
  class: "C",
  interface: "I",
  enum: "E",
  record: "R",
  annotation: "@",
};

/** "@api/auto/AutoTrajectory#cmd" (doclet placeholder) -> a site path without the base. */
export function apiPath(url: string): string {
  return url.replace(/^@api\//, "/api/");
}

export function apiSidebar(api: Api): DefaultTheme.SidebarItem[] {
  const order = [...api.packages].sort(
    (a, b) => Number(INTERNAL_PACKAGES.has(a.slug)) - Number(INTERNAL_PACKAGES.has(b.slug)),
  );
  return [
    {
      text: "API reference",
      items: [
        { text: "Overview", link: "/api/" },
        { text: "Classic Javadoc ↗", link: "https://ryanabraham1.github.io/Mayhem/javadoc/" },
      ],
    },
    ...order.map((p) => ({
      text: p.name,
      collapsed: p.slug !== "auto",
      items: p.types.map((t) => ({
        text: `<span class="api-kind api-kind-${t.kind}">${KIND_LETTER[t.kind]}</span>${t.name}`,
        link: apiPath(t.url),
      })),
    })),
  ];
}

// ------------------------------------------------------------------------------------ pages

/**
 * Javadoc writes paragraphs as bare <p> separators, which Vue's template compiler rejects as
 * unclosed. Turns "a <p>b <p>c" into "<p>a</p><p>b</p><p>c</p>".
 */
function closeParagraphs(html: string): string {
  if (!/<p>/i.test(html) || /<\/p>/i.test(html)) return html;
  return ("<p>" + html.replace(/<p>/gi, "</p><p>") + "</p>").replace(/<p>\s*<\/p>/g, "");
}

/** Makes doclet HTML safe to drop into a markdown page as one HTML block. */
function inline(html: string): string {
  return html
    .replace(/href="@api\//g, `href="${BASE}api/`)
    .replace(/<a href="(https?:[^"]+)">/g, '<a href="$1" target="_blank" rel="noreferrer">')
    .replace(/\{\{/g, "&#123;&#123;")
    .replace(/\s+/g, " ")
    .trim();
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function dedent(code: string): string {
  const lines = code.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
  );
  return lines.map((l) => l.slice(indent)).join("\n");
}

/** A doc comment as markdown: HTML blocks, with {@code} examples as highlighted fences. */
function docBlock(html: string | undefined, cls = "api-doc"): string {
  if (!html) return "";
  const out: string[] = [];
  const re = /<pre>\s*<code class="language-java">([\s\S]*?)<\/code>\s*<\/pre>/g;
  let last = 0;
  for (let m; (m = re.exec(html)); ) {
    const before = html.slice(last, m.index);
    if (before.trim()) out.push(`<div class="${cls}">${inline(closeParagraphs(before))}</div>`);
    out.push("```java\n" + dedent(unescapeHtml(m[1])) + "\n```");
    last = m.index + m[0].length;
  }
  const rest = html.slice(last);
  if (rest.trim()) out.push(`<div class="${cls}">${inline(closeParagraphs(rest))}</div>`);
  return out.join("\n\n");
}

function headingText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([[\]*_`])/g, "\\$1");
}

const MAYHEM_BADGE = '<span class="api-badge api-badge-mayhem">MayhemLib</span>';

function signature(m: ApiMember, owner: ApiType): string {
  const mods = (m.modifiers ?? [])
    .filter((x) => !(owner.kind === "interface" && (x === "public" || x === "abstract")))
    .map((x) => `<span class="kw">${x}</span> `)
    .join("");
  const tps = m.typeParams ? `${m.typeParams} ` : "";
  const params = (m.params ?? []).map((p) => `${p.type} ${p.name}`);
  const ret = m.kind === "constructor" ? "" : `${m.returns} `;
  const head = `${mods}${tps}${ret}<span class="name">${m.name}</span>(`;
  const oneLine = head + params.join(", ") + ")";
  const textLength = oneLine.replace(/<[^>]+>/g, "").length;
  let sig = textLength > 80 && params.length > 1 ? head + "\n    " + params.join(",\n    ") + ")" : oneLine;
  if (m.thrownTypes?.length) sig += ` <span class="kw">throws</span> ${m.thrownTypes.join(", ")}`;
  return sig;
}

function sigBlock(sig: string): string {
  // Newlines become entities so the whole block stays one markdown HTML line.
  const html = inline(sig.replace(/\n {4}/g, "\u0000")).replace(/\u0000\s?/g, "&#10;&#32;&#32;&#32;&#32;");
  return `<div class="api-sig"><pre>${html}</pre></div>`;
}

function details(m: ApiMember): string {
  const rows: string[] = [];
  const params = (m.params ?? []).filter((p) => p.doc);
  if (params.length) {
    rows.push(
      `<dt>Parameters</dt><dd>${params.map((p) => `<div><code>${p.name}</code> ${closeParagraphs(p.doc!)}</div>`).join("")}</dd>`,
    );
  }
  if (m.returnDoc) rows.push(`<dt>Returns</dt><dd>${closeParagraphs(m.returnDoc)}</dd>`);
  if (m.throws?.length) {
    rows.push(`<dt>Throws</dt><dd>${m.throws.map((t) => `<div><code>${t.type}</code> ${t.doc}</div>`).join("")}</dd>`);
  }
  if (m.specifiedBy) rows.push(`<dt>Specified by</dt><dd>${m.specifiedBy}</dd>`);
  if (m.see?.length) rows.push(`<dt>See also</dt><dd>${m.see.join(", ")}</dd>`);
  if (m.since) rows.push(`<dt>Since</dt><dd>${m.since}</dd>`);
  return rows.length ? `<dl class="api-dl">${inline(rows.join(""))}</dl>` : "";
}

function memberSection(m: ApiMember, owner: ApiType): string {
  const parts = [`### ${headingText(m.shortSignature ?? m.name)} {#${m.anchor}}`];
  if (m.mayhemOnly || m.deprecated) {
    const badges = [
      m.mayhemOnly ? MAYHEM_BADGE : "",
      m.deprecated ? '<span class="api-badge api-badge-deprecated">Deprecated</span>' : "",
    ].join("");
    parts.push(`<div class="api-badges">${badges}</div>`);
  }
  parts.push(sigBlock(signature(m, owner)));
  if (m.deprecated) parts.push(`<div class="api-deprecated">${inline(closeParagraphs(m.deprecated))}</div>`);
  if (m.doc) parts.push(docBlock(m.doc));
  const dl = details(m);
  if (dl) parts.push(dl);
  return parts.join("\n\n");
}

function summaryRow(m: ApiMember, owner: ApiType): string {
  const params = (m.params ?? []).map((p) => `${p.type} ${p.name}`).join(", ");
  const ret = m.kind === "constructor" ? "" : `<span class="api-ret">${m.returns}</span> `;
  const isStatic = m.modifiers?.includes("static") ? '<span class="kw">static</span> ' : "";
  const sig = `${isStatic}${ret}<a class="api-member" href="#${m.anchor}">${m.name}</a>(${params})`;
  const badge = m.mayhemOnly ? ` ${MAYHEM_BADGE}` : "";
  return `<div class="api-row"><div class="api-row-sig">${sig}</div><div class="api-row-doc">${m.summary ?? ""}${badge}</div></div>`;
}

function methodGroups(methods: ApiMember[]): [string, ApiMember[]][] {
  const groups = new Map<string, ApiMember[]>();
  const add = (g: string, m: ApiMember) => groups.set(g, [...(groups.get(g) ?? []), m]);
  for (const m of methods) {
    if (m.modifiers?.includes("static")) add("Static methods", m);
    else if (m.returnsText === "Command") add("Commands", m);
    else if (m.returnsText === "Trigger") add("Triggers", m);
    else add("Methods", m);
  }
  const order = ["Static methods", "Commands", "Triggers", "Methods"];
  return order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g)!]);
}

function sourceUrl(pkg: ApiPackage, t: ApiType): string {
  const outer = t.name.split(".")[0];
  return `${REPO}/blob/main/lib/src/main/java/${pkg.name.replace(/\./g, "/")}/${outer}.java`;
}

export function renderType(pkg: ApiPackage, t: ApiType): string {
  const out: string[] = [];
  const crumb = t.enclosing
    ? `<a href="${BASE}api/#${pkg.slug}">${pkg.name}</a> <span class="sep">/</span> <a href="${BASE}${apiPath(pkg.types.find((x) => x.name === t.enclosing)!.url).slice(1)}">${t.enclosing}</a>`
    : `<a href="${BASE}api/#${pkg.slug}">${pkg.name}</a>`;
  out.push(`<div class="api-crumb">${crumb}</div>`);
  out.push(`# ${headingText(t.name)}`);
  const kindLabel = `${t.modifiers.includes("final") && t.kind === "class" ? "final " : ""}${t.modifiers.includes("abstract") && t.kind === "class" ? "abstract " : ""}${t.kind}`;
  out.push(
    `<div class="api-badges"><span class="api-badge api-badge-${t.kind}">${kindLabel}</span>${t.deprecated ? '<span class="api-badge api-badge-deprecated">Deprecated</span>' : ""}</div>`,
  );
  out.push(sigBlock(t.signature));
  if (t.deprecated) out.push(`<div class="api-deprecated">${inline(closeParagraphs(t.deprecated))}</div>`);
  if (t.doc) out.push(docBlock(t.doc));
  const see = t.see?.length ? ` <span class="sep">·</span> See also ${t.see.join(", ")}` : "";
  out.push(
    `<div class="api-links">${inline(`<a href="${sourceUrl(pkg, t)}">${t.name.split(".")[0]}.java ↗</a>${see}`)}</div>`,
  );

  if (t.nested.length) {
    out.push("## Nested types");
    out.push(
      `<div class="api-rows">${t.nested
        .map(
          (n) =>
            `<div class="api-row"><div class="api-row-sig"><span class="kw">${n.kind}</span> <a class="api-member" href="${BASE}${apiPath(n.url).slice(1)}">${n.name.split(".").pop()}</a></div><div class="api-row-doc">${n.summary ?? ""}</div></div>`,
        )
        .join("")}</div>`.replace(/\s+/g, " "),
    );
  }

  if (t.enumConstants.length) {
    out.push("## Constants");
    const rows = t.enumConstants
      .map((c) => `<tr id="${c.anchor}"><td><code>${c.name}</code></td><td>${closeParagraphs(c.doc ?? "")}</td></tr>`)
      .join("");
    out.push(`<div class="api-table"><table><thead><tr><th>Constant</th><th>Description</th></tr></thead><tbody>${inline(rows)}</tbody></table></div>`);
  }

  if (t.fields.length) {
    out.push("## Fields");
    const anyDefault = t.fields.some((f) => f.default !== undefined);
    const rows = t.fields
      .map((f) => {
        const mods = f.modifiers?.filter((x) => x === "static" || x === "final").join(" ");
        const name = `<code>${f.name}</code>${mods ? `<div class="api-mods">${mods}</div>` : ""}`;
        const def = anyDefault ? `<td class="api-default">${f.default !== undefined ? `<code>${f.default.replace(/</g, "&lt;")}</code>` : ""}</td>` : "";
        const badge = f.mayhemOnly ? ` ${MAYHEM_BADGE}` : "";
        return `<tr id="${f.anchor}"><td>${name}</td><td class="api-type">${f.type}</td>${def}<td>${closeParagraphs(f.doc ?? "")}${badge}</td></tr>`;
      })
      .join("");
    const head = `<th>Field</th><th>Type</th>${anyDefault ? "<th>Default</th>" : ""}<th>Description</th>`;
    out.push(`<div class="api-table"><table><thead><tr>${head}</tr></thead><tbody>${inline(rows)}</tbody></table></div>`);
  }

  if (t.constructors.length) {
    out.push("## Constructors");
    for (const c of t.constructors) out.push(memberSection(c, t));
  }

  if (t.methods.length) {
    out.push("## Methods");
    const groups = methodGroups(t.methods);
    const blocks = groups.map(
      ([g, ms]) =>
        (groups.length > 1 ? `<p class="api-group">${g}</p>` : "") +
        `<div class="api-rows">${ms.map((m) => summaryRow(m, t)).join("")}</div>`,
    );
    out.push(`<div class="api-summary">${inline(blocks.join(""))}</div>`);
    out.push("## Method details");
    for (const [, ms] of groups) for (const m of ms) out.push(memberSection(m, t));
  }

  return out.join("\n\n") + "\n";
}

const stripTags = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Local search sections for a generated API page. VitePress's local search reads pages from disk,
 * so it skips dynamic routes; its `_splitIntoSections` hook gets the file path, and returning
 * undefined keeps the default for every other page.
 */
export function apiSearchSections(file: string) {
  const m = file.replace(/\\/g, "/").match(/\/api\/([^/]+)\/(.+)\.md$/);
  if (!m) return undefined;
  const api = loadApi();
  const pkg = api.packages.find((p) => p.slug === m[1]);
  const t = pkg?.types.find((x) => x.name === m[2].replace(/\//g, "."));
  if (!pkg || !t) return undefined;
  const sections = [{ anchor: "", titles: [t.name], text: `${pkg.name} ${t.kind} ${stripTags(t.doc)}` }];
  for (const f of [...t.enumConstants, ...t.fields]) {
    sections.push({ anchor: f.anchor, titles: [t.name, f.name], text: stripTags(f.doc) });
  }
  for (const x of [...t.constructors, ...t.methods]) {
    const params = (x.params ?? []).map((p) => `${p.name} ${stripTags(p.doc)}`).join(" ");
    sections.push({
      anchor: x.anchor,
      titles: [t.name, x.shortSignature ?? x.name],
      text: `${stripTags(x.doc)} ${params} ${stripTags(x.returnDoc)}`.trim(),
    });
  }
  return sections;
}

/** Dynamic route entries for api/[pkg]/[cls].md. */
export function apiPages() {
  const api = loadApi();
  return api.packages.flatMap((pkg) =>
    pkg.types.map((t) => ({
      params: { pkg: pkg.slug, cls: t.name.replace(/\./g, "/") },
      content: renderType(pkg, t),
    })),
  );
}
