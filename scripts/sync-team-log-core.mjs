// Keep browser and desktop analysis identical without linking separate repositories.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const target = process.argv[2];
if (!target)
  throw new Error(
    "Usage: node scripts/sync-team-log-core.mjs /path/to/3256-Tools",
  );
const destination = resolve(target, "lib/robot-logs/core");
await mkdir(destination, { recursive: true });
for (const name of ["analysis.ts", "wpilog.ts", "plot.ts"]) {
  let source = await readFile(
    new URL(`../app/src/suite/core/${name}`, import.meta.url),
    "utf8",
  );
  source =
    "// Synced from Mayhem. Update with scripts/sync-team-log-core.mjs in that repository.\n" +
    source.replaceAll("./analysis.ts", "./analysis");
  await writeFile(join(destination, name), source);
}
