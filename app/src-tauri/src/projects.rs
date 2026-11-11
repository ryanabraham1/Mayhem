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
    fn project_rejects_foreign_format() {
        let path = std::env::temp_dir().join(format!("mayhem-invalid-{}.json", std::process::id()));
        fs::write(&path, b"{\"format\":\"other\"}").unwrap();
        assert!(read(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
