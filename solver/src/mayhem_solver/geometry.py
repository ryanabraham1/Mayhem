"""Obstacle geometry, configuration-space roadmap and collision checks."""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import networkx as nx
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from .models import Field_, Obstacle

CIRCLE_SIDES = 20


@dataclass
class Piece:
    """A convex obstacle piece used by the optimizer."""

    name: str
    verts: np.ndarray  # (V, 2) CCW
    margin: float
    poly: Polygon


@dataclass
class World:
    length: float
    width: float
    wall_margin: float
    pieces: list[Piece]
    obstacle_polys: list[tuple[str, Polygon, float]]  # original (possibly concave)
    _roadmaps: dict = field(default_factory=dict)

    def union(self, inflate: float = 0.0):
        geoms = [p.buffer(inflate + m, join_style="mitre", mitre_limit=2.0) for _, p, m in self.obstacle_polys]
        return unary_union(geoms) if geoms else Polygon()


def obstacle_polygon(o: Obstacle) -> Polygon | None:
    if o.kind == "circle":
        # circumscribed polygon so the approximation is conservative
        r = o.radius / math.cos(math.pi / CIRCLE_SIDES)
        pts = [
            (o.center[0] + r * math.cos(2 * math.pi * i / CIRCLE_SIDES),
             o.center[1] + r * math.sin(2 * math.pi * i / CIRCLE_SIDES))
            for i in range(CIRCLE_SIDES)
        ]
        return Polygon(pts)
    if len(o.points) < 3:
        return None
    poly = Polygon(o.points)
    if not poly.is_valid:
        poly = shapely.make_valid(poly)
        if poly.geom_type != "Polygon":
            polys = [g for g in getattr(poly, "geoms", []) if g.geom_type == "Polygon"]
            if not polys:
                return None
            poly = max(polys, key=lambda g: g.area)
    if poly.area < 1e-6:
        return None
    return shapely.geometry.polygon.orient(poly, 1.0)


def _is_convex(poly: Polygon, tol: float = 1e-7) -> bool:
    return poly.convex_hull.area - poly.area <= tol * max(1.0, poly.area)


def convex_decompose(poly: Polygon) -> list[Polygon]:
    """Hertel-Mehlhorn style decomposition: triangulate, then greedily merge."""
    poly = shapely.geometry.polygon.orient(poly.simplify(1e-6), 1.0)
    if _is_convex(poly):
        return [poly]
    tris = [t for t in shapely.constrained_delaunay_triangles(poly).geoms if t.area > 1e-9]
    pieces = list(tris)
    merged = True
    while merged:
        merged = False
        for i, j in itertools.combinations(range(len(pieces)), 2):
            a, b = pieces[i], pieces[j]
            inter = a.intersection(b)
            if inter.length < 1e-6:
                continue
            u = unary_union([a, b])
            if u.geom_type == "Polygon" and _is_convex(u):
                pieces[i] = u.simplify(1e-7)
                pieces.pop(j)
                merged = True
                break
    return [shapely.geometry.polygon.orient(p, 1.0) for p in pieces]


def build_world(fld: Field_, extra: list[tuple[str, list[tuple[float, float]], float]] = ()) -> World:
    polys: list[tuple[str, Polygon, float]] = []
    for o in fld.obstacles:
        if not o.enabled:
            continue
        p = obstacle_polygon(o)
        if p is not None:
            polys.append((o.name, p, o.margin))
    for name, pts, margin in extra:
        if len(pts) >= 3:
            p = obstacle_polygon(Obstacle(id=name, name=name, points=pts))
            if p is not None:
                polys.append((name, p, margin))
    pieces = []
    for name, p, m in polys:
        for q in convex_decompose(p):
            verts = np.asarray(q.exterior.coords)[:-1]
            pieces.append(Piece(name=name, verts=verts, margin=m, poly=q))
    return World(fld.length, fld.width, fld.wall_margin, pieces, polys)


# ---------------------------------------------------------------------------
# Robot footprint
# ---------------------------------------------------------------------------


def bumper_polygon(corners, x: float, y: float, theta: float) -> Polygon:
    c, s = math.cos(theta), math.sin(theta)
    return Polygon([(x + c * px - s * py, y + s * px + c * py) for px, py in corners])


def bumper_polygons(corners, xs, ys, thetas) -> np.ndarray:
    xs, ys, thetas = map(np.asarray, (xs, ys, thetas))
    c, s = np.cos(thetas), np.sin(thetas)
    cr = np.asarray(corners)
    px = xs[:, None] + c[:, None] * cr[None, :, 0] - s[:, None] * cr[None, :, 1]
    py = ys[:, None] + s[:, None] * cr[None, :, 0] + c[:, None] * cr[None, :, 1]
    rings = np.stack([px, py], axis=-1)
    return shapely.polygons(rings)


def robot_polygons(corners, xs, ys, thetas, intake=(), mask=None) -> np.ndarray:
    """Bumper footprints, unioned with the intake rectangle where `mask` is set."""
    polys = bumper_polygons(corners, xs, ys, thetas)
    if intake and mask is not None and np.any(mask):
        m = np.asarray(mask, dtype=bool)
        ext = bumper_polygons(intake, np.asarray(xs)[m], np.asarray(ys)[m], np.asarray(thetas)[m])
        polys = polys.copy()
        polys[m] = shapely.union(polys[m], ext)
    return polys


# ---------------------------------------------------------------------------
# Roadmap (visibility graph in an inflated configuration space)
# ---------------------------------------------------------------------------


@dataclass
class Roadmap:
    radius: float
    free: object  # shapely geometry of free space for the robot center
    free_prepared: object
    graph: nx.Graph
    nodes: list[tuple[float, float]]
    obstacle_refs: list[tuple[float, float]]  # one interior point per obstacle component


def build_roadmap(world: World, radius: float) -> Roadmap:
    key = round(radius, 4)
    if key in world._roadmaps:
        return world._roadmaps[key]
    eps = 0.03
    field_rect = box(0, 0, world.length, world.width)
    blocked = world.union(radius)
    free = field_rect.buffer(-(radius + world.wall_margin), join_style="mitre").difference(blocked)
    free_prep = shapely.prepared.prep(free.buffer(1e-6))

    # Candidate nodes: vertices of a slightly larger inflation, kept if in free space.
    blocked_big = world.union(radius + eps)
    node_src = field_rect.buffer(-(radius + world.wall_margin + eps), join_style="mitre").difference(blocked_big)
    nodes: list[tuple[float, float]] = []
    geoms = getattr(node_src, "geoms", [node_src])
    for g in geoms:
        if g.is_empty or g.geom_type != "Polygon":
            continue
        for ring in [g.exterior, *g.interiors]:
            for pt in list(ring.coords)[:-1]:
                if free_prep.contains(Point(pt)):
                    nodes.append((float(pt[0]), float(pt[1])))

    graph = nx.Graph()
    for i, p in enumerate(nodes):
        graph.add_node(i, pos=p)
    if nodes:
        segs = []
        pairs = []
        for i, j in itertools.combinations(range(len(nodes)), 2):
            pairs.append((i, j))
            segs.append(LineString([nodes[i], nodes[j]]))
        if segs:
            ok = shapely.covers(free.buffer(1e-6), np.array(segs, dtype=object))
            for (i, j), good in zip(pairs, ok):
                if good:
                    graph.add_edge(i, j, weight=math.dist(nodes[i], nodes[j]))

    comps = getattr(blocked, "geoms", [blocked]) if not blocked.is_empty else []
    refs = [(p.representative_point().x, p.representative_point().y) for p in comps if not p.is_empty]
    rm = Roadmap(radius, free, free_prep, graph, nodes, refs)
    world._roadmaps[key] = rm
    return rm


def _segment_free(rm: Roadmap, a, b) -> bool:
    if math.dist(a, b) < 1e-9:
        return True
    return rm.free_prepared.covers(LineString([a, b]))


def _entry_point(rm: Roadmap, p) -> tuple[float, float]:
    """Nearest point in free space (for waypoints that sit inside inflated obstacles)."""
    pt = Point(p)
    if rm.free_prepared.contains(pt) or rm.free.is_empty:
        return (float(p[0]), float(p[1]))
    q = shapely.ops.nearest_points(rm.free, pt)[0]
    # nudge slightly inward
    cx, cy = q.x, q.y
    for _ in range(5):
        if rm.free_prepared.contains(Point(cx, cy)):
            break
        cx, cy = cx + (cx - p[0]) * 0.1 + 1e-3, cy + (cy - p[1]) * 0.1
    return (float(cx), float(cy))


def homotopy_signature(path: list[tuple[float, float]], refs) -> tuple:
    """Ray-crossing word: obstacle i's ray goes straight up from its ref point."""
    word: list[tuple[int, int]] = []
    for a, b in zip(path[:-1], path[1:]):
        for i, (rx, ry) in enumerate(refs):
            # does segment a-b cross vertical ray x=rx, y>=ry?
            # half-open interval so a crossing at a shared vertex counts once
            if not (min(a[0], b[0]) < rx <= max(a[0], b[0])):
                continue
            t = (rx - a[0]) / (b[0] - a[0])
            if not (0 <= t <= 1):
                continue
            y = a[1] + t * (b[1] - a[1])
            if y < ry:
                continue
            d = 1 if b[0] > a[0] else -1
            if word and word[-1] == (i, -d):
                word.pop()
            else:
                word.append((i, d))
    return tuple(word)


def route_candidates(
    rm: Roadmap, a, b, k: int, max_ratio: float = 2.5, max_paths: int = 60
) -> list[list[tuple[float, float]]]:
    """Up to k homotopically distinct collision-free polylines from a to b."""
    a_in, b_in = _entry_point(rm, a), _entry_point(rm, b)
    head = [tuple(a)] if a_in != tuple(a) else []
    tail = [tuple(b)] if b_in != tuple(b) else []

    if _segment_free(rm, a_in, b_in):
        direct = head + [a_in, b_in] + tail
        if k == 1 or not rm.nodes:
            return [direct]
    else:
        direct = None

    g = rm.graph.copy()
    s, t = "s", "t"
    g.add_node(s)
    g.add_node(t)
    for i, p in enumerate(rm.nodes):
        if _segment_free(rm, a_in, p):
            g.add_edge(s, i, weight=math.dist(a_in, p))
        if _segment_free(rm, b_in, p):
            g.add_edge(t, i, weight=math.dist(b_in, p))
    if direct is not None:
        g.add_edge(s, t, weight=math.dist(a_in, b_in))

    def pos(n):
        return a_in if n == s else b_in if n == t else rm.nodes[n]

    out: list[list[tuple[float, float]]] = []
    sigs = set()
    best = None
    try:
        gen = nx.shortest_simple_paths(g, s, t, weight="weight")
        for count, nodes in enumerate(gen):
            if count >= max_paths or len(out) >= k:
                break
            pts = [pos(n) for n in nodes]
            length = sum(math.dist(p, q) for p, q in zip(pts[:-1], pts[1:]))
            if best is None:
                best = length
            elif length > best * max_ratio + 1.0:
                break
            sig = homotopy_signature(pts, rm.obstacle_refs)
            if sig in sigs:
                continue
            sigs.add(sig)
            out.append(head + pts + tail)
    except nx.NetworkXNoPath:
        pass
    if not out and direct is not None:
        out = [direct]
    return out


# ---------------------------------------------------------------------------
# Collision checks
# ---------------------------------------------------------------------------


@dataclass
class Collision:
    index: int  # interval index (sample k -> k+1)
    t: float
    x: float
    y: float
    name: str
    depth: float


def check_path(world: World, corners, t, x, y, th, tol_frac: float = 0.5,
               intake=(), intake_mask=None) -> list[Collision]:
    """Check a dense list of poses. Collisions = bumper (plus the intake where `intake_mask` is
    set) closer than margin*tol_frac."""
    polys = robot_polygons(corners, x, y, th, intake, intake_mask)
    hits: list[Collision] = []
    for piece in world.pieces:
        d = shapely.distance(polys, piece.poly)
        inter = shapely.intersects(polys, piece.poly)
        bad = np.where(inter | (d < piece.margin * tol_frac - 1e-4))[0]
        for i in bad:
            hits.append(Collision(int(i), float(t[i]), float(x[i]), float(y[i]), piece.name,
                                  float(piece.margin - d[i]) if not inter[i] else float(piece.margin)))
    # walls
    bounds = shapely.bounds(polys)
    wm = world.wall_margin * tol_frac - 1e-4
    bad = np.where((bounds[:, 0] < wm) | (bounds[:, 1] < wm) |
                   (bounds[:, 2] > world.length - wm) | (bounds[:, 3] > world.width - wm))[0]
    for i in bad:
        hits.append(Collision(int(i), float(t[i]), float(x[i]), float(y[i]), "Field wall", 0.0))
    return hits
