export const desktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export interface RemoteLog {
  name: string;
  path: string;
  size: number;
}
export async function invoke<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new Error(
      "Robot transfers and external applications require the desktop app. Browser log analysis works offline.",
    );
  return (await import("@tauri-apps/api/core")).invoke<T>(name, args);
}
export async function nativeRead(path: string): Promise<ArrayBuffer> {
  const result = await invoke<ArrayBuffer | number[]>("read_log_file", {
    path,
  });
  return result instanceof ArrayBuffer
    ? result
    : Uint8Array.from(result).buffer;
}
