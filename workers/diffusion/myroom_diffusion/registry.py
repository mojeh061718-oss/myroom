"""Which generative weights this app is allowed to use, and on what terms.

Model weights are a different legal object from npm packages, and the existing
gate in ``scripts/check-licenses.mjs`` does not cover them: it walks the
dependency tree, and weights are not dependencies. This module is the gate for
the other half.

The rule it enforces comes from a conflict worth stating plainly. docs/08 §7
allows MIT / Apache-2.0 / BSD / ISC / CC0 and nothing else. Stable Diffusion 1.5
is CreativeML OpenRAIL-M, which is **not** on that list — it is a
use-restricted licence, not a permissive one. So SD 1.5 cannot be vendored into
this repository or bundled into the PWA without breaking the project's own
policy.

It can still be *offered*, and that distinction is the whole design:

``BUNDLED``
    Ships with the app. Must be on the docs/08 §7 permissive allowlist. Every
    model the reconstruction pipeline itself depends on is in this tier, which
    is why reconstruction has no licence caveat at all.

``OPT_IN``
    Never vendored, never shipped. Fetched from its origin at runtime, only
    after the operator has enabled it and the licence has been surfaced. The
    restyle feature lives here, and it degrades to "unavailable" rather than
    silently pulling weights the policy would reject.

LoRAs carry a second condition. Civitai encodes per-model permissions in an
``allowCommercialUse`` set, and an empty set means the author permits no
commercial use at all. Since this app renders images for its users, a LoRA is
only admissible if that set grants ``Image``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

#: docs/08 §7, mirrored from scripts/license-policy.mjs. Kept as a literal copy
#: rather than an import because that file is ESM and this one is Python; the
#: two are pinned together by test_registry.py, which reads the JS and compares.
PERMISSIVE_SPDX = frozenset(
    {
        "MIT",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "CC0-1.0",
        "Unlicense",
        "0BSD",
    }
)

#: Licences we know are use-restricted. Allowed only in the OPT_IN tier.
USE_RESTRICTED_SPDX = frozenset(
    {
        "CreativeML-OpenRAIL-M",
        "CreativeML-OpenRAIL++-M",
        "OpenRAIL-M",
    }
)


class Tier(str, Enum):
    BUNDLED = "bundled"
    OPT_IN = "opt-in"


class LicenseRejected(RuntimeError):
    """A model was requested that this project's licence policy does not allow."""


@dataclass(frozen=True)
class ModelWeights:
    """One set of weights, with the provenance a licence audit needs."""

    key: str
    repo: str
    spdx: str
    tier: Tier
    purpose: str
    source: str = "huggingface"
    #: Civitai's permission set. Empty for non-Civitai models, where the SPDX
    #: identifier alone carries the terms.
    commercial_use: frozenset[str] = field(default_factory=frozenset)
    #: Civitai model id, for anything fetched from there.
    civitai_id: int | None = None
    trigger_words: tuple[str, ...] = ()
    approx_mb: int = 0

    @property
    def is_permissive(self) -> bool:
        return self.spdx in PERMISSIVE_SPDX

    @property
    def allows_commercial_images(self) -> bool:
        """Whether users may use what this model generates.

        SPDX-permissive weights permit it by the licence itself. Civitai models
        are governed by the author's own permission set on top of the base
        licence, so an empty set is a refusal, not an absence of information.
        """
        if self.is_permissive:
            return True
        if self.source == "civitai":
            return "Image" in self.commercial_use
        # OpenRAIL permits commercial use subject to its behavioural clauses.
        return self.spdx in USE_RESTRICTED_SPDX


def _check(model: ModelWeights) -> None:
    """The gate itself. Raises rather than returning a boolean, so that a
    caller who forgets to check the result still cannot load rejected weights."""
    if model.tier is Tier.BUNDLED and not model.is_permissive:
        raise LicenseRejected(
            f"{model.key}: {model.spdx} is not on the docs/08 §7 permissive allowlist, "
            f"so it cannot ship in the {Tier.BUNDLED.value} tier. Move it to "
            f"{Tier.OPT_IN.value} if it should be fetched at runtime instead."
        )
    if not model.allows_commercial_images:
        raise LicenseRejected(
            f"{model.key}: the author permits no commercial use of generated images "
            f"(allowCommercialUse={sorted(model.commercial_use) or 'empty'}), and this "
            f"app renders images for its users."
        )
    if model.tier is Tier.OPT_IN and model.is_permissive:
        # Not an error, but a smell: permissive weights belong in BUNDLED where
        # they need no runtime consent step.
        pass


# --- the registry ------------------------------------------------------------

#: Stage models for the reconstruction pipeline. All permissive, all bundled —
#: this is why reconstruction carries no licence caveat.
PIPELINE_MODELS: dict[str, ModelWeights] = {
    m.key: m
    for m in [
        ModelWeights(
            key="depth",
            repo="depth-anything/Depth-Anything-V2-Small-hf",
            spdx="Apache-2.0",
            tier=Tier.BUNDLED,
            purpose="Stage 2 metric depth (docs/05 §4)",
            approx_mb=99,
        ),
        ModelWeights(
            key="depth-onnx",
            repo="onnx-community/depth-anything-v2-small",
            spdx="Apache-2.0",
            tier=Tier.BUNDLED,
            purpose="Stage 2 metric depth, in-browser tier (WebGPU)",
            approx_mb=50,
        ),
        ModelWeights(
            key="detector",
            repo="IDEA-Research/grounding-dino-tiny",
            spdx="Apache-2.0",
            tier=Tier.BUNDLED,
            purpose="Stage 1 open-vocabulary detection (docs/05 §3)",
            approx_mb=230,
        ),
        ModelWeights(
            key="segmenter",
            repo="Zigeng/SlimSAM-uniform-77",
            spdx="Apache-2.0",
            tier=Tier.BUNDLED,
            purpose="Stage 1 mask refinement (docs/05 §3)",
            approx_mb=110,
        ),
        ModelWeights(
            key="clip",
            repo="Xenova/clip-vit-base-patch32",
            spdx="MIT",
            tier=Tier.BUNDLED,
            purpose="Stage 4 shape similarity for catalog ranking (docs/05 §6)",
            approx_mb=150,
        ),
    ]
}

#: The generative tier. Opt-in, never vendored.
BASE_DIFFUSION = ModelWeights(
    key="sd15",
    repo="stable-diffusion-v1-5/stable-diffusion-v1-5",
    spdx="CreativeML-OpenRAIL-M",
    tier=Tier.OPT_IN,
    purpose="Restyle renders over the sandbox view (docs/06 §6)",
    approx_mb=1980,
)

#: Depth-conditioned ControlNet, so a restyle keeps the room's real geometry
#: instead of inventing a different room.
CONTROLNET_DEPTH = ModelWeights(
    key="controlnet-depth",
    repo="lllyasviel/control_v11f1p_sd15_depth",
    spdx="CreativeML-OpenRAIL-M",
    tier=Tier.OPT_IN,
    purpose="Constrain restyle to the room's measured geometry",
    approx_mb=1445,
)

#: Interior-design LoRAs, verified against Civitai's API on 2026-07-29. Only
#: models whose author granted `Image` are listed; three otherwise-suitable
#: interior LoRAs were excluded for having an empty permission set.
STYLE_LORAS: dict[str, ModelWeights] = {
    m.key: m
    for m in [
        ModelWeights(
            key="japanese-wood",
            repo="https://civitai.com/api/download/models/94857",
            spdx="CreativeML-OpenRAIL-M",
            tier=Tier.OPT_IN,
            purpose="Japanese modern wood interior",
            source="civitai",
            commercial_use=frozenset({"Image", "RentCivit", "Rent", "Sell"}),
            civitai_id=89136,
            trigger_words=("Interior",),
            approx_mb=72,
        ),
        ModelWeights(
            key="hand-painted",
            repo="https://civitai.com/api/download/models/156888",
            spdx="CreativeML-OpenRAIL-M",
            tier=Tier.OPT_IN,
            purpose="Hand-painted interior illustration",
            source="civitai",
            commercial_use=frozenset({"Image", "RentCivit", "Rent", "Sell"}),
            civitai_id=141526,
            trigger_words=("shouhui",),
            approx_mb=144,
        ),
        ModelWeights(
            key="cream",
            repo="https://civitai.com/api/download/models/597018",
            spdx="CreativeML-OpenRAIL-M",
            tier=Tier.OPT_IN,
            purpose="Cream-toned contemporary interior",
            source="civitai",
            commercial_use=frozenset({"Image", "RentCivit", "Rent", "Sell"}),
            civitai_id=537047,
            trigger_words=("Interior Design",),
            approx_mb=72,
        ),
    ]
}

#: Civitai models rejected by the gate, kept so the exclusion is auditable and
#: nobody re-adds them without reading why.
REJECTED_LORAS = {
    37483: "Interior Design 室内装潢设计 — allowCommercialUse is empty",
    75926: "Interior-desigh-v2 — allowCommercialUse is empty",
    240099: "Justin_Interior_plan_V150 — allowCommercialUse is empty",
}


def all_models() -> list[ModelWeights]:
    return [*PIPELINE_MODELS.values(), BASE_DIFFUSION, CONTROLNET_DEPTH, *STYLE_LORAS.values()]


def require(model: ModelWeights) -> ModelWeights:
    """Gate one model, returning it so this reads as a wrapper at the call site."""
    _check(model)
    return model


def bundled() -> list[ModelWeights]:
    return [m for m in all_models() if m.tier is Tier.BUNDLED]


def opt_in() -> list[ModelWeights]:
    return [m for m in all_models() if m.tier is Tier.OPT_IN]


def lora(key: str) -> ModelWeights:
    if key not in STYLE_LORAS:
        raise KeyError(f"unknown style {key!r}; known: {sorted(STYLE_LORAS)}")
    return require(STYLE_LORAS[key])


def audit() -> list[dict[str, object]]:
    """Every model with its terms — for the privacy screen and the CI gate."""
    rows: list[dict[str, object]] = []
    for model in all_models():
        try:
            _check(model)
            verdict = "allowed"
        except LicenseRejected as error:
            verdict = f"REJECTED: {error}"
        rows.append(
            {
                "key": model.key,
                "repo": model.repo,
                "spdx": model.spdx,
                "tier": model.tier.value,
                "source": model.source,
                "purpose": model.purpose,
                "commercialImages": model.allows_commercial_images,
                "approxMB": model.approx_mb,
                "verdict": verdict,
            }
        )
    return rows
