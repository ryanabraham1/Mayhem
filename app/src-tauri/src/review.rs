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

/// Same selection as `isRobotCode` in core/review/report.ts: files that end up on the robot.
fn robot_code(path: &str) -> bool {
    (path.starts_with("src/main/") && path != "src/main/deploy/mayhem-build.json")
        || (path.starts_with("vendordeps/") && path.ends_with(".json") && path.matches('/').count() == 1)
        || path == "build.gradle"
}

/// Runs git with `input` on stdin and returns its stdout.
fn git_with_input(repo: &str, args: &[&str], input: String) -> Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("git stdin")?;
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let mut out = Vec::new();
    child.stdout.take().ok_or("git stdout")?.read_to_end(&mut out).map_err(|e| e.to_string())?;
    writer.join().map_err(|_| "git writer panicked")?.map_err(|e| e.to_string())?;
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err(format!("git {} failed", args.first().unwrap_or(&"")));
    }
    Ok(out)
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
    /// Review files and robot code with uncommitted changes.
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
            .filter(|p| review_file(p) || robot_code(p))
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
    /// Content id (git blob id) of every file that ends up on the robot, so the review can tell
    /// that code it does not read changed.
    code: HashMap<String, String>,
}

#[tauri::command]
pub async fn review_snapshot(repo: String, rev: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(repo, rev)).await.map_err(|e| e.to_string())?
}

fn snapshot(repo: String, rev: String) -> Result<Snapshot, String> {
    let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let mut files = HashMap::new();
    let mut code = HashMap::new();
    if rev == WORKTREE {
        // -z: paths with spaces or non-ASCII characters come back unquoted.
        let listed = git(&root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?;
        let mut on_robot: Vec<&str> = Vec::new();
        for path in listed.split('\0').filter(|p| !p.is_empty()) {
            let file = Path::new(&root).join(path);
            if review_file(path) {
                if let Ok(text) = fs::read_to_string(&file) {
                    files.insert(path.to_string(), text);
                }
            }
            // Deleted but not yet committed: not on disk, so not in this snapshot.
            if robot_code(path) && file.is_file() && !on_robot.contains(&path) {
                on_robot.push(path);
            }
        }
        if !on_robot.is_empty() {
            let request: String = on_robot.iter().map(|p| format!("{p}\n")).collect();
            let out = git_with_input(&root, &["hash-object", "--stdin-paths"], request)?;
            for (path, id) in on_robot.iter().zip(String::from_utf8_lossy(&out).lines()) {
                code.insert(path.to_string(), id.to_string());
            }
        }
        return Ok(Snapshot { rev, label: "This computer (not committed)".into(), files, code });
    }
    let sha = git(&root, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string();
    let subject = git(&root, &["log", "-1", "--format=%s", &sha])?.trim().to_string();
    let mut paths: Vec<String> = Vec::new();
    // "<mode> <type> <id>\t<path>", NUL-separated.
    for entry in git(&root, &["ls-tree", "-r", "-z", "--full-tree", &sha])?.split('\0') {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        let mut fields = meta.split(' ');
        let (Some(_mode), Some(kind), Some(id)) = (fields.next(), fields.next(), fields.next()) else { continue };
        if kind != "blob" {
            continue;
        }
        if review_file(path) {
            paths.push(path.to_string());
        }
        if robot_code(path) {
            code.insert(path.to_string(), id.to_string());
        }
    }
    let request: String = paths.iter().map(|p| format!("{sha}:{p}\n")).collect();
    let out = git_with_input(&root, &["cat-file", "--batch"], request)?;
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
    Ok(Snapshot { rev: sha, label, files, code })
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

/// Git notes that hold sim proof results (core/review/proofs.ts).
const PROOF_NOTES: &str = "--ref=refs/notes/mayhem-proof";
const AS_MAYHEM: [&str; 4] = ["-c", "user.name=Mayhem", "-c", "user.email=mayhem@localhost"];

/// The full id of a commit, or `None` when this clone does not have it.
fn commit(root: &str, rev: &str) -> Option<String> {
    // Never let a revision be read as an option.
    if rev.is_empty() || rev.starts_with('-') {
        return None;
    }
    git(root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether the history of `target` includes the change `base..tip`: as the same commits (a merge
/// or fast-forward), as equivalent commits (a rebase), or as one commit with the same total patch
/// (a squash merge). `None` when this clone does not have `target`. Mirrors `reaches` in
/// scripts/review-git.mjs.
fn reaches(root: &str, base: &str, tip: &str, target: &str) -> Option<bool> {
    let to = commit(root, target)?;
    if git(root, &["merge-base", "--is-ancestor", tip, &to]).is_ok() {
        return Some(true);
    }
    if base == tip {
        return Some(false);
    }
    let rebased = git(root, &["cherry", &to, tip, base]).unwrap_or_default();
    if rebased.lines().next().is_some() && rebased.lines().all(|l| l.starts_with('-')) {
        return Some(true);
    }
    // One commit carrying the whole change, as a squash merge makes; never referenced, so git drops it.
    let tree = format!("{tip}^{{tree}}");
    let mut args = AS_MAYHEM.to_vec();
    args.extend(["commit-tree", tree.as_str(), "-p", base, "-m", "Mayhem: is this change in there?"]);
    let Ok(squashed) = git(root, &args) else { return Some(false) };
    let squashed = squashed.trim();
    Some(!squashed.is_empty() && git(root, &["cherry", &to, squashed, base]).unwrap_or_default().lines().any(|l| l.starts_with('-')))
}

#[derive(Serialize)]
pub struct MainRef {
    rev: String,
    sha: String,
}

/// A branch as a change to review.
#[derive(Serialize)]
pub struct Branch {
    name: String,
    /// What to hand git: the local name, or `origin/<name>` when only GitHub has it.
    rev: String,
    sha: String,
    /// The commit it left main at: the change is `base..sha`.
    base: String,
    ahead: u32,
    subject: String,
    author: String,
    date: String,
    /// Main already has it (merged, rebased or squashed).
    merged: bool,
}

#[derive(Serialize)]
pub struct Branches {
    main: Option<MainRef>,
    branches: Vec<Branch>,
}

/// How many of the newest branches are looked at.
const BRANCHES: usize = 30;

fn branches(repo: &str) -> Result<Branches, String> {
    let root = git(repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let Some(main) = ["origin/main", "main"].iter().find_map(|rev| commit(&root, rev).map(|sha| MainRef { rev: rev.to_string(), sha })) else {
        return Ok(Branches { main: None, branches: Vec::new() });
    };
    let listed = git(
        &root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )?;
    let mut seen: Vec<String> = Vec::new();
    let mut found = Vec::new();
    for line in listed.lines() {
        let f: Vec<&str> = line.splitn(5, '\t').collect();
        if f.len() < 5 {
            continue;
        }
        let (reference, tip) = (f[0], f[1]);
        let local = reference.starts_with("refs/heads/");
        let name = reference.trim_start_matches("refs/heads/").trim_start_matches("refs/remotes/origin/");
        // The same commits under two names (a local branch and a renamed one on GitHub) are one change.
        if name == "HEAD" || name == "main" || name == "master" || tip == main.sha || seen.iter().any(|s| s == name || s == tip) {
            continue;
        }
        seen.push(name.to_string());
        seen.push(tip.to_string());
        if found.len() >= BRANCHES {
            break;
        }
        let Ok(base) = git(&root, &["merge-base", &main.sha, tip]) else { continue };
        let mut base = base.trim().to_string();
        let merged = if base == tip {
            // Already an ancestor of main. What it changed is known only if a merge commit brought it in.
            let merges = git(&root, &["rev-list", "--ancestry-path", "--merges", "--reverse", &format!("{tip}..{}", main.sha)]).unwrap_or_default();
            let Some(merge) = merges.lines().next() else { continue };
            base = git(&root, &["merge-base", &format!("{merge}^1"), tip]).unwrap_or_default().trim().to_string();
            if base.is_empty() || base == tip {
                continue;
            }
            true
        } else {
            reaches(&root, &base, tip, &main.sha) == Some(true)
        };
        let ahead = git(&root, &["rev-list", "--count", &format!("{base}..{tip}")])?.trim().parse().unwrap_or(0);
        found.push(Branch {
            name: name.to_string(),
            rev: if local { name.to_string() } else { format!("origin/{name}") },
            sha: tip.to_string(),
            base,
            ahead,
            subject: f[4].to_string(),
            author: f[3].to_string(),
            date: f[2].to_string(),
            merged,
        });
    }
    Ok(Branches { main: Some(main), branches: found })
}

/// Branches of the robot repo as changes to review (Changes page).
#[tauri::command]
pub async fn review_branches(repo: String) -> Result<Branches, String> {
    tauri::async_runtime::spawn_blocking(move || branches(&repo)).await.map_err(|e| e.to_string())?
}

/// For each of `targets` (commits: main, what the robot runs, what a log ran): whether its history
/// includes the change `base..tip`; `null` for a commit this clone does not have.
#[tauri::command]
pub async fn review_reaches(repo: String, base: String, tip: String, targets: Vec<String>) -> Result<Vec<Option<bool>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let (Some(base), Some(tip)) = (commit(&root, &base), commit(&root, &tip)) else {
            return Ok(targets.iter().map(|_| None).collect());
        };
        Ok(targets.iter().map(|t| reaches(&root, &base, &tip, t)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The sim proof note of each commit, or `null`.
#[tauri::command]
pub async fn review_proofs(repo: String, commits: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(commits
            .iter()
            .map(|rev| commit(&repo, rev).and_then(|sha| git(&repo, &["notes", PROOF_NOTES, "show", &sha]).ok()))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes the sim proof note of a commit (the whole note; core/review/proofs.ts builds it).
#[tauri::command]
pub async fn review_proof_save(repo: String, commit_id: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sha = commit(&repo, &commit_id).ok_or_else(|| format!("{commit_id} is not a commit in this repository."))?;
        let note: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Not a proof note: {e}"))?;
        if note.get("format").and_then(|f| f.as_str()) != Some("mayhem-proof") {
            return Err("Not a proof note.".into());
        }
        let mut args = AS_MAYHEM.to_vec();
        args.extend(["notes", PROOF_NOTES, "add", "-f", "-m", text.as_str(), sha.as_str()]);
        git(&repo, &args).map(|_| ())
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
        assert!(robot_code("src/main/cpp/Robot.cpp"));
        assert!(robot_code("src/main/deploy/choreo/a.traj"));
        assert!(robot_code("vendordeps/Phoenix6.json"));
        assert!(robot_code("build.gradle"));
        assert!(!robot_code("src/main/deploy/mayhem-build.json"));
        assert!(!robot_code("src/test/cpp/main.cpp"));
        assert!(!robot_code("tools/mayhem/scenarios.json"));
        let root = Path::new("/repo");
        assert!(inside(root, "src/main/include/A.h").is_ok());
        assert!(inside(root, "../etc/passwd").is_err());
        assert!(inside(root, "/etc/passwd").is_err());
    }

    /// A scratch repo with `main` and helpers to commit files on branches.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("mayhem-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let s = Scratch(dir);
            s.git(&["init", "-q", "-b", "main"]);
            s.git(&["config", "user.name", "t"]);
            s.git(&["config", "user.email", "t@example.com"]);
            s.write("src/main/cpp/Robot.cpp", "void Run() {}\n", "first");
            s
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
        fn git(&self, args: &[&str]) -> String {
            git(&self.path(), args).unwrap().trim().to_string()
        }
        fn write(&self, file: &str, text: &str, message: &str) -> String {
            let path = self.0.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
            self.git(&["add", "."]);
            self.git(&["commit", "-qm", message]);
            self.git(&["rev-parse", "HEAD"])
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_branches_to_review_and_finds_them_in_main_however_they_were_merged() {
        let s = Scratch::new("branches");
        let start = s.git(&["rev-parse", "HEAD"]);
        // Three branches off the same commit, each changing its own file.
        for name in ["merge-me", "squash-me", "open"] {
            s.git(&["checkout", "-q", "-b", name, &start]);
            s.write(&format!("src/main/cpp/{name}.cpp"), "void A() {}\n", &format!("{name} 1"));
            s.write(&format!("src/main/cpp/{name}.cpp"), "void A() { B(); }\n", &format!("{name} 2"));
        }
        s.git(&["checkout", "-q", "main"]);
        s.write("src/main/cpp/Robot.cpp", "void Run() { Go(); }\n", "main moves on");
        s.git(&["merge", "-q", "--no-ff", "merge-me", "-m", "Merge merge-me"]);
        s.git(&["merge", "-q", "--squash", "squash-me"]);
        s.git(&["commit", "-qm", "squash-me (#2)"]);

        let listed = branches(&s.path()).unwrap();
        assert_eq!(listed.main.as_ref().unwrap().rev, "main");
        let by = |name: &str| listed.branches.iter().find(|b| b.name == name).unwrap();
        assert_eq!(listed.branches.len(), 3);
        for name in ["merge-me", "squash-me", "open"] {
            assert_eq!(by(name).base, start, "{name} left main at the first commit");
            assert_eq!(by(name).ahead, 2);
        }
        assert!(by("merge-me").merged);
        assert!(by("squash-me").merged, "a squash merge keeps the patch, not the commits");
        assert!(!by("open").merged);

        // The same question for any other commit: what the robot runs, what a log ran.
        let root = s.path();
        let open = by("open");
        assert_eq!(reaches(&root, &open.base, &open.sha, "main"), Some(false));
        assert_eq!(reaches(&root, &open.base, &open.sha, &open.sha), Some(true));
        assert_eq!(reaches(&root, &open.base, &open.sha, "0123456789012345678901234567890123456789"), None);
        assert_eq!(reaches(&root, &start, &by("squash-me").sha, &start), Some(false));
    }

    #[test]
    fn proof_notes_stay_on_their_commit() {
        let s = Scratch::new("notes");
        let first = s.git(&["rev-parse", "HEAD"]);
        let note = r#"{"format":"mayhem-proof","version":1,"proofs":[]}"#;
        let mut args = AS_MAYHEM.to_vec();
        args.extend(["notes", PROOF_NOTES, "add", "-f", "-m", note, first.as_str()]);
        git(&s.path(), &args).unwrap();
        let second = s.write("src/main/cpp/Robot.cpp", "void Run() { Go(); }\n", "second");
        assert_eq!(git(&s.path(), &["notes", PROOF_NOTES, "show", &first]).unwrap().trim(), note);
        assert!(git(&s.path(), &["notes", PROOF_NOTES, "show", &second]).is_err(), "a new commit has no proof");
        assert!(commit(&s.path(), "--upload-pack=x").is_none());
    }

    /// A commit and the same files on disk get the same content ids; an edit changes only its file.
    #[test]
    fn snapshot_ids_tell_which_robot_code_changed() {
        let dir = std::env::temp_dir().join(format!("mayhem-review-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/main/cpp/sub dir")).unwrap();
        fs::create_dir_all(dir.join("src/main/include")).unwrap();
        fs::create_dir_all(dir.join("src/test")).unwrap();
        let repo = dir.to_string_lossy().to_string();
        fs::write(dir.join("src/main/cpp/Robot.cpp"), "void Run() {}\n").unwrap();
        fs::write(dir.join("src/main/cpp/sub dir/Intake.cpp"), "void Intake() {}\n").unwrap();
        fs::write(dir.join("src/main/include/Constants.h"), "inline constexpr int kId = 4;\n").unwrap();
        fs::write(dir.join("src/test/main.cpp"), "int main() {}\n").unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec!["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "first"],
        ] {
            git(&repo, &args).unwrap();
        }
        let committed = snapshot(repo.clone(), "HEAD".into()).unwrap();
        let on_disk = snapshot(repo.clone(), WORKTREE.into()).unwrap();
        assert_eq!(committed.code, on_disk.code);
        assert_eq!(committed.code.len(), 3, "everything under src/main, nothing under src/test");
        assert!(committed.code.contains_key("src/main/cpp/sub dir/Intake.cpp"));
        assert_eq!(committed.files.len(), 1, "only the header is read");

        fs::write(dir.join("src/main/cpp/Robot.cpp"), "void Run() { Shoot(); }\n").unwrap();
        fs::remove_file(dir.join("src/main/cpp/sub dir/Intake.cpp")).unwrap();
        let edited = snapshot(repo, WORKTREE.into()).unwrap();
        assert_ne!(edited.code["src/main/cpp/Robot.cpp"], committed.code["src/main/cpp/Robot.cpp"]);
        assert_eq!(edited.code["src/main/include/Constants.h"], committed.code["src/main/include/Constants.h"]);
        assert!(!edited.code.contains_key("src/main/cpp/sub dir/Intake.cpp"));
        let _ = fs::remove_dir_all(&dir);
    }
}
