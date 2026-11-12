import { beforeEach, expect, it, vi } from "vitest";
import { sampleProject } from "../src/suite/core/sample";
import { cppExportState, downloadCpp } from "../src/suite/cppExport";
import { download } from "../src/suite/storage";

vi.mock("../src/suite/storage", () => ({ download: vi.fn() }));
beforeEach(() => localStorage.clear());
it("tracks never, current, and changed routines after exporting C++", () => {
  const project = structuredClone(sampleProject);
  expect(cppExportState(project)).toBe("never");
  downloadCpp(project);
  expect(download).toHaveBeenCalled();
  expect(cppExportState(project)).toBe("current");
  project.routines[0].nodes[0].goal!.x += 1;
  expect(cppExportState(project)).toBe("stale");
});
