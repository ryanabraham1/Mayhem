// Keep a robot repo's generated MayhemProject.h in step with its project file. Every save from
// the app and from save_project regenerates it with exportCpp, byte for byte what
// `node scripts/mayhem.mjs cpp <project> --out <header>` writes, as long as the robot's pinned
// exporter (docs/mayhem/vendor-snapshot.json, which its CI checks the header with) writes the same
// code as this one. Otherwise the header is left alone and the save says why.
import { exportCpp } from "./export-cpp.ts";
import { parseProject } from "./model.ts";

export const VENDOR_SNAPSHOT_FILE = "docs/mayhem/vendor-snapshot.json";

/** How this Mayhem's exporter compares with the robot's pinned one. */
export type ExporterMatch = "same" | "different" | "unknown";
/**
 * Built into the app (scripts/exporter-compat.mjs): the release commits whose exporter writes the
 * same headers as this build, and every release commit it checked.
 */
export type ExporterTable = { fingerprint: string; compatible: string[]; known: string[] };

export type HeaderSync =
  | { status: "updated" | "unchanged" }
  | { status: "skipped" | "failed"; message: string };

/** The header text for a project file, exactly as `mayhem.mjs cpp` generates it from that file. */
export const generateHeader = (projectText: string) => exportCpp(parseProject(projectText));

export const matchFromTable = (commit: string, table: ExporterTable | null | undefined): ExporterMatch =>
  !table ? "unknown" : table.compatible.includes(commit) ? "same" : table.known.includes(commit) ? "different" : "unknown";

const short = (commit: string) => commit.slice(0, 7);

/**
 * Regenerate the header for a saved project file. `pinned` is the robot's pinned Mayhem commit
 * (undefined when it pins none), `match` how that commit's exporter compares with this one.
 */
export function syncHeader(
  projectText: string,
  current: string,
  pinned: string | undefined,
  match: (commit: string) => ExporterMatch,
): { code?: string; result: HeaderSync } {
  if (pinned !== undefined) {
    const how = pinned ? match(pinned) : "unknown";
    if (how !== "same")
      return {
        result: {
          status: "skipped",
          message:
            how === "different"
              ? `MayhemProject.h was not regenerated: the robot pins Mayhem ${short(pinned)} (${VENDOR_SNAPSHOT_FILE}), whose C++ exporter writes different code than this version of Mayhem. Run tools/mayhem/export.sh, or update the robot's vendored Mayhem to this version.`
              : pinned
                ? `MayhemProject.h was not regenerated: this version of Mayhem can't tell whether the robot's pinned Mayhem ${short(pinned)} (${VENDOR_SNAPSHOT_FILE}) writes the same C++. Update Mayhem, or run tools/mayhem/export.sh.`
                : `MayhemProject.h was not regenerated: ${VENDOR_SNAPSHOT_FILE} names no Mayhem commit. Run tools/mayhem/export.sh.`,
        },
      };
  }
  let code: string;
  try {
    code = generateHeader(projectText);
  } catch (e) {
    return {
      result: {
        status: "failed",
        message: `The project was saved, but MayhemProject.h could not be regenerated, so the robot still runs the old autos: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  return code === current ? { result: { status: "unchanged" } } : { code, result: { status: "updated" } };
}
