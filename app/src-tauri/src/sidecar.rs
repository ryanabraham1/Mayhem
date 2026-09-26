//! Graceful shutdown of the `mayhem-solver` sidecar when the app exits.
//!
//! Why this exists: tauri-plugin-shell already kills every child it spawned on
//! `RunEvent::Exit`, but it uses SIGKILL. The sidecar is a PyInstaller *onefile* binary, i.e.
//! a small bootloader process that unpacks the Python runtime into a temp dir (`_MEIxxxxxx`)
//! and runs the real server as its own child. SIGKILLing the bootloader means:
//!   * the unpacked temp dir (~170 MB) is never deleted, and
//!   * the Python server is orphaned until it notices stdin EOF (it does exit then, and
//!     cancels running solve jobs, but not instantly).
//!
//! So, before the shell plugin's hook runs, we send SIGINT to our own direct children named
//! `mayhem-solver`. The bootloader forwards it to Python, where it raises KeyboardInterrupt in
//! the stdio loop -> `Server.shutdown()` cancels solve jobs -> Python exits -> the bootloader
//! removes the temp dir and exits. Anything still alive after a short grace period gets
//! SIGTERM, and whatever survives that is SIGKILLed by the shell plugin right after us.
//!
//! On Windows the shell plugin's TerminateProcess is left to do the job (the PyInstaller
//! bootloader puts its child in a kill-on-close job object there).

use std::time::Duration;

use tauri::{
    plugin::{Builder, TauriPlugin},
    RunEvent, Runtime,
};

/// Executable name of the sidecar as placed next to the app binary by `bundle.externalBin`.
const SIDECAR_NAME: &str = "mayhem-solver";

pub fn reaper<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mayhem-sidecar-reaper")
        .on_event(|_app, event| {
            if let RunEvent::Exit = event {
                stop_sidecars(Duration::from_millis(1500), Duration::from_millis(500));
            }
        })
        .build()
}

#[cfg(unix)]
fn stop_sidecars(interrupt_grace: Duration, term_grace: Duration) {
    let pids = unix::child_pids_named(SIDECAR_NAME);
    if pids.is_empty() {
        return;
    }
    unix::signal_all(&pids, libc::SIGINT);
    let left = unix::wait_gone(&pids, interrupt_grace);
    if !left.is_empty() {
        unix::signal_all(&left, libc::SIGTERM);
        unix::wait_gone(&left, term_grace);
    }
}

#[cfg(not(unix))]
fn stop_sidecars(_interrupt_grace: Duration, _term_grace: Duration) {
    let _ = SIDECAR_NAME;
}

#[cfg(unix)]
mod unix {
    use std::time::{Duration, Instant};

    pub fn signal_all(pids: &[libc::pid_t], sig: libc::c_int) {
        for &pid in pids {
            // SAFETY: plain syscall; pids are our own direct children.
            unsafe {
                libc::kill(pid, sig);
            }
        }
    }

    fn alive(pid: libc::pid_t) -> bool {
        // The shell plugin has a thread blocked in wait() on each child, so exited children
        // are reaped promptly and kill(pid, 0) starts failing with ESRCH.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Waits until all `pids` are gone or `grace` elapses; returns the ones still alive.
    pub fn wait_gone(pids: &[libc::pid_t], grace: Duration) -> Vec<libc::pid_t> {
        let deadline = Instant::now() + grace;
        loop {
            let left: Vec<_> = pids.iter().copied().filter(|&p| alive(p)).collect();
            if left.is_empty() || Instant::now() >= deadline {
                return left;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(target_os = "macos")]
    pub fn child_pids_named(name: &str) -> Vec<libc::pid_t> {
        let me = unsafe { libc::getpid() };
        let mut buf = vec![0 as libc::pid_t; 1024];
        let bytes = unsafe {
            libc::proc_listchildpids(
                me,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
            )
        };
        if bytes <= 0 {
            return Vec::new();
        }
        // proc_listchildpids returns a count of pids on current macOS, bytes on older ones;
        // clamp either way and skip zero entries.
        let n = (bytes as usize).min(buf.len());
        buf.truncate(n);
        buf.into_iter()
            .filter(|&pid| pid > 0 && process_name(pid).as_deref() == Some(name))
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut buf = [0u8; 256];
        let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn child_pids_named(name: &str) -> Vec<libc::pid_t> {
        // Linux & friends with procfs: scan /proc/<pid>/stat for our children.
        let me = unsafe { libc::getpid() };
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<libc::pid_t>().ok())
            else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                continue;
            };
            // Format: "pid (comm) state ppid ..."; comm may contain spaces/parens, so split at
            // the last ')'.
            let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
                continue;
            };
            let comm = &stat[open + 1..close];
            let ppid = stat[close + 1..]
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<libc::pid_t>().ok());
            // comm is truncated to 15 bytes by the kernel.
            let want = &name[..name.len().min(15)];
            if ppid == Some(me) && comm == want {
                out.push(pid);
            }
        }
        out
    }
}
