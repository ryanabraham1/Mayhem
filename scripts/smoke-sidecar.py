#!/usr/bin/env python3
"""Smoke-test a (frozen) mayhem-solver binary over its stdio JSON-RPC protocol.

    python3 scripts/smoke-sidecar.py app/src-tauri/binaries/mayhem-solver-<triple>

Checks: time to the "ready" line, ping, fields, defaultProject, and a real solve that must
end in a successful solveDone (this exercises the multiprocessing "spawn" workers, which
re-exec the frozen binary). Exits non-zero on any failure. Stdlib only.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import queue


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    exe = sys.argv[1]
    t0 = time.monotonic()
    p = subprocess.Popen([exe, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=sys.stderr, text=True, bufsize=1)
    lines: queue.Queue = queue.Queue()

    def pump():
        for line in p.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()

    def recv(timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("timed out waiting for solver output")
            line = lines.get(timeout=left)
            if line is None:
                raise RuntimeError(f"solver exited (code {p.wait()})")
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                print("non-protocol stdout:", line, file=sys.stderr)

    def send(msg: dict):
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()

    def call(mid: int, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        send({"id": mid, "method": method, "params": params or {}})
        while True:
            m = recv(timeout)
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m["result"]

    try:
        ready = recv(60)
        t_ready = time.monotonic() - t0
        assert ready.get("method") == "ready", ready
        print(f"ready in {t_ready:.2f}s: {ready['params']}")
        print("ping:", call(1, "ping"))
        fields = call(2, "listFields")
        print("fields:", [f["id"] for f in fields])
        assert fields, "no bundled field presets found"
        project = call(3, "defaultProject")
        traj = {"name": "smoke", "waypoints": [
            {"id": "a", "x": 2, "y": 2, "heading": 0, "stop": True},
            {"id": "b", "x": 3, "y": 6, "heading": 0, "stop": True},
        ]}
        t1 = time.monotonic()
        # On Windows, the first frozen worker can take over 30 seconds to unpack
        # and start. Process.start() waits for that worker to read its startup
        # pipe, so allow the server longer to acknowledge this call.
        job = call(4, "solve", {"project": project, "trajectory": traj}, timeout=180)
        print("solve started:", job)
        progress = 0
        while True:
            m = recv(180)
            if m.get("method") == "solveProgress":
                progress += 1
            elif m.get("method") == "solveDone":
                dt = time.monotonic() - t1
                issues = m["params"].get("issues")
                ok = m["params"].get("success")
                stats = (m["params"].get("output") or {}).get("stats")
                print(f"solveDone success={ok} in {dt:.1f}s ({progress} progress msgs) stats={stats} issues={issues}")
                if not ok:
                    print(m["params"].get("trace", ""), file=sys.stderr)
                    return 1
                break
        print("SMOKE TEST PASSED")
        return 0
    finally:
        try:
            p.stdin.close()  # EOF -> server shuts down
            p.wait(timeout=10)
        except Exception:
            p.kill()


if __name__ == "__main__":
    sys.exit(main())
