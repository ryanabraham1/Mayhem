"""Export JSON Schema for the file formats (used to generate TypeScript types)."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic.json_schema import models_json_schema

from .models import Field_, Issue, Project, Trajectory


def export(out_dir: str | Path) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _, schema = models_json_schema(
        [(m, "serialization") for m in (Project, Trajectory, Field_, Issue)],
        by_alias=True,
        title="Mayhem",
    )
    path = out / "mayhem.schema.json"
    path.write_text(json.dumps(schema, indent=2), encoding="utf-8")
    return path
