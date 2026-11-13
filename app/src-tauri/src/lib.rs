//! Mayhem desktop shell.
//!
//! The UI (app/src) spawns the Python solver itself through tauri-plugin-shell:
//! `Command.sidecar("binaries/mayhem-solver", ["serve"])`, talking newline-delimited JSON over
//! its stdin/stdout. This crate only has to register the plugins and make sure the solver goes
//! away cleanly when the app quits. Updates are checked and installed from the UI as well
//! (app/src/updater.ts); restarting after an update goes through the same exit path.

mod sidecar;
mod logs;
mod projects;
mod opener;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered before tauri-plugin-shell: plugin `on_event` hooks run in
        // registration order, and the shell plugin SIGKILLs its children on `RunEvent::Exit`.
        // We get the first chance to stop the solver gracefully (see sidecar.rs).
        .invoke_handler(tauri::generate_handler![logs::list_robot_logs, logs::list_local_logs, logs::download_robot_log, logs::read_log_file, logs::archive_log_file, logs::open_log_viewer, logs::reveal_log_file, logs::delete_library_file, logs::upload_team_log, logs::list_team_logs, logs::download_team_log, projects::read_suite_project, projects::write_suite_project, opener::take_opened_projects])
        .manage(opener::Pending::default())
        .setup(|app| {
            opener::open_paths(app.handle(), opener::launch_paths());
            Ok(())
        })
        .plugin(sidecar::reaper())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .build(tauri::generate_context!())
        .expect("error while running Mayhem")
        .run(|_app, _event| {
            // Files (`open -a Mayhem robot.mayhem.json`) and mayhem:// links reach the running app.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                opener::open_paths(_app, urls.iter().filter_map(opener::project_path).collect());
            }
        });
}
