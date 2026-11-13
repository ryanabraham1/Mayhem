//! Open a project file from outside the app: `open -a Mayhem <file>`, a `mayhem://open?path=…`
//! link, or a file path on the command line. macOS delivers files and links to the running
//! app (no second instance), as `RunEvent::Opened`. Paths wait here until the UI takes them,
//! so one that arrives while the app is still starting is not lost.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url};

#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

/// The project path a file URL or `mayhem://open?path=<path>` link names.
pub fn project_path(url: &Url) -> Option<String> {
    match url.scheme() {
        "file" => url.to_file_path().ok().map(|p| p.to_string_lossy().into_owned()),
        "mayhem" if url.host_str() == Some("open") || url.path().trim_matches('/') == "open" => url
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned())
            .filter(|path| !path.is_empty()),
        _ => None,
    }
}

/// Queue paths for the UI, tell it, and bring the window forward.
pub fn open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<Pending>().0.lock().unwrap().extend(paths);
    let _ = app.emit("open-project", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Paths given on the command line at launch (files or mayhem:// links).
pub fn launch_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter_map(|arg| match Url::parse(&arg) {
            Ok(url) if url.scheme() == "mayhem" => project_path(&url),
            _ if arg.ends_with(".json") => Some(arg),
            _ => None,
        })
        .collect()
}

/// Project paths opened from outside the app since the last call (the UI opens each one).
#[tauri::command]
pub fn take_opened_projects(pending: tauri::State<Pending>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_from_files_and_links() {
        let file = Url::parse("file:///Users/me/robot%20code/robot.mayhem.json").unwrap();
        assert_eq!(project_path(&file).as_deref(), Some("/Users/me/robot code/robot.mayhem.json"));
        let link = Url::parse("mayhem://open?path=%2FUsers%2Fme%2Frobot.mayhem.json").unwrap();
        assert_eq!(project_path(&link).as_deref(), Some("/Users/me/robot.mayhem.json"));
        assert_eq!(project_path(&Url::parse("mayhem://other?path=/x").unwrap()), None);
        assert_eq!(project_path(&Url::parse("https://example.com/a.json").unwrap()), None);
    }
}
