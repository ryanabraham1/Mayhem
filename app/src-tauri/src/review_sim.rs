//! Sim proof: build a revision of the robot repo with Mayhem's probe test added, then run scripted
//! scenarios through the robot's own simulation, one process each. Builds and runs of a commit are
//! cached in ~/.mayhem/review-sim/<sha>; the working tree is rebuilt incrementally in one folder.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const WORKTREE: &str = "WORKTREE";
const PROBE_PATH: &str = "src/test/cpp/MayhemReviewProbe.cpp";

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().map_err(|e| format!("Could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn hash(text: &[u8]) -> String {
    format!("{:x}", Sha256::digest(text))[..16].to_string()
}

/// The GradleRIO desktop test platform for this computer.
fn platform() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("Osxuniversal", "osxuniversal")
    } else if cfg!(target_os = "windows") {
        ("Windowsx86-64", "windowsx86-64")
    } else {
        ("Linuxx86-64", "linuxx86-64")
    }
}

fn exe_path(src: &Path) -> PathBuf {
    let (_, dir) = platform();
    let name = if cfg!(target_os = "windows") { "frcUserProgramTest.exe" } else { "frcUserProgramTest" };
    src.join("build/install/frcUserProgramTest").join(dir).join("release").join(name)
}

/// Copies the revision's files (tracked, or tracked plus new for the working tree) into `dest`.
fn export(root: &str, rev: &str, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    if rev == WORKTREE {
        let listed = git(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?;
        for path in listed.split('\0').filter(|p| !p.is_empty()) {
            let from = Path::new(root).join(path);
            let to = dest.join(path);
            let Ok(text) = fs::read(&from) else { continue };
            if fs::read(&to).ok().as_deref() == Some(&text[..]) {
                continue; // unchanged: keep the timestamp so Gradle stays incremental
            }
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&to, text).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if let Ok(meta) = fs::metadata(&from) {
                let _ = fs::set_permissions(&to, meta.permissions());
            }
        }
        return Ok(());
    }
    let mut archive = Command::new("git")
        .args(["-C", root, "archive", "--format=tar", rev])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = archive.stdout.take().ok_or("git archive output")?;
    let status = Command::new("tar").arg("-x").arg("-C").arg(dest).stdin(stdout).status().map_err(|e| e.to_string())?;
    let archived = archive.wait().map_err(|e| e.to_string())?;
    if !status.success() || !archived.success() {
        return Err(format!("Could not export {rev} from the repository"));
    }
    Ok(())
}

fn java_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        return Some(PathBuf::from(home));
    }
    let year = home().join("wpilib");
    let mut years: Vec<_> = fs::read_dir(&year).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    years.sort();
    years.into_iter().rev().map(|y| y.join("jdk")).find(|j| j.exists())
}

#[derive(Serialize)]
pub struct Prepared {
    /// Folder holding the build (`src`) and runs (`runs`).
    dir: String,
    sha: String,
    /// The build was reused from the cache.
    cached: bool,
    /// Last lines of the build output.
    log: String,
}

#[tauri::command]
pub async fn review_sim_prepare(repo: String, rev: String, probe: String) -> Result<Prepared, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let sha = if rev == WORKTREE { WORKTREE.to_string() } else { git(&root, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string() };
        let key = if rev == WORKTREE { format!("worktree-{}", hash(root.as_bytes())) } else { sha.clone() };
        let dir = home().join(".mayhem/review-sim").join(key);
        let src = dir.join("src");
        let stamp = dir.join("probe.sha");
        let probe_hash = hash(probe.as_bytes());
        if rev != WORKTREE && exe_path(&src).exists() && fs::read_to_string(&stamp).ok().as_deref() == Some(probe_hash.as_str()) {
            return Ok(Prepared { dir: dir.display().to_string(), sha, cached: true, log: String::new() });
        }
        export(&root, &rev, &src)?;
        fs::write(src.join(PROBE_PATH), &probe).map_err(|e| e.to_string())?;
        let (task_platform, _) = platform();
        let task = format!("installFrcUserProgramTest{task_platform}ReleaseGoogleTestExe");
        let gradlew = if cfg!(target_os = "windows") { "gradlew.bat" } else { "./gradlew" };
        let mut log = String::new();
        let mut built = false;
        for offline in [true, false] {
            let mut cmd = Command::new(gradlew);
            cmd.current_dir(&src).arg(&task).arg("-q");
            if offline {
                cmd.arg("--offline");
            }
            if let Some(java) = java_home() {
                cmd.env("JAVA_HOME", java);
            }
            let out = cmd.output().map_err(|e| format!("Could not run Gradle in {}: {e}", src.display()))?;
            log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if out.status.success() && exe_path(&src).exists() {
                built = true;
                break;
            }
        }
        let tail: String = log.lines().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        if !built {
            return Err(format!("The robot code did not build:\n{tail}"));
        }
        fs::write(&stamp, &probe_hash).map_err(|e| e.to_string())?;
        // Earlier runs of the working tree came from other code.
        if rev == WORKTREE {
            let _ = fs::remove_dir_all(dir.join("runs"));
        }
        Ok(Prepared { dir: dir.display().to_string(), sha, cached: false, log: tail })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Run {
    /// The scenario's .wpilog.
    log: Option<String>,
    /// The probe's summary (physics), as JSON text.
    result: Option<String>,
    ok: bool,
    cached: bool,
    output: String,
}

#[tauri::command]
pub async fn review_sim_run(dir: String, id: String, scenario: String) -> Result<Run, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("Bad scenario id {id}"));
        }
        let dir = PathBuf::from(dir);
        if !dir.starts_with(home().join(".mayhem/review-sim")) {
            return Err("Not a sim proof folder".into());
        }
        let src = dir.join("src");
        let out = dir.join("runs").join(&id);
        let input = out.join("scenario.json");
        let find_log = |out: &Path| -> Option<String> {
            fs::read_dir(out).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "wpilog")).map(|p| p.display().to_string())
        };
        if fs::read_to_string(&input).ok().as_deref() == Some(scenario.as_str()) && out.join("done").exists() {
            return Ok(Run { log: find_log(&out), result: fs::read_to_string(out.join("result.json")).ok(), ok: true, cached: true, output: String::new() });
        }
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        fs::write(&input, &scenario).map_err(|e| e.to_string())?;
        let run = Command::new(exe_path(&src))
            .current_dir(&src)
            .env("ROBOT_DEPLOY_DIR", src.join("src/main/deploy"))
            .env("ROBOT_LOG_DIR", &out)
            .env("MAYHEM_SCENARIO", &input)
            .env("MAYHEM_RESULT", out.join("result.json"))
            .arg("--gtest_filter=MayhemReviewProbe.*")
            .output()
            .map_err(|e| e.to_string())?;
        let text = format!("{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
        let output: String = text.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        let ok = run.status.success();
        if ok {
            fs::write(out.join("done"), "").map_err(|e| e.to_string())?;
        }
        Ok(Run { log: find_log(&out), result: fs::read_to_string(out.join("result.json")).ok(), ok, cached: false, output })
    })
    .await
    .map_err(|e| e.to_string())?
}
