//! The robot repo's GitHub pull requests for the Changes page, through the GitHub CLI (`gh`) and
//! the sign-in it already has. Mayhem never reads, stores or logs a token. Only three things go to
//! GitHub: reading a branch's PRs, reading the repo's merge settings, and merging one PR at the
//! exact commit that was reviewed. Updating the local checkout afterwards never discards edits.
use serde::Serialize;
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};

/// Desktop apps on macOS start without the shell's PATH, where Homebrew puts gh and git.
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

fn search_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .map(|p| p.split(':').map(String::from).collect())
        .unwrap_or_default();
    if cfg!(not(windows)) {
        for extra in EXTRA_PATH {
            if !parts.iter().any(|p| p == extra) {
                parts.push(extra.to_string());
            }
        }
    }
    parts.join(if cfg!(windows) { ";" } else { ":" })
}

fn gh_path() -> Option<String> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut dirs: Vec<String> = search_path()
        .split(if cfg!(windows) { ';' } else { ':' })
        .map(String::from)
        .collect();
    if cfg!(windows) {
        dirs.push(r"C:\Program Files\GitHub CLI".into());
    }
    dirs.iter()
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn run(program: &str, repo: &str, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(repo).env("PATH", search_path());
    if program != "git" {
        // Never wait on a question nobody can answer.
        cmd.env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    } else {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    cmd.output()
        .map_err(|e| format!("Could not run {program}: {e}"))
}

fn text(out: &Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        err
    }
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = run("git", repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(text(&out))
    }
}

fn gh(gh: &str, repo: &str, args: &[&str]) -> Result<String, String> {
    let out = run(gh, repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(text(&out))
    }
}

const PR_FIELDS: &str = "number,title,url,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergedAt,reviewDecision,statusCheckRollup";

fn error(missing: bool, message: String) -> Value {
    serde_json::json!({ "kind": "error", "missing": missing, "message": message })
}

fn lookup(repo: &str, branch: &str) -> Value {
    let Some(gh_bin) = gh_path() else {
        return error(true, "gh not found".into());
    };
    let prs = match gh(
        &gh_bin,
        repo,
        &[
            "pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json", PR_FIELDS,
        ],
    ) {
        Ok(out) => out,
        Err(e) => return error(false, e),
    };
    let settings = match gh(&gh_bin, repo, &["repo", "view", "--json", "nameWithOwner,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod"]) {
        Ok(out) => out,
        Err(e) => return error(false, e),
    };
    match (
        serde_json::from_str::<Value>(&prs),
        serde_json::from_str::<Value>(&settings),
    ) {
        (Ok(prs), Ok(repo)) => serde_json::json!({ "kind": "found", "prs": prs, "repo": repo }),
        _ => error(
            false,
            "gh answered with something Mayhem could not read".into(),
        ),
    }
}

/// The pull requests of a branch of the robot repo, and the repo's merge settings (`PrLookup` in
/// core/review/pullRequest.ts).
#[tauri::command]
pub async fn review_pr(repo: String, branch: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || lookup(&repo, &branch))
        .await
        .map_err(|e| e.to_string())
}

/// Merge PR `number` with `method`, only if its head is still `head` (the commit reviewed).
#[tauri::command]
pub async fn review_pr_merge(
    repo: String,
    number: u32,
    method: String,
    head: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let flag = match method.as_str() {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            _ => return Err(format!("Unknown merge method {method}")),
        };
        if head.len() != 40 || !head.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Merging needs the full commit that was reviewed.".into());
        }
        let gh_bin = gh_path().ok_or("The GitHub CLI (gh) isn't installed.")?;
        let n = number.to_string();
        gh(
            &gh_bin,
            &repo,
            &["pr", "merge", &n, flag, "--match-head-commit", &head],
        )?;
        // Bring the merge into this clone, so the branch list and the review see it.
        let _ = git(&repo, &["fetch", "--quiet", "origin"]);
        Ok(format!("Merged #{number}."))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MainUpdate {
    /// "updated": on main and up to date; "blocked": nothing was changed; "kept": updated, and the
    /// edits wait in a stash because main changed the same files.
    status: String,
    message: String,
    /// Uncommitted files that were carried over or kept.
    edits: Vec<String>,
}

fn update(status: &str, message: String, edits: Vec<String>) -> Result<MainUpdate, String> {
    Ok(MainUpdate {
        status: status.into(),
        message,
        edits,
    })
}

fn lines(s: &str) -> Vec<String> {
    s.lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

const MAIN: &str = "main";
const STASH_MESSAGE: &str = "Mayhem: edits kept while updating main";

/// Files a stash changed, including the untracked files it holds.
fn stash_files(root: &str, stash: &str) -> Vec<String> {
    let mut files = lines(
        &git(root, &["diff", "--name-only", &format!("{stash}^1"), stash]).unwrap_or_default(),
    );
    if let Ok(untracked) = git(
        root,
        &["ls-tree", "-r", "--name-only", &format!("{stash}^3")],
    ) {
        files.extend(lines(&untracked));
    }
    files
}

/// Find a stash entry by its commit, to drop or pop exactly that one.
fn stash_ref(root: &str, sha: &str) -> Option<String> {
    let list = git(root, &["stash", "list", "--format=%gd %H"]).ok()?;
    list.lines().find_map(|l| {
        l.split_once(' ')
            .filter(|(_, h)| *h == sha)
            .map(|(r, _)| r.to_string())
    })
}

fn update_main(repo: &str, keep_edits: bool) -> Result<MainUpdate, String> {
    let root = git(repo, &["rev-parse", "--show-toplevel"])?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let edits: Vec<String> = git(&root, &["status", "--porcelain", "--untracked-files=all"])?
        .lines()
        .filter_map(|l| l.get(3..))
        .map(|p| {
            p.rsplit(" -> ")
                .next()
                .unwrap_or(p)
                .trim_matches('"')
                .to_string()
        })
        .collect();
    let switch_and_pull = || -> Result<(), String> {
        if branch != MAIN {
            git(&root, &["switch", MAIN])?;
        }
        git(&root, &["pull", "--ff-only", "--quiet", "origin", MAIN]).map(|_| ())
    };
    if edits.is_empty() || !keep_edits {
        // Git itself refuses to switch or pull over uncommitted edits it would overwrite, and
        // changes nothing when it does.
        return match switch_and_pull() {
            Ok(()) => update(
                "updated",
                if edits.is_empty() {
                    format!("On {MAIN} and up to date.")
                } else {
                    format!("On {MAIN} and up to date. Your uncommitted edits are still there.")
                },
                edits,
            ),
            Err(e) => {
                let on = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
                let moved = if on == branch {
                    "Nothing was changed".to_string()
                } else {
                    format!("Switched to {MAIN}, but did not pull")
                };
                update("blocked", format!("{moved}: {e}"), edits)
            }
        };
    }
    // Set the edits aside, update, then put them back where main didn't change the same files.
    let before = git(&root, &["rev-parse", "HEAD"])?;
    git(
        &root,
        &[
            "stash",
            "push",
            "--include-untracked",
            "--quiet",
            "-m",
            STASH_MESSAGE,
        ],
    )?;
    let stash = git(&root, &["rev-parse", "stash@{0}"])?;
    if let Err(e) = switch_and_pull() {
        let _ = git(&root, &["switch", &branch]);
        let restored = stash_ref(&root, &stash)
            .map(|r| git(&root, &["stash", "pop", "--index", "--quiet", &r]).is_ok())
            .unwrap_or(false);
        return update(
            "blocked",
            if restored {
                format!("Nothing was changed: {e}")
            } else {
                format!("Could not update {MAIN} ({e}). Your edits are kept in git stash as \u{201c}{STASH_MESSAGE}\u{201d}.")
            },
            edits,
        );
    }
    let after = git(&root, &["rev-parse", "HEAD"])?;
    let changed = lines(&git(&root, &["diff", "--name-only", &before, &after])?);
    let mut overlap: Vec<String> = stash_files(&root, &stash)
        .into_iter()
        .filter(|f| changed.contains(f))
        .collect();
    overlap.sort();
    overlap.dedup();
    if !overlap.is_empty() {
        return update(
            "kept",
            format!(
                "On {MAIN} and up to date. {MAIN} changed {} too, so your edits were not put back: they are kept in git stash as \u{201c}{STASH_MESSAGE}\u{201d}. Run git stash pop to bring them back when you're ready.",
                overlap.join(", ")
            ),
            edits,
        );
    }
    match git(&root, &["stash", "apply", "--quiet", &stash]) {
        Ok(_) => {
            if let Some(r) = stash_ref(&root, &stash) {
                let _ = git(&root, &["stash", "drop", "--quiet", &r]);
            }
            update("updated", format!("On {MAIN} and up to date. Your uncommitted edits were put back."), edits)
        }
        Err(e) => update(
            "kept",
            format!("On {MAIN} and up to date, but your edits could not be put back ({e}). They are kept in git stash as \u{201c}{STASH_MESSAGE}\u{201d}."),
            edits,
        ),
    }
}

/// Switch the robot repo's checkout to main and pull. With uncommitted edits, `keep_edits` sets them
/// aside and puts them back; without it, git refuses rather than touch them. Edits are never discarded.
#[tauri::command]
pub async fn review_update_main(repo: String, keep_edits: bool) -> Result<MainUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || update_main(&repo, keep_edits))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A GitHub stand-in, a clone with an edit on main, and a second clone that pushes `upstream`.
    fn setup(name: &str, upstream: &str) -> (std::path::PathBuf, String) {
        let base = std::env::temp_dir().join(format!("mayhem-gh-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        sh(&base, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        for clone in ["me", "them"] {
            sh(
                &base,
                &[
                    "clone",
                    "-q",
                    "--config",
                    "core.autocrlf=false",
                    "origin.git",
                    clone,
                ],
            );
            let dir = base.join(clone);
            sh(&dir, &["config", "user.email", "t@example.com"]);
            sh(&dir, &["config", "user.name", "T"]);
            if clone == "me" {
                fs::write(dir.join("robot.mayhem.json"), "1\n").unwrap();
                fs::write(dir.join("other.txt"), "1\n").unwrap();
                sh(&dir, &["checkout", "-q", "-B", "main"]);
                sh(&dir, &["add", "."]);
                sh(&dir, &["commit", "-q", "-m", "start"]);
                sh(&dir, &["push", "-q", "origin", "main"]);
            } else {
                sh(&dir, &["pull", "-q", "origin", "main"]);
                fs::write(dir.join(upstream), "merged\n").unwrap();
                sh(&dir, &["commit", "-q", "-am", "merged PR"]);
                sh(&dir, &["push", "-q", "origin", "HEAD:main"]);
            }
        }
        let me = base.join("me");
        fs::write(me.join("robot.mayhem.json"), "my edit\n").unwrap();
        (base, me.to_string_lossy().into_owned())
    }

    #[test]
    fn edits_in_files_main_did_not_change_come_along() {
        let (base, me) = setup("apart", "other.txt");
        // Git pulls around an edit in another file; nothing is set aside.
        let done = update_main(&me, false).unwrap();
        assert_eq!(done.status, "updated", "{done:?}");
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("robot.mayhem.json")).unwrap(),
            "my edit\n"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("other.txt")).unwrap(),
            "merged\n"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn edits_main_also_changed_are_never_lost() {
        let (base, me) = setup("same", "robot.mayhem.json");
        let refused = update_main(&me, false).unwrap();
        assert_eq!(refused.status, "blocked", "{refused:?}");
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("robot.mayhem.json")).unwrap(),
            "my edit\n"
        );
        let kept = update_main(&me, true).unwrap();
        assert_eq!(kept.status, "kept", "{kept:?}");
        // Main's version is checked out and the edit waits in the stash.
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("robot.mayhem.json")).unwrap(),
            "merged\n"
        );
        assert_eq!(
            git(&me, &["show", "stash@{0}:robot.mayhem.json"]).unwrap(),
            "my edit"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn edits_are_put_back_after_setting_them_aside() {
        let (base, me) = setup("aside", "other.txt");
        fs::write(Path::new(&me).join("new.txt"), "untracked\n").unwrap();
        let done = update_main(&me, true).unwrap();
        assert_eq!(done.status, "updated", "{done:?}");
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("robot.mayhem.json")).unwrap(),
            "my edit\n"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&me).join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(git(&me, &["stash", "list"]).unwrap(), "");
        fs::remove_dir_all(base).unwrap();
    }
}
