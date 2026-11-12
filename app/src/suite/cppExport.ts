import { exportCpp } from "./core/export-cpp.ts";
import type { SuiteProject } from "./core/model.ts";
import { download } from "./storage";

const KEY = (projectId: string) => `mayhem.cpp-export.${projectId}`;

// The export is deterministic, so a hash of it tells whether the robot code is current.
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Download the routines as C++ and remember what was exported. */
export function downloadCpp(project: SuiteProject) {
  const code = exportCpp(project);
  download(`${project.id}.hpp`, code, "text/plain");
  try {
    localStorage.setItem(KEY(project.id), hash(code));
  } catch {}
}

/** Whether this browser has exported the project's C++, and whether it still matches. */
export function cppExportState(project: SuiteProject): "never" | "current" | "stale" {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY(project.id));
  } catch {}
  if (!saved) return "never";
  return saved === hash(exportCpp(project)) ? "current" : "stale";
}
