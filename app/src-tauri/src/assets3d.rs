//! 3D replays: the robot and field models AdvantageScope keeps (its userAssets and autoAssets
//! folders), read-only, and saving a recorded replay video.
use serde::Serialize;
use std::{fs, path::PathBuf};

fn roots() -> Vec<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/AdvantageScope"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("AdvantageScope"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/AdvantageScope"))
    };
    base.map(|b| vec![b.join("userAssets"), b.join("autoAssets")]).unwrap_or_default()
}

#[derive(Serialize)]
pub struct Asset {
    /// "robot" or "field".
    kind: String,
    name: String,
    dir: String,
    /// config.json text.
    config: String,
    /// model.glb, model_0.glb, … present in the folder.
    models: Vec<String>,
}

#[tauri::command]
pub async fn ascope_assets() -> Result<Vec<Asset>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        for root in roots() {
            let Ok(entries) = fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                let dir = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let kind = if name.starts_with("Robot_") { "robot" } else if name.starts_with("Field3d_") { "field" } else { continue };
                let Ok(config) = fs::read_to_string(dir.join("config.json")) else { continue };
                let mut models: Vec<String> = fs::read_dir(&dir)
                    .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("model") && n.ends_with(".glb")).collect())
                    .unwrap_or_default();
                models.sort();
                out.push(Asset { kind: kind.into(), name, dir: dir.display().to_string(), config, models });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One model file from an AdvantageScope asset folder.
#[tauri::command]
pub async fn ascope_model(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = fs::canonicalize(&path).map_err(|e| e.to_string())?;
        let allowed = roots().iter().filter_map(|r| fs::canonicalize(r).ok()).any(|r| path.starts_with(r));
        if !allowed || path.extension().map_or(true, |e| e != "glb") {
            return Err("Only AdvantageScope model files can be read.".into());
        }
        fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a recorded replay where the person chose (a .webm from the save dialog).
#[tauri::command]
pub async fn save_replay_video(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lower = path.to_lowercase();
        if !(lower.ends_with(".webm") || lower.ends_with(".mp4")) || bytes.len() > 512 * 1024 * 1024 {
            return Err("Save the video as a .webm or .mp4 file.".into());
        }
        fs::write(&path, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
