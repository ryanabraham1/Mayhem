"""Regenerate the bundled field presets (approximate geometry, fully editable in the app)."""
import json, math, pathlib
from mayhem_solver.models import Field_, Obstacle

OUT = pathlib.Path(__file__).parent / "src/mayhem_solver/fields"

def hexagon(cx, cy, apothem, rot=math.pi / 6):
    r = apothem / math.cos(math.pi / 6)
    return [(round(cx + r * math.cos(rot + i * math.pi / 3), 4), round(cy + r * math.sin(rot + i * math.pi / 3), 4)) for i in range(6)]

def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]

def flip(pts, L, W, sym):
    if sym == "rotational":
        return [(round(L - x, 4), round(W - y, 4)) for x, y in pts]
    return [(round(L - x, 4), y) for x, y in pts]

fields = []
fields.append(Field_(id="blank-2026", name="Blank field (16.54 x 8.07 m)", length=16.541, width=8.069, symmetry="rotational"))

# 2025 REEFSCAPE (approximate)
L, W = 17.548, 8.052
obs = [
    Obstacle(id="reef-blue", name="Blue Reef", points=hexagon(4.4893, 4.0259, 0.8319)),
    Obstacle(id="reef-red", name="Red Reef", points=hexagon(L - 4.4893, W - 4.0259, 0.8319)),
    Obstacle(id="barge", name="Barge", points=rect(8.474, 4.30, 9.074, 8.052)),
    Obstacle(id="barge-red", name="Barge (red side)", points=rect(8.474, 0.0, 9.074, 3.752), enabled=False),
    Obstacle(id="cs-blue-low", name="Blue Coral Station (right)", points=[(0, 0), (1.70, 0), (0, 1.25)]),
    Obstacle(id="cs-blue-high", name="Blue Coral Station (left)", points=[(0, W), (0, W - 1.25), (1.70, W)]),
]
obs.append(Obstacle(id="cs-red-low", name="Red Coral Station (left)", points=flip(obs[4].points, L, W, "rotational")))
obs.append(Obstacle(id="cs-red-high", name="Red Coral Station (right)", points=flip(obs[5].points, L, W, "rotational")))
fields.append(Field_(id="reefscape-2025", name="2025 REEFSCAPE", length=L, width=W, symmetry="rotational", obstacles=obs,
                     notes="Approximate geometry. Verify against the official field drawings before competition."))

# 2026 REBUILT (approximate)
L, W = 16.541, 8.069
hub_x, hub = 4.625, 1.194
cy = W / 2
obs = [
    Obstacle(id="hub-blue", name="Blue Hub", points=rect(hub_x - hub / 2, cy - hub / 2, hub_x + hub / 2, cy + hub / 2)),
    Obstacle(id="bump-blue-l", name="Blue Bump (left)", points=rect(hub_x - 0.56, cy + hub / 2, hub_x + 0.56, cy + hub / 2 + 1.85), enabled=False, margin=0.0),
    Obstacle(id="bump-blue-r", name="Blue Bump (right)", points=rect(hub_x - 0.56, cy - hub / 2 - 1.85, hub_x + 0.56, cy - hub / 2), enabled=False, margin=0.0),
    Obstacle(id="trench-blue-l", name="Blue Trench (left)", points=rect(hub_x - 0.60, W - 1.67, hub_x + 0.60, W), enabled=False),
    Obstacle(id="trench-blue-r", name="Blue Trench (right)", points=rect(hub_x - 0.60, 0, hub_x + 0.60, 1.67), enabled=False),
    Obstacle(id="tower-blue", name="Blue Tower", points=rect(0.0, 3.05, 1.14, 4.30)),
]
red = []
for o in obs:
    red.append(Obstacle(id=o.id.replace("blue", "red"), name=o.name.replace("Blue", "Red"),
                        points=flip(o.points, L, W, "rotational"), enabled=o.enabled, margin=o.margin))
fields.append(Field_(id="rebuilt-2026", name="2026 REBUILT", length=L, width=W, symmetry="rotational", obstacles=obs + red,
                     notes="Approximate geometry. Bumps and trenches are disabled by default (drivable for most robots). "
                           "Verify against the official field drawings before competition."))

OUT.mkdir(parents=True, exist_ok=True)
for f in fields:
    (OUT / f"{f.id}.json").write_text(json.dumps(f.dump(), indent=2))
    print("wrote", f.id, len(f.obstacles))
