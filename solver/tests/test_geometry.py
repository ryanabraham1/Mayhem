from shapely.geometry import Polygon

from mayhem_solver import geometry as geo
from mayhem_solver.models import Field_, Obstacle


def test_convex_decomposition_of_l_shape():
    L = Polygon([(0, 0), (2, 0), (2, 1), (1, 1), (1, 2), (0, 2)])
    parts = geo.convex_decompose(L)
    assert len(parts) >= 2
    assert all(geo._is_convex(p) for p in parts)
    assert abs(sum(p.area for p in parts) - L.area) < 1e-6


def test_routes_go_around_both_sides():
    f = Field_(obstacles=[Obstacle(id="b", name="B", points=[(4, 2.5), (6, 2.5), (6, 4.5), (4, 4.5)])])
    world = geo.build_world(f)
    rm = geo.build_roadmap(world, 0.66)
    routes = geo.route_candidates(rm, (2, 3.5), (8, 3.5), 3)
    assert len(routes) >= 2
    ys = sorted(max(p[1] for p in r) for r in routes)
    assert min(min(p[1] for p in r) for r in routes) < 2.5 and ys[-1] > 4.5


def test_circle_obstacle_is_conservative():
    o = Obstacle(id="c", name="C", kind="circle", center=(1, 1), radius=0.5)
    poly = geo.obstacle_polygon(o)
    assert poly.contains(Polygon([(1 + 0.49, 1), (1, 1.49), (1 - 0.49, 1), (1, 1 - 0.49)]))
