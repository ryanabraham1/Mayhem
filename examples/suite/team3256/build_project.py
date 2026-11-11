"""Build a Mayhem suite project from Team3256/FRC_Offseason_2026 (branch claude/friendly-tesla-o02ue3).

Old time-optimal .mtraj paths become pose-to-pose routines; the C++ Superstructure becomes a
mayhem-machine manifest. Marker bindings mirror src/main/cpp/commands/MayhemAutos.cpp exactly,
including names that do not exist in the path (those never fire on the robot)."""
import json, math, sys
from pathlib import Path

repo = Path(sys.argv[1])
out = Path(sys.argv[2])
deploy = repo / "src/main/deploy/mayhem"
HUB = (4.0218614 + 0.0254 * 47 / 2, 8.069 / 2)


def load(name):
    return json.loads((deploy / f"{name}.mtraj").read_text())


def r3(v):
    return round(v, 3)


# (routine name, chooser label, [(trajectory, {marker name bound in code: state})])
AUTOS = [
    ("outpost-sweep", "Outpost Trench Sweep",
     [("OutpostTrenchSweepBumpPt1", {"intake": "INTAKE", "idle": "IDLE"})]),
    ("outpost-sweep-x2", "Outpost Trench Sweep x2",
     [("OutpostTrenchSweepBumpPt1", {"intake": "INTAKE", "idle": "IDLE"}),
      ("OutpostTrenchSweepBumpPt2", {"intake2": "INTAKE", "idle2": "IDLE"})]),
    ("depot-sweep", "Depot Trench Sweep",
     [("DepotTrenchSweepBumpPt1", {"intake": "INTAKE", "idle": "IDLE"})]),
    ("depot-sweep-x2", "Depot Trench Sweep x2",
     [("DepotTrenchSweepBumpPt1", {"intake": "INTAKE", "idle": "IDLE"}),
      ("DepotTrenchSweepBump2xPt2", {"intake2": "INTAKE", "idle2": "IDLE"})]),
    ("depot-sweep-depot", "Depot Trench Sweep Depot",
     [("DepotTrenchSweepDepotPt", {"intake": "INTAKE", "idle": "IDLE"}),
      ("DepotTrenchSweepDepotPt2", {"intake": "INTAKE"})]),
]

warnings = []


def routine(rid, label, parts):
    nodes, start = [], None
    for part_index, (traj_name, bindings) in enumerate(parts):
        traj = load(traj_name)
        wps = traj["waypoints"]
        marker_at = {}
        present = {m["name"]: m["waypoint"] for m in traj["markers"]}
        for name, state in bindings.items():
            if name in present:
                marker_at.setdefault(present[name], []).append((name, state))
            else:
                warnings.append(
                    f'{label}: {traj_name} has no "{name}" marker (it has {", ".join(sorted(present)) or "none"}), '
                    f"so AtTime(\"{name}\") never fires and the superstructure never goes to {state} there.")
        if part_index == 0:
            w0 = wps[0]
            start = {"x": r3(w0["x"]), "y": r3(w0["y"]), "heading": r3(w0["heading"])}

        def marker_steps(k):
            for name, state in marker_at.get(k, []):
                nodes.append({
                    "id": f"{traj_name}-{name}-{len(nodes)}",
                    "name": f"Superstructure → {state}",
                    "kind": "action",
                    "action": f"superstructure.setState.{state}",
                    "description": f'Path marker "{name}" in {traj_name}.',
                    "source": "src/main/cpp/commands/MayhemAutos.cpp",
                    "timeout": 0.5,
                })

        marker_steps(0)
        for k, w in enumerate(wps[1:], start=1):
            last = k == len(wps) - 1
            goal = {
                "x": r3(w["x"]), "y": r3(w["y"]), "heading": r3(w["heading"]),
                "translationTolerance": 0.06 if w["stop"] else 0.12,
                "rotationTolerance": 0.05 if w["stop"] else 0.2,
                "velocityTolerance": 0.15,
                "settleTime": 0.1 if w["stop"] else 0,
                "handoffRadius": 0 if (w["stop"] or last) else 0.35,
            }
            if w["headingMode"] == "free":
                goal["headingMode"] = "free"
            if last:
                goal["headingMode"] = "pointAt"
                goal["aimX"], goal["aimY"] = r3(HUB[0]), r3(HUB[1])
            nodes.append({
                "id": f"{traj_name}-w{k}",
                "name": f"{traj_name.replace('TrenchSweep', ' ').replace('Bump', '')} {k}" if not last
                else f"{traj_name} end",
                "kind": "pose",
                "goal": goal,
                "timeout": 6,
                "source": f"src/main/deploy/mayhem/{traj_name}.mtraj",
            })
            marker_steps(k)
        nodes.append({
            "id": f"align-shoot-{part_index}",
            "name": "Align and shoot",
            "kind": "custom",
            "action": "drivetrain.alignAndShoot",
            "description": "Rotate to the shot lookahead; once within 3°, set SHOOT. Gives up after 3.5 s.",
            "source": "MayhemAutosBase::AlignAndShoot",
            "timeout": 3.5,
        })
    nodes.append({"id": "done", "name": "Auto complete", "kind": "finish", "timeout": 1})
    transitions = [
        {"id": f"t{i}", "from": a["id"], "to": b["id"], "condition": {"kind": "always"}}
        for i, (a, b) in enumerate(zip(nodes, nodes[1:]))
    ]
    return {"id": rid, "name": label, "start": start, "initial": nodes[0]["id"],
            "nodes": nodes, "transitions": transitions}


def sig(key):
    return {"kind": "signal", "key": key, "op": "eq", "value": True}


def all_of(*c):
    return {"kind": "all", "conditions": list(c)}


def not_(c):
    return {"kind": "not", "condition": c}


S = "src/main/cpp/subsystems/Superstructure.cpp"
states = {
    "IDLE": "Everything off: rollers, shooter, indexer, feeder, slide. Hood to 0.05.",
    "INTAKE": "Rollers at 8 V. Hood clears the slide, then the slide runs its intake sequence.",
    "SHOOT": "Shooter spins for the hub (or corner feed); indexer and feeder run once the flywheel is at speed.",
    "REV": "In the alliance zone: spin the shooter for the hub without feeding.",
    "REV_AND_INTAKE": "Revving while intaking; slide to ground intake.",
    "SHOOT_AND_INTAKE": "Shooting and intaking together; slide to ground intake.",
    "JITTER": "Rollers on and the slide jitters to unjam pieces.",
    "JITTER_AND_SHOOT": "Jitter while shooting.",
    "HOME": "Hood 0.05, everything off, slide to ground intake position.",
    "OUTTAKE": "Rollers and feeder reverse.",
    "CANCEL_ALL": "Kill all mechanisms.",
}
A, X, Y, B, LT, ZONE, ENTER = (sig("driver.a"), sig("driver.x"), sig("driver.y"), sig("driver.b"),
                               sig("driver.leftTrigger"), sig("inAllianceZone"), sig("enteredAllianceZone"))
t = []


def edge(frm, to, cond):
    t.append({"id": f"{frm}-{to}-{len(t)}", "from": frm, "to": to, "condition": cond})


for s in states:
    # Shoot button; SHOOT right after INTAKE/REV_AND_INTAKE becomes SHOOT_AND_INTAKE, after JITTER becomes JITTER_AND_SHOOT.
    if s in ("INTAKE", "REV_AND_INTAKE"):
        edge(s, "SHOOT_AND_INTAKE", A)
    elif s == "JITTER":
        edge(s, "JITTER_AND_SHOOT", A)
    elif s not in ("SHOOT", "SHOOT_AND_INTAKE", "JITTER_AND_SHOOT"):
        edge(s, "SHOOT", A)
    # Intake button; after SHOOT it becomes SHOOT_AND_INTAKE, after REV it becomes REV_AND_INTAKE.
    if s == "SHOOT":
        edge(s, "SHOOT_AND_INTAKE", X)
    elif s == "REV":
        edge(s, "REV_AND_INTAKE", X)
    elif s not in ("INTAKE", "SHOOT_AND_INTAKE", "REV_AND_INTAKE"):
        edge(s, "INTAKE", X)
    if s in ("SHOOT", "SHOOT_AND_INTAKE"):
        edge(s, "JITTER_AND_SHOOT", Y)
    elif s not in ("JITTER", "JITTER_AND_SHOOT"):
        edge(s, "JITTER", Y)
    if s != "HOME":
        edge(s, "HOME", B)
    if s != "OUTTAKE":
        edge(s, "OUTTAKE", LT)
    # Entering the alliance zone sets REV from ANY state (edge-triggered on the robot), even while
    # shooting. REV right after INTAKE becomes REV_AND_INTAKE.
    if s == "INTAKE":
        edge(s, "REV_AND_INTAKE", ENTER)
    elif s not in ("REV", "REV_AND_INTAKE"):
        edge(s, "REV", ENTER)
edge("REV", "IDLE", not_(ZONE))
edge("REV_AND_INTAKE", "INTAKE", not_(ZONE))

machine = {
    "format": "mayhem-machine",
    "version": 1,
    "id": "Superstructure",
    "name": "Superstructure",
    "initial": "IDLE",
    "stateChannel": "/RealOutputs/Superstructure/State",
    "states": [{"id": k, "name": k.replace("_", " ").title(), "description": v, "source": S} for k, v in states.items()],
    "inputs": [
        {"key": "driver.a", "name": "Driver A (shoot)", "type": "boolean", "initial": False},
        {"key": "driver.x", "name": "Driver X (intake)", "type": "boolean", "initial": False},
        {"key": "driver.y", "name": "Driver Y (jitter)", "type": "boolean", "initial": False},
        {"key": "driver.b", "name": "Driver B (home)", "type": "boolean", "initial": False},
        {"key": "driver.leftTrigger", "name": "Driver left trigger (outtake)", "type": "boolean", "initial": False},
        {"key": "enteredAllianceZone", "name": "Just entered alliance zone (event)", "type": "boolean", "initial": False},
        {"key": "inAllianceZone", "name": "In alliance zone (blue x < 4 m, red x > 12.5 m)", "type": "boolean", "initial": False},
        {"key": "ready", "name": "Ready to shoot", "type": "boolean", "initial": False, "channel": "/RealOutputs/Superstructure/ReadyToShoot"},
        {"key": "flywheelReady", "name": "Flywheel at speed", "type": "boolean", "initial": False, "channel": "/RealOutputs/Superstructure/ReadyToShoot/Flywheel"},
        {"key": "pivotReady", "name": "Hood at angle", "type": "boolean", "initial": False, "channel": "/RealOutputs/Superstructure/ReadyToShoot/Pivot"},
    ],
    "transitions": t,
}

project = {
    "format": "mayhem-suite",
    "version": 1,
    "revision": 0,
    "id": "team3256-offseason-2026",
    "name": "3256 Offseason 2026",
    "field": {"name": "2026 REBUILT", "width": 16.541, "height": 8.069},
    "robot": {
        "name": "Offseason swerve (Kraken X60, 5.90:1)",
        "length": 0.813,
        "width": 0.813,
        "start": routine(*AUTOS[0])["start"],
        "constraints": {
            "maxVelocity": 4.5, "maxAcceleration": 4.0, "maxAngularVelocity": 6.0,
            "maxAngularAcceleration": 12.0, "translationKp": 3.2, "rotationKp": 4.0,
        },
    },
    "signals": [
        {"key": "superstructure.ready", "name": "Ready to shoot", "type": "boolean", "initial": False},
    ],
    "routines": [routine(*a) for a in AUTOS],
    "extensions": {
        "machines": [machine],
        "logRules": {
            "rules": [
                {"id": "resting-battery", "channel": "/RealOutputs/SystemStats/BatteryVoltage", "op": "lt", "value": 11.5,
                 "duration": 2, "severity": "warning", "title": "Battery sagging for 2 s",
                 "detail": "Battery stayed under 11.5 V for two seconds. Swap or charge before the next match."},
                {"id": "brownout", "channel": "/RealOutputs/SystemStats/BrownedOut", "op": "eq", "value": True, "duration": 0,
                 "severity": "error", "title": "Robot browned out",
                 "detail": "The roboRIO reported a brownout. Check what was drawing current in the seconds before."},
            ]
        },
        "source": {
            "repository": "Team3256/FRC_Offseason_2026",
            "branch": "claude/friendly-tesla-o02ue3",
            "converted": "Old time-optimal .mtraj paths converted to pose goals; markers mirror MayhemAutos.cpp.",
            "markerWarnings": warnings,
        },
    },
}
out.write_text(json.dumps(project, indent=2) + "\n")
print(f"{len(project['routines'])} routines, {len(machine['transitions'])} machine transitions")
for w in warnings:
    print("WARN", w)
