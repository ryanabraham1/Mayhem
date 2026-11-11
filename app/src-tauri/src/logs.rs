//! Robot log IO stays off the UI and control threads. No shell command interpolation.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_LOG: u64 = 250 * 1024 * 1024;
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLog {
    name: String,
    path: String,
    size: u64,
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
}
fn valid_remote(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
}
fn batch(host: &str, commands: &str) -> Result<String, String> {
    if !valid_host(host) {
        return Err("Use a robot hostname or IPv4 address.".into());
    }
    let mut child = Command::new("sftp")
        .args([
            "-oBatchMode=yes",
            "-oConnectTimeout=5",
            "-oStrictHostKeyChecking=accept-new",
            "-b",
            "-",
            &format!("lvuser@{host}"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("Could not start OpenSSH SFTP: {e}. Install OpenSSH or import logs manually.")
        })?;
    let stdout = child.stdout.take().ok_or("Missing SFTP stdout")?;
    let stderr = child.stderr.take().ok_or("Missing SFTP stderr")?;
    let reader = thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.take(4 * 1024 * 1024).read_to_string(&mut output);
        output
    });
    let errors = thread::spawn(move || {
        let mut output = String::new();
        let _ = stderr.take(64 * 1024).read_to_string(&mut output);
        output
    });
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(commands.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => (),
            Err(e) => return Err(e.to_string()),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Robot transfer timed out. Reconnect Ethernet and retry.".into());
        }
        thread::sleep(Duration::from_millis(30));
    };
    let output = reader.join().unwrap_or_default();
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("Robot SFTP failed: {}", errors.trim()));
    }
    Ok(output)
}
fn listing(host: &str, directory: &str) -> Result<Vec<RemoteLog>, String> {
    if !valid_remote(directory) {
        return Err("Use an absolute robot directory containing letters, digits, slashes, dots, underscores, or hyphens.".into());
    }
    let output = batch(host, &format!("-ls -ln {directory}/*.wpilog\n"))?;
    let mut logs = Vec::new();
    for line in output
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("-ls"))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let Ok(size) = fields[4].parse::<u64>() else {
            continue;
        };
        let path = fields[8..].join(" ");
        let path = if path.starts_with('/') {
            path
        } else {
            format!("{directory}/{path}")
        };
        if !valid_remote(&path) || !path.ends_with(".wpilog") {
            continue;
        }
        let name = Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        logs.push(RemoteLog { name, path, size });
    }
    Ok(logs)
}
#[tauri::command]
pub async fn list_robot_logs(host: String, directory: String) -> Result<Vec<RemoteLog>, String> {
    tauri::async_runtime::spawn_blocking(move || listing(&host, &directory))
        .await
        .map_err(|e| e.to_string())?
}
fn log_file(path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_file()
        || !matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("wpilog") | Some("json")
        )
    {
        return Err("Select a WPILOG or recording JSON file.".into());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_LOG {
        return Err("Log exceeds the current 250 MB limit.".into());
    }
    Ok(path)
}
fn archive_file(source: &Path, directory: &Path, expected_hash: &str) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    if expected_hash.len() != 64
        || !expected_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid recording hash".into());
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .ok_or("Missing recording extension")?;
    let target = directory.join(format!("{expected_hash}.{extension}"));
    if source == target {
        return Ok(target);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = directory.join(format!("{expected_hash}-{stamp}.partial"));
    let result = (|| {
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut chunk = [0u8; 65536];
        let mut total = 0u64;
        loop {
            let n = input.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_LOG {
                return Err("Log exceeds the 250 MB limit".into());
            }
            hasher.update(&chunk[..n]);
            output.write_all(&chunk[..n]).map_err(|e| e.to_string())?;
        }
        if format!("{:x}", hasher.finalize()) != expected_hash {
            return Err(
                "Recording changed while being imported. Retry after it finishes writing.".into(),
            );
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[tauri::command]
pub async fn archive_log_file(
    app: tauri::AppHandle,
    path: String,
    expected_hash: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = log_file(&path)?;
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("recordings");
        archive_file(&source, &directory, &expected_hash).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn read_log_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = log_file(&path)?;
        fs::read(path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn download_robot_log(
    app: tauri::AppHandle,
    host: String,
    remote: String,
    expected_size: u64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_remote(&remote) || !remote.ends_with(".wpilog") || expected_size > MAX_LOG { return Err("Invalid robot log path or unsupported log size.".into()); }
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("logs");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = Path::new(&remote).file_name().ok_or("Missing filename")?.to_string_lossy();
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let target = dir.join(format!("{stamp}-{name}")); let partial = target.with_extension("partial");
        let escaped = partial.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let result = batch(&host, &format!("get {remote} \"{escaped}\"\n"));
        if let Err(e) = result { let _ = fs::remove_file(&partial); return Err(e); }
        let size = fs::metadata(&partial).map_err(|e| e.to_string())?.len();
        let parent = Path::new(&remote).parent().ok_or("Missing directory")?.to_string_lossy();
        let check = listing(&host, &parent);
        let stable = check.as_ref().ok().and_then(|logs| logs.iter().find(|l| l.path == remote)).map(|l| l.size == size && size == expected_size).unwrap_or(false);
        if !stable { let _ = fs::remove_file(&partial); return Err("The log changed during transfer. Wait until recording stops, refresh the list, and retry.".into()); }
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_log_viewer(path: String, viewer: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = log_file(&path)?;
        let custom = viewer.filter(|v| !v.trim().is_empty());
        let mut command;
        if let Some(viewer) = custom {
            let executable =
                fs::canonicalize(&viewer).map_err(|e| format!("Log viewer not found: {e}"))?;
            #[cfg(target_os = "macos")]
            if executable.extension().and_then(|e| e.to_str()) == Some("app") {
                command = Command::new("open");
                command.arg("-a").arg(executable).arg(&path);
            } else {
                command = Command::new(executable);
                command.arg(&path);
            }
            #[cfg(not(target_os = "macos"))]
            {
                command = Command::new(executable);
                command.arg(&path);
            }
        } else {
            #[cfg(target_os = "macos")]
            {
                let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home folder unavailable")?);
                let mut candidates = vec![
                    PathBuf::from("/Applications/AdvantageScope.app"),
                    PathBuf::from("/Applications/AdvantageScope (WPILib).app"),
                    home.join("Applications/AdvantageScope.app"),
                ];
                if let Ok(years) = fs::read_dir(home.join("wpilib")) {
                    let mut years: Vec<_> = years.filter_map(Result::ok).collect();
                    years.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
                    for year in years {
                        candidates.push(year.path().join("advantagescope/AdvantageScope (WPILib).app"));
                        candidates.push(year.path().join("advantagescope/AdvantageScope.app"));
                    }
                }
                let app = candidates.into_iter().find(|p| p.is_dir()).ok_or(
                    "AdvantageScope was not found. Install it, or choose its application path in Robot collection settings."
                )?;
                command = Command::new("open");
                command.arg("-a").arg(app).arg(&path);
            }
            #[cfg(target_os = "windows")]
            {
                let home = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Home folder unavailable")?);
                let mut candidates = vec![PathBuf::from("C:/Program Files/AdvantageScope/AdvantageScope.exe")];
                if let Ok(years) = fs::read_dir(home.join("wpilib")) {
                    let mut years: Vec<_> = years.filter_map(Result::ok).collect();
                    years.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
                    for year in years { candidates.push(year.path().join("advantagescope/AdvantageScope.exe")); }
                }
                let app = candidates.into_iter().find(|p| p.is_file()).ok_or("AdvantageScope was not found. Choose its executable in Robot collection settings.")?;
                command = Command::new(app);
                command.arg(&path);
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                command = Command::new("advantagescope");
                command.arg(&path);
            }
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not launch log viewer: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadPlan {
    upload_url: Option<String>,
    already_uploaded: Option<bool>,
}
#[tauri::command]
pub async fn upload_team_log(
    path: String,
    site: String,
    token: String,
    name: String,
    expected_hash: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let path = log_file(&path)?;
        if path.extension().and_then(|e| e.to_str()) != Some("wpilog") {
            return Err("Cloud sharing currently accepts WPILOG files.".into());
        }
        let site = reqwest::Url::parse(&site).map_err(|_| "Invalid team website URL")?;
        if site.scheme() != "https"
            || site.host_str().is_none()
            || !site.username().is_empty()
            || site.password().is_some()
        {
            return Err("Use an HTTPS team website URL.".into());
        }
        let endpoint = site.join("/api/robot-logs").map_err(|e| e.to_string())?;
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut chunk = [0u8; 65536];
        loop {
            let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&chunk[..n]);
        }
        let hash = format!("{:x}", hasher.finalize());
        if hash != expected_hash {
            return Err(
                "The local file changed after import. Reimport it before uploading.".into(),
            );
        }
        let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "Could not initialize cloud connection")?;
        let request = client
            .post(endpoint.clone())
            .bearer_auth(&token)
            .json(&serde_json::json!({"name":name,"size":size,"sha256":hash}))
            .send()
            .map_err(|_| "Could not reach the team website")?;
        if !request.status().is_success() {
            return Err(format!(
                "Team upload request failed ({}). Check the upload token and website setup.",
                request.status().as_u16()
            ));
        }
        let plan: UploadPlan = request
            .json()
            .map_err(|_| "Invalid response from team website")?;
        if plan.already_uploaded != Some(true) {
            let upload = reqwest::Url::parse(&plan.upload_url.ok_or("No upload URL returned")?)
                .map_err(|_| "Invalid upload URL")?;
            if upload.scheme() != "https" {
                return Err("Upload URL must use HTTPS".into());
            }
            let response = client
                .put(upload)
                .header("content-type", "application/octet-stream")
                .body(fs::File::open(&path).map_err(|e| e.to_string())?)
                .send()
                .map_err(|_| "Cloud file transfer failed; the queue will retry")?;
            if !response.status().is_success() {
                return Err(format!(
                    "Storage upload failed ({})",
                    response.status().as_u16()
                ));
            }
            let response = client
                .post(endpoint)
                .bearer_auth(&token)
                .json(&serde_json::json!({"complete":true,"sha256":hash}))
                .send()
                .map_err(|_| "Could not confirm cloud upload")?;
            if !response.status().is_success() {
                return Err(format!(
                    "Cloud confirmation failed ({})",
                    response.status().as_u16()
                ));
            }
        }
        Ok(site
            .join(&format!("/logs?log={hash}"))
            .map_err(|e| e.to_string())?
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archived_recordings_are_verified_and_keep_the_source() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("mayhem-archive-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("original.wpilog");
        fs::write(&source, b"WPILOG test recording").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"WPILOG test recording"));
        let target = archive_file(&source, &root.join("saved"), &hash).unwrap();
        assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
        fs::write(&source, b"changed").unwrap();
        assert!(archive_file(&source, &root.join("saved"), &hash).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"WPILOG test recording");
        assert_eq!(fs::read_dir(root.join("saved")).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn robot_paths_cannot_be_commands() {
        assert!(valid_host("roborio-3256-frc.local"));
        assert!(valid_host("10.32.56.2"));
        assert!(!valid_host("-oProxyCommand=bad"));
        assert!(!valid_host("robot\nquit"));
        assert!(valid_remote("/home/lvuser/logs/WPILib_a.wpilog"));
        assert!(!valid_remote("/logs/a\nrm /x"));
        assert!(!valid_remote("/logs/../other"));
    }
}
