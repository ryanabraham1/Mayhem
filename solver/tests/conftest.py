import math

import pytest

from mayhem_solver.models import Field_, Obstacle, Project, Trajectory, Waypoint


def wp(i, x, y, h=0.0, **kw):
    return Waypoint(id=str(i), x=x, y=y, heading=h, **kw)


@pytest.fixture
def project():
    return Project()


@pytest.fixture
def box_project():
    p = Project()
    p.field.obstacles = [Obstacle(id="box", name="Box", points=[(4, 2.5), (6, 2.5), (6, 4.5), (4, 4.5)])]
    return p
