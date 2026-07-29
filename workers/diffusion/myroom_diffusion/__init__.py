"""Generative restyle for the sandbox (docs/06 §6).

Separate from ``workers/vision`` on purpose: the reconstruction pipeline is
discriminative and ships with the app, while this tier is generative, optional,
and licence-gated. Nothing in docs/05 depends on anything here.
"""

from .registry import LicenseRejected, Tier, audit, bundled, lora, opt_in
from .pool import DiffusionUnavailable, available, describe, restyle, styles

__all__ = [
    "DiffusionUnavailable",
    "LicenseRejected",
    "Tier",
    "audit",
    "available",
    "bundled",
    "describe",
    "lora",
    "opt_in",
    "restyle",
    "styles",
]
