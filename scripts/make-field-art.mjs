import { readFile, writeFile, mkdir } from "node:fs/promises";
const field = JSON.parse(
  await readFile(
    new URL(
      "../solver/src/mayhem_solver/fields/rebuilt-2026.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const styles = {
  blueZone: { fill: "#2d56d6", opacity: 0.045 },
  redZone: { fill: "#cf3434", opacity: 0.045 },
  tape: { stroke: "#d9dfe9" },
  blueTape: { stroke: "#2d56d6", opacity: 0.7 },
  redTape: { stroke: "#cf3434", opacity: 0.7 },
  fuel: { fill: "#e3b341", opacity: 0.22 },
  structure: { fill: "#e7eaf2", stroke: "#9daac1" },
  blue: { fill: "#2d56d6", stroke: "#2d56d6", opacity: 0.12 },
  red: { fill: "#cf3434", stroke: "#cf3434", opacity: 0.12 },
};
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${field.length} ${field.width}"><desc>Mayhem 2026 REBUILT vector field. Generated from solver/src/mayhem_solver/fields/rebuilt-2026.json.</desc><g transform="translate(0 ${field.width}) scale(1 -1)"><rect width="${field.length}" height="${field.width}" fill="white"/>`;
for (const d of field.decorations) {
  const style = styles[d.style] ?? {};
  const attrs = `fill="${d.kind === "line" ? "none" : (style.fill ?? "none")}" stroke="${style.stroke ?? "none"}" opacity="${style.opacity ?? 1}" stroke-width="${d.kind === "line" ? d.width : 0.015}"`;
  if (d.kind === "circle")
    svg += `<circle cx="${d.center[0]}" cy="${d.center[1]}" r="${d.radius}" ${attrs}/>`;
  else
    svg += `<${d.kind === "line" ? "polyline" : "polygon"} points="${d.points.map((p) => p.join(",")).join(" ")}" ${attrs}/>`;
}
svg += `<rect width="${field.length}" height="${field.width}" fill="none" stroke="#bdc9d9" stroke-width=".025"/></g></svg>`;
const destination = new URL(
  "../app/public/fields/rebuilt-2026.svg",
  import.meta.url,
);
await mkdir(new URL(".", destination), { recursive: true });
await writeFile(destination, svg);
