//! Mayhem desktop shell: the native commands the UI (app/src/suite) calls for robot logs,
//! project files, the robot repo review, the sim proof and deploys. Updates are checked and
//! installed from the UI (app/src/updater.ts).

mod logs;
mod projects;
mod opener;
mod review;
mod github;
mod review_sim;
mod deploy;
mod assets3d;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![logs::list_robot_logs, logs::list_local_logs, logs::download_robot_log, logs::read_log_file, logs::archive_log_file, logs::open_log_viewer, logs::reveal_log_file, logs::delete_library_file, logs::upload_team_log, logs::list_team_logs, logs::download_team_log, projects::read_suite_project, projects::write_suite_project, projects::generated_header, projects::write_generated_header, opener::take_opened_projects, review::review_git_root, review::review_repo, review::review_snapshot, review::review_write_file, review::review_commits, review::review_history, review::review_branches, review::review_reaches, review::review_proofs, review::review_proof_save, github::review_pr, github::review_pr_merge, github::review_update_main, review_sim::review_sim_prepare, review_sim::review_sim_run, deploy::robot_build_info, deploy::robot_deploy, assets3d::ascope_assets, assets3d::ascope_model, assets3d::save_replay_video])
        .manage(opener::Pending::default())
        .setup(|app| {
            opener::open_paths(app.handle(), opener::launch_paths());
            Ok(())
        })
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
