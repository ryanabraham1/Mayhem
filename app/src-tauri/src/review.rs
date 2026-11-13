//! Git access for the behavior review: revisions of the robot repo, the files a review reads, and
//! one-value edits written back to the working tree.
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

const WORKTREE: &str = "WORKTREE";

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

/// Same selection as `isReviewFile` in core/review/report.ts (the frontend filters again).
fn review_file(path: &str) -> bool {
    let settings = (path.starts_with("src/main/include/") || path.starts_with("src/main/cpp/"))
        && (path.ends_with(".h") || path.ends_with(".hpp"));
    settings
        || path == "tools/mayhem/machines.json"
        || path == "tools/mayhem/scenarios.json"
        || path == "src/main/include/commands/MayhemProject.h"
        || (!path.contains('/') && path.ends_with(".mayhem.json"))
}

#[derive(Serialize)]
pub struct Revision {
    rev: String,
    sha: String,
    label: String,
    kind: String,
    date: String,
}

#[derive(Serialize)]
pub struct RepoInfo {
    root: String,
    branch: String,
    head: String,
    /// Review files with uncommitted changes.
    dirty: Vec<String>,
    revisions: Vec<Revision>,
}

#[tauri::command]
pub async fn review_repo(repo: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
        let head = git(&root, &["rev-parse", "HEAD"])?.trim().to_string();
        let dirty = git(&root, &["status", "--porcelain", "--untracked-files=all"])?
            .lines()
            .filter_map(|l| l.get(3..))
            .map(|p| p.rsplit(" -> ").next().unwrap_or(p).trim_matches('"').to_string())
            .filter(|p| review_file(p))
            .collect();
        let mut revisions = Vec::new();
        let refs = git(
            &root,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--count=40",
                "--format=%(refname:short)\t%(objectname)\t%(subject)\t%(committerdate:iso-strict)\t%(refname)",
                "refs/heads",
                "refs/tags",
                "refs/remotes",
            ],
        )?;
        for line in refs.lines() {
            let f: Vec<&str> = line.splitn(5, '\t').collect();
            if f.len() < 5 || f[0].ends_with("/HEAD") {
                continue;
            }
            let kind = if f[4].starts_with("refs/tags") {
                "tag"
            } else if f[4].starts_with("refs/remotes") {
                "remote"
            } else {
                "branch"
            };
            revisions.push(Revision { rev: f[0].into(), sha: f[1].into(), label: f[2].into(), kind: kind.into(), date: f[3].into() });
        }
        let log = git(&root, &["log", "-30", "--format=%H\t%s\t%cI\t%an"])?;
        for line in log.lines() {
            let f: Vec<&str> = line.splitn(4, '\t').collect();
            if f.len() < 4 {
                continue;
            }
            revisions.push(Revision {
                rev: f[0].into(),
                sha: f[0].into(),
                label: format!("{} ({})", f[1], f[3]),
                kind: "commit".into(),
                date: f[2].into(),
            });
        }
        Ok(RepoInfo { root, branch, head, dirty, revisions })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Snapshot {
    rev: String,
    label: String,
    files: HashMap<String, String>,
}

#[tauri::command]
pub async fn review_snapshot(repo: String, rev: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let mut files = HashMap::new();
        if rev == WORKTREE {
            let listed = git(&root, &["ls-files", "--cached", "--others", "--exclude-standard"])?;
            for path in listed.lines().filter(|p| review_file(p)) {
                if let Ok(text) = fs::read_to_string(Path::new(&root).join(path)) {
                    files.insert(path.to_string(), text);
                }
            }
            return Ok(Snapshot { rev, label: "This computer (not committed)".into(), files });
        }
        let sha = git(&root, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string();
        let subject = git(&root, &["log", "-1", "--format=%s", &sha])?.trim().to_string();
        let paths: Vec<String> = git(&root, &["ls-tree", "-r", "--name-only", &sha])?
            .lines()
            .filter(|p| review_file(p))
            .map(String::from)
            .collect();
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let request: String = paths.iter().map(|p| format!("{sha}:{p}\n")).collect();
        let mut stdin = child.stdin.take().ok_or("git stdin")?;
        let writer = std::thread::spawn(move || stdin.write_all(request.as_bytes()));
        let mut out = Vec::new();
        child.stdout.take().ok_or("git stdout")?.read_to_end(&mut out).map_err(|e| e.to_string())?;
        writer.join().map_err(|_| "git writer panicked")?.map_err(|e| e.to_string())?;
        child.wait().map_err(|e| e.to_string())?;
        let mut at = 0;
        for path in &paths {
            let Some(nl) = out[at..].iter().position(|&b| b == b'\n') else { break };
            let header = String::from_utf8_lossy(&out[at..at + nl]).to_string();
            let parts: Vec<&str> = header.split(' ').collect();
            at += nl + 1;
            if parts.len() < 3 || parts[1] != "blob" {
                continue;
            }
            let size: usize = parts[2].parse().map_err(|_| "bad git header")?;
            files.insert(path.clone(), String::from_utf8_lossy(&out[at..at + size]).to_string());
            at += size + 1;
        }
        let label = if rev == sha { format!("{} · {subject}", &sha[..7]) } else { format!("{rev} · {subject}") };
        Ok(Snapshot { rev: sha, label, files })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A repo-relative path that stays inside the repo.
fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.is_absolute() || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Refusing to write outside the repository: {path}"));
    }
    Ok(root.join(relative))
}

/// Writes one edited source file, only if it still holds `expected` (nobody changed it meanwhile).
#[tauri::command]
pub async fn review_write_file(repo: String, path: String, expected: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(git(&repo, &["rev-parse", "--show-toplevel"])?.trim());
        if !review_file(&path) {
            return Err(format!("Only robot settings files can be edited here: {path}"));
        }
        let target = inside(&root, &path)?;
        let current = fs::read_to_string(&target).map_err(|e| e.to_string())?;
        if current != expected {
            return Err("The file changed on disk since it was read. Reload and try again.".into());
        }
        let temporary = target.with_extension(format!("mayhem-{}.tmp", std::process::id()));
        fs::write(&temporary, text).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &target).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_review_files_and_refuses_escapes() {
        assert!(review_file("src/main/include/subsystems/shooter/ShooterConstants.h"));
        assert!(review_file("tools/mayhem/machines.json"));
        assert!(review_file("robot.mayhem.json"));
        assert!(!review_file("src/main/cpp/Robot.cpp"));
        assert!(!review_file("examples/x.mayhem.json"));
        let root = Path::new("/repo");
        assert!(inside(root, "src/main/include/A.h").is_ok());
        assert!(inside(root, "../etc/passwd").is_err());
        assert!(inside(root, "/etc/passwd").is_err());
    }
}
