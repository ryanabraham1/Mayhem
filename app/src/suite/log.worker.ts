import { parseWPILog } from "./core/wpilog.ts";
import { analyze, parseRecordingJSON } from "./core/analysis.ts";
self.onmessage = (
  event: MessageEvent<{ buffer: ArrayBuffer; name: string; id: number }>,
) => {
  try {
    const { buffer, name } = event.data;
    const recording = name.toLowerCase().endsWith(".wpilog")
      ? parseWPILog(buffer, name)
      : parseRecordingJSON(new TextDecoder().decode(buffer));
    self.postMessage({
      id: event.data.id,
      recording,
      analysis: analyze(recording),
    });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
