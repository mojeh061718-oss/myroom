"""The licence gate is the point of this package, so it is what gets tested.

A gate that has never been shown to reject anything is not a gate (the same
principle scripts/license-policy.test.mjs applies to npm dependencies).
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pytest

from myroom_diffusion import registry
from myroom_diffusion.pool import depth_to_control_image

REPO = Path(__file__).resolve().parents[3]


# --- the gate rejects things -------------------------------------------------


def test_use_restricted_weights_cannot_be_bundled():
    """The core rule: OpenRAIL cannot ship in the app."""
    smuggled = registry.ModelWeights(
        key="sd15-bundled",
        repo="stable-diffusion-v1-5/stable-diffusion-v1-5",
        spdx="CreativeML-OpenRAIL-M",
        tier=registry.Tier.BUNDLED,
        purpose="attempting to bundle a use-restricted model",
    )
    with pytest.raises(registry.LicenseRejected) as error:
        registry.require(smuggled)
    assert "docs/08 §7" in str(error.value)
    assert "opt-in" in str(error.value)


def test_a_lora_with_no_commercial_permission_is_rejected():
    """Civitai's empty permission set is a refusal, not missing data."""
    non_commercial = registry.ModelWeights(
        key="nope",
        repo="https://civitai.com/api/download/models/1",
        spdx="CreativeML-OpenRAIL-M",
        tier=registry.Tier.OPT_IN,
        purpose="author permits no commercial use",
        source="civitai",
        commercial_use=frozenset(),
    )
    with pytest.raises(registry.LicenseRejected) as error:
        registry.require(non_commercial)
    assert "no commercial use" in str(error.value)


def test_a_civitai_lora_granting_rent_but_not_image_is_still_rejected():
    """`Image` is the permission this app actually needs — renting is not it."""
    rent_only = registry.ModelWeights(
        key="rent-only",
        repo="https://civitai.com/api/download/models/2",
        spdx="CreativeML-OpenRAIL-M",
        tier=registry.Tier.OPT_IN,
        purpose="rentable but images not permitted",
        source="civitai",
        commercial_use=frozenset({"RentCivit", "Rent"}),
    )
    with pytest.raises(registry.LicenseRejected):
        registry.require(rent_only)


# --- the gate accepts the right things ---------------------------------------


def test_every_registered_model_passes_its_own_gate():
    for model in registry.all_models():
        registry.require(model)


def test_every_pipeline_model_is_permissive_and_bundled():
    """Reconstruction must carry no licence caveat — that is why it can ship."""
    for model in registry.PIPELINE_MODELS.values():
        assert model.tier is registry.Tier.BUNDLED
        assert model.is_permissive, f"{model.key} is {model.spdx}"
        assert model.spdx in registry.PERMISSIVE_SPDX


def test_no_generative_weights_are_bundled():
    bundled_keys = {m.key for m in registry.bundled()}
    assert "sd15" not in bundled_keys
    assert "controlnet-depth" not in bundled_keys
    for key in registry.STYLE_LORAS:
        assert key not in bundled_keys


def test_every_style_lora_grants_commercial_image_use():
    for key, model in registry.STYLE_LORAS.items():
        assert model.source == "civitai"
        assert "Image" in model.commercial_use, key
        assert model.allows_commercial_images
        assert model.trigger_words, f"{key} has no trigger word, so its style will not fire"


def test_the_rejected_loras_stay_rejected():
    """Regression guard: these were excluded for cause, with the cause recorded."""
    assert registry.REJECTED_LORAS
    registered = {m.civitai_id for m in registry.STYLE_LORAS.values()}
    for civitai_id, reason in registry.REJECTED_LORAS.items():
        assert civitai_id not in registered
        assert "empty" in reason


# --- the two policies must not drift apart -----------------------------------


def test_the_permissive_set_matches_the_javascript_policy():
    """This module copies docs/08 §7 into Python; the copy must stay honest."""
    js = (REPO / "scripts" / "license-policy.mjs").read_text()
    allowed_block = re.search(r"export const ALLOWED = new Set\(\[(.*?)\]\)", js, re.S)
    assert allowed_block, "could not find ALLOWED in scripts/license-policy.mjs"
    js_licences = set(re.findall(r'"([^"]+)"', allowed_block.group(1)))
    # Every SPDX id we call permissive must also be permissive over there.
    missing = registry.PERMISSIVE_SPDX - js_licences
    assert not missing, f"Python allows licences the JS gate does not: {sorted(missing)}"


def test_no_use_restricted_licence_is_also_listed_as_permissive():
    assert not (registry.PERMISSIVE_SPDX & registry.USE_RESTRICTED_SPDX)


def test_the_audit_reports_every_model():
    rows = registry.audit()
    assert len(rows) == len(registry.all_models())
    assert all(row["verdict"] == "allowed" for row in rows)
    assert {row["tier"] for row in rows} == {"bundled", "opt-in"}


# --- the depth control image -------------------------------------------------


def test_near_geometry_is_bright_and_far_geometry_is_dark():
    """ControlNet-depth expects near-is-bright; getting this backwards would
    restyle the room inside out."""
    depth = np.zeros((4, 4), dtype=np.float32)
    depth[:2] = 1.0   # near
    depth[2:] = 5.0   # far
    control = depth_to_control_image(depth)
    assert control.shape == (4, 4, 3)
    assert control[0, 0, 0] == 255
    assert control[3, 3, 0] == 0
    # All three channels carry the same value — ControlNet-depth wants greyscale.
    assert (control[..., 0] == control[..., 1]).all()
    assert (control[..., 1] == control[..., 2]).all()


def test_a_flat_wall_is_mid_grey_rather_than_a_divide_by_zero():
    control = depth_to_control_image(np.full((3, 3), 2.5, dtype=np.float32))
    assert (control == 127).all() or (control == 128).all()


def test_non_finite_pixels_read_as_maximally_far():
    depth = np.array([[1.0, np.inf], [2.0, np.nan]], dtype=np.float32)
    control = depth_to_control_image(depth)
    assert control[0, 1, 0] == 0
    assert control[1, 1, 0] == 0
    assert control[0, 0, 0] == 255  # the nearest finite pixel


def test_an_entirely_empty_depth_buffer_is_an_error_not_a_guess():
    with pytest.raises(ValueError):
        depth_to_control_image(np.full((2, 2), np.nan))


# --- the opt-in barrier ------------------------------------------------------


def test_restyle_is_off_until_an_operator_turns_it_on(monkeypatch):
    from myroom_diffusion import pool

    monkeypatch.delenv(pool.ENABLE_ENV_VAR, raising=False)
    ok, why = pool.available()
    assert ok is False
    assert pool.ENABLE_ENV_VAR in why
    assert "CreativeML-OpenRAIL-M" in why


def test_the_style_menu_is_readable_without_any_weights_present():
    """The PWA asks for this list before anything is downloaded."""
    menu = registry.STYLE_LORAS
    assert len(menu) >= 3
    from myroom_diffusion.pool import styles

    listed = styles()
    assert len(listed) == len(menu)
    assert all(entry["allowed"] for entry in listed)
    assert all(entry["civitaiId"] for entry in listed)
