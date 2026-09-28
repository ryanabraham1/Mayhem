//! Mayhem desktop shell.
//!
//! The UI (app/src) spawns the Python solver itself through tauri-plugin-shell:
//! `Command.sidecar("binaries/mayhem-solver", ["serve"])`, talking newline-delimited JSON over
//! its stdin/stdout. This crate only has to register the plugins and make sure the solver goes
//! away cleanly when the app quits. Updates are checked and installed from the UI as well
//! (app/src/updater.ts); restarting after an update goes through the same exit path.

mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered before tauri-plugin-shell: plugin `on_event` hooks run in
        // registration order, and the shell plugin SIGKILLs its children on `RunEvent::Exit`.
        // We get the first chance to stop the solver gracefully (see sidecar.rs).
        .plugin(sidecar::reaper())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running Mayhem");
}
