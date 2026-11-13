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
        || path == "tools/mayhem/explainer.json"
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
        // The default branches always, however old (the list above keeps the 40 most recent refs).
        for name in ["origin/main", "main", "origin/master", "master"] {
            if revisions.iter().any(|r| r.rev == name) {
                continue;
            }
            if let Ok(line) = git(&root, &["log", "-1", "--format=%H\t%s\t%cI", name]) {
                let f: Vec<&str> = line.trim().splitn(3, '\t').collect();
                if f.len() == 3 {
                    let kind = if name.starts_with("origin/") { "remote" } else { "branch" };
                    revisions.push(Revision { rev: name.into(), sha: f[0].into(), label: f[1].into(), kind: kind.into(), date: f[2].into() });
                }
            }
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
        // A missing file reads as empty, so the first save of a new file expects "".
        let current = fs::read_to_string(&target).unwrap_or_default();
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

#[derive(Serialize)]
pub struct Commit {
    sha: String,
    subject: String,
    body: String,
}

/// Commits after `before` up to `after` (the working tree counts as HEAD), newest first.
#[tauri::command]
pub async fn review_commits(repo: String, before: String, after: String) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let after = if after == WORKTREE { "HEAD".to_string() } else { after };
        let before = if before == WORKTREE { "HEAD".to_string() } else { before };
        let range = format!("{before}..{after}");
        let log = git(&repo, &["log", "-200", "--format=%H%x1f%s%x1f%b%x1e", &range])?;
        Ok(log
            .split('\x1e')
            .filter_map(|entry| {
                let f: Vec<&str> = entry.trim_start_matches('\n').splitn(3, '\x1f').collect();
                (f.len() == 3 && !f[0].is_empty()).then(|| Commit { sha: f[0].into(), subject: f[1].into(), body: f[2].trim().into() })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The latest commits that touched any of `paths` (repo-relative files or folders).
#[tauri::command]
pub async fn review_history(repo: String, paths: Vec<String>, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(git(&repo, &["rev-parse", "--show-toplevel"])?.trim());
        for p in &paths {
            inside(&root, p)?;
        }
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let count = format!("-{}", limit.unwrap_or(8).min(50));
        let mut args = vec!["log", count.as_str(), "--format=%H%x1f%s%x1f%an %cr%x1e", "--"];
        args.extend(paths.iter().map(String::as_str));
        let log = git(root.to_str().ok_or("path")?, &args)?;
        Ok(log
            .split('\x1e')
            .filter_map(|entry| {
                let f: Vec<&str> = entry.trim_start_matches('\n').splitn(3, '\x1f').collect();
                (f.len() == 3 && !f[0].is_empty()).then(|| Commit { sha: f[0].into(), subject: f[1].into(), body: f[2].trim().into() })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

const REVIEW_DIR: &str = "tools/mayhem/review";

fn item_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Bad review item id {id}"));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Item {
    id: String,
    text: String,
}

/// Every feedback/task file in the robot repo's working tree.
#[tauri::command]
pub async fn review_items(repo: String) -> Result<Vec<Item>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(git(&repo, &["rev-parse", "--show-toplevel"])?.trim());
        let dir = root.join(REVIEW_DIR);
        let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
        let mut items = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if path.extension().is_some_and(|e| e == "json") && item_id(id).is_ok() {
                if let Ok(text) = fs::read_to_string(&path) {
                    items.push(Item { id: id.to_string(), text });
                }
            }
        }
        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Creates (`expected` absent: the file must not exist) or updates (the file must still hold
/// `expected`) one feedback/task file, atomically.
#[tauri::command]
pub async fn review_item_save(repo: String, id: String, text: String, expected: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        item_id(&id)?;
        let root = PathBuf::from(git(&repo, &["rev-parse", "--show-toplevel"])?.trim());
        let dir = root.join(REVIEW_DIR);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(format!("{id}.json"));
        let current = fs::read_to_string(&target).ok();
        if current != expected {
            return Err(if expected.is_none() { format!("{id} already exists") } else { "Someone changed this item meanwhile. Reload and try again.".into() });
        }
        let temporary = dir.join(format!(".{id}.{}.tmp", std::process::id()));
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
        assert!(item_id("20261113101500-ab12").is_ok());
        assert!(item_id("../x").is_err());
    }
}
