"""Regenerate the bundled field presets.

2026 REBUILT geometry follows Choreo's 2026 field drawing (BSD-licensed, derived from the
official field drawings). The red side is the blue side rotated 180 degrees about the field
center, which is also the alliance-flip symmetry.
"""
import json, math, pathlib
from mayhem_solver.models import Decoration, Field_, Obstacle

OUT = pathlib.Path(__file__).parent / "src/mayhem_solver/fields"
L, W = 16.541, 8.0692
CX, CY = L / 2, W / 2

def rect(x0, y0, x1, y1):
    return [(round(x0, 4), round(y0, 4)), (round(x1, 4), round(y0, 4)), (round(x1, 4), round(y1, 4)), (round(x0, 4), round(y1, 4))]

def rot(pts):
    return [(round(L - x, 4), round(W - y, 4)) for x, y in pts]

def mirror_y(pts):
    return [(x, round(W - y, 4)) for x, y in pts]

# --- blue-side geometry (field meters) ---
HUB = rect(4.0284, 3.4377, 5.2229, 4.6315)
BUMP_L = rect(4.0618, 4.6286, 5.1878, 6.4849)
TRENCH_WALL_L = rect(4.0279, 6.4849, 5.2217, 6.7905)
TRENCH_L = rect(4.0279, 6.7905, 5.2217, W)
TOWER = rect(0.0, 3.2504, 1.1446, 4.2410)
DEPOT = rect(0.0, 5.4316, 0.6852, 6.4984)

blue = [
    Obstacle(id="hub-blue", name="Blue Hub", points=HUB),
    Obstacle(id="bump-blue-l", name="Blue Bump (left)", points=BUMP_L, enabled=False),
    Obstacle(id="bump-blue-r", name="Blue Bump (right)", points=mirror_y(BUMP_L), enabled=False),
    Obstacle(id="trenchwall-blue-l", name="Blue Trench Wall (left)", points=TRENCH_WALL_L),
    Obstacle(id="trenchwall-blue-r", name="Blue Trench Wall (right)", points=mirror_y(TRENCH_WALL_L)),
    Obstacle(id="trench-blue-l", name="Blue Trench (left, overhead)", points=TRENCH_L, enabled=False),
    Obstacle(id="trench-blue-r", name="Blue Trench (right, overhead)", points=mirror_y(TRENCH_L), enabled=False),
    Obstacle(id="tower-blue", name="Blue Tower", points=TOWER),
]
red = [Obstacle(id=o.id.replace("blue", "red"), name=o.name.replace("Blue", "Red"), points=rot(o.points),
                enabled=o.enabled, margin=o.margin) for o in blue]

def fuel_grid(x0, y0, nx, ny, pitch=0.1524):
    return [Decoration(kind="circle", center=(round(x0 + i * pitch + 0.076, 4), round(y0 + j * pitch + 0.076, 4)),
                       radius=0.075, style="fuel") for i in range(nx) for j in range(ny)]

deco_blue = [
    Decoration(kind="polygon", points=rect(0, 0, 4.0033, W), style="blueZone"),
    Decoration(kind="line", points=[(4.0033, 0), (4.0033, W)], style="blueTape", width=0.0508),
    Decoration(kind="polygon", points=DEPOT, style="blue"),
    Decoration(kind="polygon", points=rect(0, 0.2596, 0.08, 1.0724), style="blue"),  # outpost
    Decoration(kind="polygon", points=HUB, style="structure"),
    Decoration(kind="polygon", points=BUMP_L, style="blue"),
    Decoration(kind="polygon", points=mirror_y(BUMP_L), style="blue"),
    Decoration(kind="polygon", points=TRENCH_WALL_L, style="structure"),
    Decoration(kind="polygon", points=mirror_y(TRENCH_WALL_L), style="structure"),
    Decoration(kind="line", points=[(4.6249, 6.7905), (4.6249, W)], style="blue", width=0.1524),
    Decoration(kind="line", points=[(4.6249, 0), (4.6249, round(W - 6.7905, 4))], style="blue", width=0.1524),
    Decoration(kind="polygon", points=TOWER, style="structure"),
]
def flip_deco(d):
    style = {"blueZone": "redZone", "blueTape": "redTape", "blue": "red"}.get(d.style, d.style)
    if d.kind == "circle":
        return Decoration(kind="circle", center=(round(L - d.center[0], 4), round(W - d.center[1], 4)), radius=d.radius, style=style)
    return Decoration(kind=d.kind, points=rot(d.points), style=style, width=d.width)

decorations = (
    deco_blue + [flip_deco(d) for d in deco_blue]
    + [Decoration(kind="line", points=[(CX, 0), (CX, W)], style="tape", width=0.0508),
       Decoration(kind="line", points=[(0, CY), (L, CY)], style="tape", width=0.0254)]
    + fuel_grid(7.3561, 4.0600, 12, 15) + fuel_grid(7.3561, 4.0600 - 15 * 0.1524 - 0.05, 12, 15)
    + fuel_grid(0.0, 5.5078, 4, 6) + [flip_deco(d) for d in fuel_grid(0.0, 5.5078, 4, 6)]
)

fields = [
    Field_(id="rebuilt-2026", name="2026 REBUILT", length=L, width=W, symmetry="rotational",
           obstacles=blue + red, decorations=decorations,
           notes="Geometry from the 2026 field drawings (via Choreo's field image). Bumps and the overhead "
                 "trench openings are drivable for most robots, so they are disabled by default; enable the "
                 "trenches if your robot is taller than 22.25 in. Edit anything to match your venue."),
    Field_(id="blank-2026", name="Blank 2026 field", length=L, width=W, symmetry="rotational",
           decorations=[Decoration(kind="line", points=[(CX, 0), (CX, W)], style="tape", width=0.0508)]),
]
OUT.mkdir(parents=True, exist_ok=True)
for f in fields:
    (OUT / f"{f.id}.json").write_text(json.dumps(f.dump(), indent=1))
    print("wrote", f.id, len(f.obstacles), "obstacles", len(f.decorations), "decorations")
