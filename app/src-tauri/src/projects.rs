use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
struct FileLock {
    path: PathBuf,
    file: Option<fs::File>,
}
impl Drop for FileLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}
fn read(path: &Path) -> Result<Value, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 10 * 1024 * 1024 {
        return Err("Project exceeds the current 10 MB limit".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value["format"] != "mayhem-suite" || value["version"] != 1 {
        return Err("Expected a Mayhem suite v1 project".into());
    }
    Ok(value)
}
#[tauri::command]
pub async fn read_suite_project(
    path: String,
    allow_missing: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if allow_missing == Some(true)
            && matches!(fs::metadata(&path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Ok(Value::Null);
        }
        read(Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn write_suite_project(
    path: String,
    project: Value,
    expected_revision: Option<u64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_project(Path::new(&path), &project, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn write_project(
    path: &Path,
    project: &Value,
    expected_revision: Option<u64>,
) -> Result<(), String> {
    if project["format"] != "mayhem-suite" || project["version"] != 1 {
        return Err("Invalid project format".into());
    }
    let parent = path.parent().ok_or("Choose a project folder")?;
    let lock_path = PathBuf::from(format!("{}.lock", path.to_string_lossy()));
    let lock_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| "Project is locked by another writer. Retry after that edit finishes.")?;
    let _lock = FileLock {
        path: lock_path,
        file: Some(lock_file),
    };
    let actual = if path.exists() {
        Some(
            read(path)?["revision"]
                .as_u64()
                .ok_or("Invalid saved revision")?,
        )
    } else {
        None
    };
    if actual != expected_revision {
        return Err(format!("Project changed on disk (revision {actual:?}). Reopen it before saving to avoid overwriting the other edit."));
    }
    let expected_next = actual
        .map(|n| n.checked_add(1).ok_or("Revision is too large"))
        .transpose()?
        .unwrap_or(0);
    if project["revision"].as_u64() != Some(expected_next) {
        return Err("Saved revision must advance by one".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".mayhem-{stamp}.tmp"));
    let bytes = serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Project exceeds the current 10 MB limit".into());
    }
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
/// The robot code generated from a robot repo's project file, relative to the project's folder
/// (app/src/suite/core/review/report.ts GENERATED_FILE), and the file pinning its exporter.
const GENERATED_HEADER: &str = "src/main/include/commands/MayhemProject.h";
const VENDOR_SNAPSHOT: &str = "docs/mayhem/vendor-snapshot.json";
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHeader {
    /// The project file's exact text, which the header is generated from.
    project_text: String,
    header_path: String,
    /// The header on disk now.
    current: String,
    /// The Mayhem commit the robot pins its exporter to, if it pins one.
    pinned_commit: Option<String>,
}
fn header_path(project: &Path) -> Result<PathBuf, String> {
    Ok(project
        .parent()
        .ok_or("Choose a project folder")?
        .join(GENERATED_HEADER))
}
fn generated_header_at(project: &Path) -> Result<Option<GeneratedHeader>, String> {
    let header = header_path(project)?;
    // Only a repo that already builds the generated header gets it kept up to date.
    let current = match fs::read_to_string(&header) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let project_text = fs::read_to_string(project).map_err(|e| e.to_string())?;
    let snapshot = project.parent().unwrap().join(VENDOR_SNAPSHOT);
    let pinned_commit = match fs::read(&snapshot) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["commit"].as_str().map(String::from))
            .or(Some(String::new())),
        Err(_) => None,
    };
    Ok(Some(GeneratedHeader {
        project_text,
        header_path: header.to_string_lossy().into_owned(),
        current,
        pinned_commit,
    }))
}
/// What regenerating the robot's MayhemProject.h needs, or null when the project's folder has none.
#[tauri::command]
pub async fn generated_header(path: String) -> Result<Option<GeneratedHeader>, String> {
    tauri::async_runtime::spawn_blocking(move || generated_header_at(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}
fn write_header_at(project: &Path, code: &str, project_text: &str) -> Result<bool, String> {
    // Generated from an older version of the file: whoever changed it regenerates it.
    if fs::read_to_string(project).map_err(|e| e.to_string())? != project_text {
        return Ok(false);
    }
    let header = header_path(project)?;
    if fs::read_to_string(&header).ok().as_deref() == Some(code) {
        return Ok(true);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = header.with_file_name(format!(".MayhemProject-{stamp}.tmp"));
    let result = fs::write(&temporary, code)
        .and_then(|_| fs::rename(&temporary, &header))
        .map_err(|e| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|_| true)
}
/// Write the regenerated MayhemProject.h next to the project. False when the project file changed
/// after `project_text` was read.
#[tauri::command]
pub async fn write_generated_header(
    path: String,
    code: String,
    project_text: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_header_at(Path::new(&path), &code, &project_text)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conflicting_project_saves_preserve_the_disk_revision() {
        let path =
            std::env::temp_dir().join(format!("mayhem-revision-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let mut project = serde_json::json!({"format":"mayhem-suite","version":1,"revision":0});
        write_project(&path, &project, None).unwrap();
        project["revision"] = serde_json::json!(1);
        assert!(write_project(&path, &project, None)
            .unwrap_err()
            .contains("changed on disk"));
        assert_eq!(read(&path).unwrap()["revision"], 0);
        write_project(&path, &project, Some(0)).unwrap();
        assert_eq!(read(&path).unwrap()["revision"], 1);
        assert!(!Path::new(&format!("{}.lock", path.to_string_lossy())).exists());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn generated_header_follows_the_project_file() {
        let dir = std::env::temp_dir().join(format!("mayhem-header-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let project = dir.join("robot.mayhem.json");
        fs::write(&project, "{}").unwrap();
        // No generated header: nothing to keep up to date.
        assert!(generated_header_at(&project).unwrap().is_none());
        fs::create_dir_all(dir.join("src/main/include/commands")).unwrap();
        fs::write(dir.join(GENERATED_HEADER), "old").unwrap();
        let info = generated_header_at(&project).unwrap().unwrap();
        assert_eq!(
            (info.project_text.as_str(), info.current.as_str()),
            ("{}", "old")
        );
        assert_eq!(info.pinned_commit, None);
        fs::create_dir_all(dir.join("docs/mayhem")).unwrap();
        fs::write(dir.join(VENDOR_SNAPSHOT), r#"{"commit":"abc"}"#).unwrap();
        assert_eq!(
            generated_header_at(&project)
                .unwrap()
                .unwrap()
                .pinned_commit
                .as_deref(),
            Some("abc")
        );
        // A header generated from an older project file is not written.
        assert!(!write_header_at(&project, "new", "{\"old\":1}").unwrap());
        assert_eq!(
            fs::read_to_string(dir.join(GENERATED_HEADER)).unwrap(),
            "old"
        );
        assert!(write_header_at(&project, "new", "{}").unwrap());
        assert_eq!(
            fs::read_to_string(dir.join(GENERATED_HEADER)).unwrap(),
            "new"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn project_rejects_foreign_format() {
        let path = std::env::temp_dir().join(format!("mayhem-invalid-{}.json", std::process::id()));
        fs::write(&path, b"{\"format\":\"other\"}").unwrap();
        assert!(read(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
