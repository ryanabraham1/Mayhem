"""Small seeded benchmark subset used as a CI regression gate."""

import pytest

from benchmarks.run import _run_one
from benchmarks.scenarios import FAST_SUBSET, all_scenarios


SCENARIOS = {scenario.name: scenario for scenario in all_scenarios(2026, 60)}


@pytest.mark.slow
@pytest.mark.parametrize("name", FAST_SUBSET)
def test_fast_benchmark(name):
    scenario = SCENARIOS[name]
    payload = {
        "name": scenario.name,
        "group": scenario.group,
        "tags": scenario.tags,
        "project": scenario.project.dump(),
        "traj": scenario.traj.model_dump(by_alias=True, mode="json", exclude={"output"}),
        "expect_keywords": scenario.expect_keywords,
        "expect_waypoint": scenario.expect_waypoint,
    }
    result = _run_one(payload, parallel=True)
    assert result["valid"], result["violations"] or result["issues"]
