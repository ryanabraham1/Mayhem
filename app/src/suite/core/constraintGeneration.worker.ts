/// <reference lib="webworker" />
import { generateConstraints } from "./constraintGeneration.ts";
import type { AutoRoutine, SuiteProject } from "./model.ts";
self.onmessage = (
  event: MessageEvent<{ project: SuiteProject; routine: AutoRoutine }>,
) => {
  try {
    self.postMessage({
      result: generateConstraints(event.data.project, event.data.routine),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
