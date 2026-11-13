//! What's on the robot now: the build stamp the robot code deploys (deploy/mayhem-build.json), and
//! rolling the robot back by building and deploying a known-good commit from a clean export.
use crate::logs::{batch, valid_host};
use crate::review_sim::{export, git, home, java_home};
use std::{fs, process::Command};

const STAMP: &str = "/home/lvuser/deploy/mayhem-build.json";

/// The robot's deploy/mayhem-build.json, or an error when the robot can't be reached.
#[tauri::command]
pub async fn robot_build_info(host: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_host(&host) {
            return Err("Use a robot hostname or IPv4 address.".into());
        }
        let local = std::env::temp_dir().join(format!("mayhem-build-{}.json", std::process::id()));
        let escaped = local.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let result = batch(&host, &format!("get {STAMP} \"{escaped}\"\n"));
        let text = result.and_then(|_| fs::read_to_string(&local).map_err(|e| e.to_string()));
        let _ = fs::remove_file(&local);
        let text = text.map_err(|e| if e.contains("not found") || e.contains("No such file") { "The robot code on the robot predates the build stamp (deploy once with the current robot code).".into() } else { e })?;
        if text.len() > 64 * 1024 {
            return Err("Build stamp too large".into());
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds `rev` from a clean export of the robot repo and deploys it with GradleRIO.
#[tauri::command]
pub async fn robot_deploy(repo: String, rev: String, team: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if team == 0 || team > 25_599 {
            return Err("Set the team number first.".into());
        }
        let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let sha = git(&root, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string();
        let src = home().join(".mayhem/deploy").join(&sha);
        if !src.join("build.gradle").exists() {
            export(&root, &sha, &src)?;
        }
        let gradlew = if cfg!(target_os = "windows") { "gradlew.bat" } else { "./gradlew" };
        let mut cmd = Command::new(gradlew);
        cmd.current_dir(&src)
            .arg("deploy")
            .arg(format!("-PteamNumber={team}"))
            .arg("--offline")
            .env("MAYHEM_BUILD_SHA", &sha)
            .env("MAYHEM_BUILD_BRANCH", format!("rollback to {}", &sha[..7]));
        if let Some(java) = java_home() {
            cmd.env("JAVA_HOME", java);
        }
        let out = cmd.output().map_err(|e| format!("Could not run Gradle: {e}"))?;
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let tail: String = log.lines().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        if !out.status.success() {
            return Err(format!("Deploy failed:\n{tail}"));
        }
        Ok(tail)
    })
    .await
    .map_err(|e| e.to_string())?
}
