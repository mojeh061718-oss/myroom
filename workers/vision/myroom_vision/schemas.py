"""Validate pipeline artifacts against the schemas generated from packages/schema.

docs/03 §2: "Python workers validate against the generated JSON Schema files."
A stage that would emit an artifact the TypeScript side cannot parse fails here,
in the worker, rather than three stages later in the assembler.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "packages" / "schema" / "json"


class SchemaMissing(RuntimeError):
    """The generated schemas are absent — run `pnpm --filter @myroom/schema generate:jsonschema`."""


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft7Validator:
    path = SCHEMA_DIR / f"{name}.schema.json"
    if not path.exists():
        raise SchemaMissing(
            f"{path} not found. Regenerate with: "
            "pnpm --filter @myroom/schema generate:jsonschema"
        )
    return Draft7Validator(json.loads(path.read_text()))


def validate(name: str, payload: Any) -> Any:
    """Validate ``payload`` against the named schema and return it unchanged."""
    errors = sorted(_validator(name).iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        location = "/".join(str(p) for p in first.path) or "(root)"
        raise ValueError(f"{name} artifact invalid at {location}: {first.message}")
    return payload


def is_valid(name: str, payload: Any) -> bool:
    return _validator(name).is_valid(payload)
