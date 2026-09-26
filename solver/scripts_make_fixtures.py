"""Generate solved .mtraj fixtures for MayhemLib's Java tests."""
import json, math, pathlib, sys
from importlib import resources
from mayhem_solver.models import *
from mayhem_solver.pipeline import solve

OUT = pathlib.Path(__file__).parent.parent / "lib/src/test/resources"

def main():
    fld = Field_.model_validate_json((resources.files("mayhem_solver") / "fields/rebuilt-2026.json").read_text())
    p = Project(field=fld)
    W = lambda i, x, y, h, **k: Waypoint(id=str(i), x=x, y=y, heading=h, **k)
    trajs = {
        # blue zone -> through the left trench opening -> neutral-zone pickup -> shoot facing the hub
        "HubCycle": Trajectory(name="HubCycle",
            waypoints=[W(0, 3.4, 5.6, 0.0, stop=True), W(1, 6.5, 7.4, 0.0), W(2, 7.9, 5.6, -math.pi / 2, stop=True, split=True),
                       W(3, 2.6, 4.03, 0.0, stop=True)],
            markers=[Marker(id="m1", name="raise", waypoint=1, offset=-0.2),
                     Marker(id="m2", name="score", waypoint=2, must_hit=True),
                     Marker(id="m3", name="intake", waypoint=2, offset=0.3, end_waypoint=3),
                     Marker(id="m4", name="skipme", waypoint=1, offset=0.1, recovery_policy="skip")]),
        "Straight": Trajectory(name="Straight", waypoints=[W(0, 7.0, 6.5, 0, stop=True), W(1, 10.8, 6.0, 0.5, stop=True)]),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for name, t in trajs.items():
        r = solve(p, t, parallel=False)
        assert r.success, (name, r.issues)
        t.output = r.output
        (OUT / f"{name}.mtraj").write_text(json.dumps(t.model_dump(by_alias=True, mode="json")))
        print(name, r.output.stats.total_time, len(r.output.samples))

if __name__ == "__main__":
    main()
