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
/// WPILOG files in a local folder and its direct subfolders (simulation output, USB sticks).
fn local_listing(directory: &Path) -> Result<Vec<RemoteLog>, String> {
    if !directory.is_dir() {
        return Err(format!("{} is not a folder.", directory.display()));
    }
    let mut logs = Vec::new();
    let mut folders = vec![(directory.to_path_buf(), 0)];
    while let Some((folder, depth)) = folders.pop() {
        let Ok(entries) = fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() && depth < 1 {
                folders.push((path, depth + 1));
            } else if meta.is_file()
                && path.extension().and_then(|e| e.to_str()) == Some("wpilog")
            {
                logs.push(RemoteLog {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    size: meta.len(),
                });
            }
        }
    }
    logs.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(logs)
}
#[tauri::command]
pub async fn list_local_logs(directory: String) -> Result<Vec<RemoteLog>, String> {
    tauri::async_runtime::spawn_blocking(move || local_listing(Path::new(&directory)))
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
/** Delete `path` only when it is a log file directly inside `directory` (Mayhem's own copy). */
fn delete_library_copy(path: &Path, directory: &Path) -> Result<(), String> {
    let Ok(file) = fs::canonicalize(path) else {
        return Ok(()); // Already gone.
    };
    let Ok(directory) = fs::canonicalize(directory) else {
        return Err("Mayhem only deletes recordings saved in its own library folder.".into());
    };
    if file.parent() != Some(directory.as_path())
        || !matches!(file.extension().and_then(|e| e.to_str()), Some("wpilog") | Some("json"))
        || !file.is_file()
    {
        return Err("Mayhem only deletes recordings saved in its own library folder.".into());
    }
    fs::remove_file(&file).map_err(|e| format!("Could not delete the recording file: {e}"))
}
/** Delete Mayhem's saved copy of a recording. Original files elsewhere are never touched. */
#[tauri::command]
pub async fn delete_library_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("recordings");
        delete_library_copy(Path::new(&path), &directory)
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
/** Show a library recording in Finder / Explorer / the file manager, selected where supported. */
#[tauri::command]
pub async fn reveal_log_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = log_file(&path)?;
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut c = Command::new("open");
            c.arg("-R").arg(&path);
            c
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut c = Command::new("explorer");
            c.arg(format!("/select,{}", path.display()));
            c
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = {
            let mut c = Command::new("xdg-open");
            c.arg(path.parent().ok_or("Missing folder")?);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not open the file manager: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
fn team_site(site: &str) -> Result<reqwest::Url, String> {
    let site = reqwest::Url::parse(site).map_err(|_| "Invalid team website URL")?;
    if site.scheme() != "https"
        || site.host_str().is_none()
        || !site.username().is_empty()
        || site.password().is_some()
    {
        return Err("Use an HTTPS team website URL.".into());
    }
    Ok(site)
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/** A cloud recording's name as a plain local filename: no directories or control characters. */
fn safe_log_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if c.is_ascii_alphanumeric() || "._- ()".contains(c) { c } else { '_' })
        .take(120)
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    let stem = if cleaned.is_empty() { "team-log".to_string() } else { cleaned };
    if stem.to_ascii_lowercase().ends_with(".wpilog") { stem } else { format!("{stem}.wpilog") }
}
fn read_denied(status: reqwest::StatusCode) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        "The team website refused this device token. Create a device token in the team site's Logs › Connect Mayhem (the shared upload token can't read the library), or check it hasn't been revoked.".into()
    } else {
        format!("The team log library is unavailable ({}).", status.as_u16())
    }
}
fn team_client(timeout: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|_| "Could not initialize cloud connection".into())
}
#[derive(Deserialize)]
struct LibraryDevice {
    name: String,
}
#[derive(Deserialize)]
struct LibraryRow {
    sha256: String,
    name: String,
    size: u64,
    created_at: String,
    #[serde(default)]
    device: Option<LibraryDevice>,
}
#[derive(Deserialize)]
struct LibraryPage {
    logs: Vec<LibraryRow>,
    next: Option<String>,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamLog {
    sha256: String,
    name: String,
    size: u64,
    uploaded: String,
    device: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct TeamLogPage {
    logs: Vec<TeamLog>,
    next: Option<String>,
}
/** Keep only well-formed rows; the website is trusted for access, not for filenames or sizes. */
fn team_page(page: LibraryPage) -> TeamLogPage {
    TeamLogPage {
        logs: page
            .logs
            .into_iter()
            .filter(|row| valid_hash(&row.sha256) && row.size > 0 && row.size <= MAX_LOG)
            .map(|row| TeamLog {
                name: safe_log_name(&row.name),
                sha256: row.sha256,
                size: row.size,
                uploaded: row.created_at,
                device: row.device.map(|d| d.name),
            })
            .collect(),
        next: page.next,
    }
}
#[tauri::command]
pub async fn list_team_logs(
    site: String,
    token: String,
    before: Option<String>,
) -> Result<TeamLogPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if token.trim().is_empty() {
            return Err("Add a device token to see the team library.".into());
        }
        let mut endpoint = team_site(&site)?.join("/api/robot-logs").map_err(|e| e.to_string())?;
        if let Some(before) = before.filter(|b| !b.is_empty()) {
            endpoint.query_pairs_mut().append_pair("before", &before);
        }
        let response = team_client(30)?
            .get(endpoint)
            .bearer_auth(token.trim())
            .send()
            .map_err(|_| "Could not reach the team website")?;
        if !response.status().is_success() {
            return Err(read_denied(response.status()));
        }
        let page: LibraryPage = response.json().map_err(|_| "Invalid response from team website")?;
        Ok(team_page(page))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Deserialize)]
struct SignedFile {
    url: String,
}
/** Copy at most `MAX_LOG` bytes to `partial`, returning its size and SHA-256. */
fn save_verified(mut source: impl Read, partial: &Path) -> Result<(u64, String), String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::create(partial).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let n = source.read(&mut chunk).map_err(|_| "The download was interrupted. Try again.")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_LOG {
            return Err("Cloud recording is larger than 250 MB.".into());
        }
        hasher.update(&chunk[..n]);
        file.write_all(&chunk[..n]).map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    Ok((size, format!("{:x}", hasher.finalize())))
}
/** Download one team recording into Mayhem's incoming folder after checking its SHA-256. */
#[tauri::command]
pub async fn download_team_log(
    app: tauri::AppHandle,
    site: String,
    token: String,
    sha256: String,
    name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_hash(&sha256) {
            return Err("Invalid recording ID".into());
        }
        let endpoint = team_site(&site)?
            .join(&format!("/api/robot-logs/{sha256}/file"))
            .map_err(|e| e.to_string())?;
        let client = team_client(180)?;
        let response = client
            .get(endpoint)
            .bearer_auth(token.trim())
            .send()
            .map_err(|_| "Could not reach the team website")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("That recording is no longer in the team library.".into());
        }
        if !response.status().is_success() {
            return Err(read_denied(response.status()));
        }
        let signed: SignedFile = response.json().map_err(|_| "Invalid response from team website")?;
        let url = reqwest::Url::parse(&signed.url).map_err(|_| "Invalid download URL")?;
        if url.scheme() != "https" {
            return Err("Download URL must use HTTPS".into());
        }
        let file = client.get(url).send().map_err(|_| "Cloud download failed. Try again.")?;
        if !file.status().is_success() {
            return Err(format!("Cloud download failed ({})", file.status().as_u16()));
        }
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("logs");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let target = dir.join(format!("{stamp}-{}", safe_log_name(&name)));
        let partial = target.with_extension("partial");
        let saved = save_verified(file, &partial);
        match saved {
            Ok((_, hash)) if hash == sha256 => {
                fs::rename(&partial, &target).map_err(|e| e.to_string())?;
                Ok(target.to_string_lossy().into_owned())
            }
            Ok(_) => {
                let _ = fs::remove_file(&partial);
                Err("The downloaded recording failed its integrity check. Try again.".into())
            }
            Err(e) => {
                let _ = fs::remove_file(&partial);
                Err(e)
            }
        }
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
        let site = team_site(&site)?;
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
    fn local_folders_list_wpilogs_one_level_deep() {
        let root = std::env::temp_dir().join(format!("mayhem-local-{}", std::process::id()));
        let nested = root.join("match1");
        let deeper = nested.join("too-deep");
        fs::create_dir_all(&deeper).unwrap();
        fs::write(root.join("a.wpilog"), b"1").unwrap();
        fs::write(nested.join("b.wpilog"), b"22").unwrap();
        fs::write(nested.join("notes.txt"), b"x").unwrap();
        fs::write(deeper.join("c.wpilog"), b"333").unwrap();
        let logs = local_listing(&root).unwrap();
        let names: Vec<_> = logs.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["a.wpilog", "b.wpilog"]);
        assert_eq!(logs[1].size, 2);
        assert!(local_listing(&root.join("missing")).is_err());
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn team_library_rows_are_sanitized() {
        let page: LibraryPage = serde_json::from_value(serde_json::json!({
            "logs": [
                {"sha256": "a".repeat(64), "name": "../../etc/passwd", "size": 10, "created_at": "2026-11-11T00:00:00Z", "device": {"name": "Pit laptop"}},
                {"sha256": "not-a-hash", "name": "x.wpilog", "size": 10, "created_at": "2026-11-11T00:00:00Z"},
                {"sha256": "b".repeat(64), "name": "match 3.wpilog", "size": MAX_LOG + 1, "created_at": "2026-11-11T00:00:00Z"},
                {"sha256": "c".repeat(64), "name": "Q12.wpilog", "size": 20, "created_at": "2026-11-10T00:00:00Z", "device": null}
            ],
            "next": null
        }))
        .unwrap();
        let page = team_page(page);
        assert_eq!(page.logs.len(), 2);
        assert_eq!(page.logs[0].name, "passwd.wpilog");
        assert_eq!(page.logs[0].device.as_deref(), Some("Pit laptop"));
        assert_eq!(page.logs[1].name, "Q12.wpilog");
        assert_eq!(page.logs[1].device, None);
        assert_eq!(safe_log_name(".."), "team-log.wpilog");
        assert_eq!(safe_log_name("C:\\logs\\a;b.WPILOG"), "a_b.WPILOG");
        assert!(team_site("http://example.com").is_err());
        assert!(team_site("https://user:pw@example.com").is_err());
    }
    #[test]
    fn team_downloads_are_hashed_and_bounded() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("mayhem-team-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let partial = root.join("a.partial");
        let (size, hash) = save_verified(&b"WPILOG cloud"[..], &partial).unwrap();
        assert_eq!(size, 12);
        assert_eq!(hash, format!("{:x}", Sha256::digest(b"WPILOG cloud")));
        assert_eq!(fs::read(&partial).unwrap(), b"WPILOG cloud");
        let huge = std::io::repeat(0).take(MAX_LOG + 1);
        assert!(save_verified(huge, &root.join("b.partial")).is_err());
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn deleting_only_removes_files_inside_the_library_folder() {
        let root = std::env::temp_dir().join(format!("mayhem-delete-{}", std::process::id()));
        let library = root.join("recordings");
        fs::create_dir_all(&library).unwrap();
        let saved = library.join("abc.wpilog");
        let original = root.join("original.wpilog");
        let other = library.join("notes.txt");
        fs::write(&saved, b"1").unwrap();
        fs::write(&original, b"2").unwrap();
        fs::write(&other, b"3").unwrap();
        assert!(delete_library_copy(&original, &library).is_err());
        assert!(original.exists(), "originals outside the library are never deleted");
        assert!(delete_library_copy(&library.join("../original.wpilog"), &library).is_err());
        assert!(original.exists());
        assert!(delete_library_copy(&other, &library).is_err());
        assert!(delete_library_copy(&saved, &library).is_ok());
        assert!(!saved.exists());
        assert!(delete_library_copy(&saved, &library).is_ok(), "already deleted is fine");
        let _ = fs::remove_dir_all(&root);
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
