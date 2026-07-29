"""Stages 2, 3 and 5 — the geometry and colour work (docs/05 §4–§7)."""

from __future__ import annotations

import numpy as np
import pytest

from myroom_vision import appearance, detect, device, measure, solve


# --- stage 2: camera & scale -------------------------------------------------


def test_intrinsics_follow_the_exif_focal_length():
    wide = solve.intrinsics_from_exif(4032, 3024, focal_35mm=13.0)
    normal = solve.intrinsics_from_exif(4032, 3024, focal_35mm=52.0)
    assert wide[0, 0] < normal[0, 0]
    # A 13 mm-equivalent lens sees about 100° across the frame.
    assert np.degrees(solve.horizontal_fov(wide, 4032)) == pytest.approx(108.0, abs=3.0)
    assert np.degrees(solve.horizontal_fov(normal, 4032)) == pytest.approx(38.0, abs=3.0)


def test_missing_exif_falls_back_to_a_typical_phone_lens():
    assumed = solve.intrinsics_from_exif(4032, 3024, focal_35mm=None)
    assert assumed[0, 0] == pytest.approx(solve.DEFAULT_FOCAL_35MM / 36.0 * 4032)


def test_depth_is_rescaled_so_the_known_wall_lands_where_the_plan_says():
    # A monocular depth map that is internally consistent but 2.5× off.
    truth = np.full((8, 8), 3.2)
    truth[2:5, 2:5] = 1.4  # something in front of the wall
    guess = truth / 2.5

    wall_mask = np.zeros((8, 8), dtype=bool)
    wall_mask[:, :] = True
    rescaled, factor = solve.rescale_depth(guess, wall_mask=wall_mask, expected_distance=3.2)
    assert factor == pytest.approx(2.5, rel=1e-6)
    assert rescaled[0, 0] == pytest.approx(3.2)
    # The object in front stays proportionally in front — the correction is a
    # single scale, not a per-pixel fudge.
    assert rescaled[3, 3] == pytest.approx(1.4)


def test_a_wall_nobody_can_see_is_an_error_not_a_guess():
    with pytest.raises(ValueError):
        solve.rescale_depth(np.ones((4, 4)), wall_mask=np.zeros((4, 4), dtype=bool), expected_distance=3.0)


def test_back_projection_round_trips_through_a_known_pose():
    intrinsics = solve.intrinsics_from_exif(640, 480, focal_35mm=26.0)
    pose = solve.Pose(position=np.array([1.0, 1.5, 2.0]), yaw=0.0, pitch=0.0)
    # The principal point at 4 m is straight ahead: 4 m along −z from the camera.
    pixels = np.array([[320.0, 240.0]])
    world = solve.back_project(pixels, np.array([4.0]), intrinsics, pose)
    np.testing.assert_allclose(world[0], [1.0, 1.5, -2.0], atol=1e-9)

    # Yawed 90°, the same ray points along +x.
    turned = solve.Pose(position=np.array([0.0, 0.0, 0.0]), yaw=np.pi / 2, pitch=0.0)
    world = solve.back_project(pixels, np.array([4.0]), intrinsics, turned)
    np.testing.assert_allclose(world[0], [-4.0, 0.0, 0.0], atol=1e-9)


# --- stage 3: measurement ----------------------------------------------------


def box_points(centre, size, yaw=0.0, n=4000, seed=1):
    rng = np.random.default_rng(seed)
    local = np.stack(
        [
            rng.uniform(-size[0] / 2, size[0] / 2, n),
            rng.uniform(0.0, size[1], n),
            rng.uniform(-size[2] / 2, size[2] / 2, n),
        ],
        axis=1,
    )
    c, s = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return local @ rotation.T + np.array([centre[0], 0.0, centre[2]])


def test_an_oriented_box_recovers_size_and_facing():
    points = box_points((1.0, 0.0, -2.0), (2.1, 0.84, 0.9), yaw=np.deg2rad(30))
    box = measure.oriented_box(points, floor_y=0.0)
    assert box is not None
    assert box.position[0] == pytest.approx(1.0, abs=0.05)
    assert box.position[2] == pytest.approx(-2.0, abs=0.05)
    assert box.size[1] == pytest.approx(0.84, abs=0.05)
    dims = sorted(box.size[i] for i in (0, 2))
    assert dims[0] == pytest.approx(0.9, abs=0.1)
    assert dims[1] == pytest.approx(2.1, abs=0.1)
    # Yaw is only defined up to a quarter turn for a box; check the footprint
    # aligns rather than the raw angle.
    assert (np.degrees(box.rotation_y) % 90) == pytest.approx(30.0, abs=6.0)


def test_a_few_bled_mask_pixels_dont_stretch_the_box():
    points = box_points((0.0, 0.0, 0.0), (1.0, 0.5, 0.6))
    # 1% of pixels landed on the far wall, 6 m away.
    strays = np.tile(np.array([0.0, 0.4, -6.0]), (40, 1))
    box = measure.oriented_box(np.vstack([points, strays]), floor_y=0.0)
    assert box is not None
    assert max(box.size[0], box.size[2]) < 1.4


def test_a_lidar_seed_box_wins_on_size():
    photo = measure.OrientedBox((1.0, 0.0, -1.0), 0.1, (2.0, 0.8, 0.9))
    seed = measure.OrientedBox((1.05, 0.0, -0.98), 0.0, (2.15, 0.83, 0.94))
    assert measure.seed_for(photo, [seed]) is seed
    merged = measure.merge_with_seed(photo, seed)
    assert merged.size == seed.size
    assert merged.rotation_y == seed.rotation_y

    # A seed on the far side of the room describes a different object.
    far = measure.OrientedBox((4.0, 0.0, 2.0), 0.0, (1.0, 1.0, 1.0))
    assert measure.seed_for(photo, [far]) is None


# --- stage 5: appearance -----------------------------------------------------


def test_lab_round_trips_through_srgb():
    colours = np.array([[0.1, 0.2, 0.4], [0.9, 0.9, 0.85], [0.55, 0.2, 0.2]])
    back = appearance.lab_to_srgb(appearance.srgb_to_lab(colours))
    np.testing.assert_allclose(back, colours, atol=1e-6)


def test_the_dominant_colour_is_the_one_that_covers_the_most():
    rng = np.random.default_rng(0)
    green = np.tile(np.array([0.30, 0.42, 0.29]), (900, 1)) + rng.normal(0, 0.01, (900, 3))
    cream = np.tile(np.array([0.93, 0.90, 0.83]), (100, 1)) + rng.normal(0, 0.01, (100, 3))
    palette = appearance.dominant_palette(np.vstack([green, cream]), colours=2)
    assert len(palette) == 2
    # Sofa green first, cushion cream second.
    first = np.array([int(palette[0][i : i + 2], 16) for i in (1, 3, 5)]) / 255
    assert first[1] > first[0] and first[1] > first[2]


def test_the_same_colour_under_different_light_gives_the_same_swatch():
    base = np.tile(np.array([0.45, 0.30, 0.22]), (500, 1))
    # Illumination scales *linear* radiance, so that is where the two exposures
    # are generated — dividing it out in sRGB would leave a hue shift behind.
    linear = appearance.srgb_to_linear(base)
    dim = appearance.linear_to_srgb(linear * 0.4)
    bright = appearance.linear_to_srgb(linear * 1.8)
    assert appearance.dominant_palette(dim, colours=1) == appearance.dominant_palette(bright, colours=1)


def test_a_mask_selects_only_the_object():
    image = np.zeros((10, 10, 3))
    image[:, :] = [0.9, 0.9, 0.9]
    image[4:7, 4:7] = [0.2, 0.3, 0.7]
    mask = np.zeros((10, 10), dtype=bool)
    mask[4:7, 4:7] = True
    palette = appearance.dominant_palette(image, mask=mask, colours=1)
    rgb = np.array([int(palette[0][i : i + 2], 16) for i in (1, 3, 5)]) / 255
    assert rgb[2] > rgb[0]


# --- stage 1: availability ---------------------------------------------------


def test_the_detection_vocabulary_comes_from_the_shared_taxonomy():
    vocabulary = detect.detection_vocabulary()
    assert len(vocabulary) > 120
    assert len(set(vocabulary)) == len(vocabulary)
    for expected in ("sofa", "coffee table", "ottoman", "air fryer", "coat rack"):
        assert expected in vocabulary


def test_a_worker_without_the_ml_runtime_says_so_instead_of_returning_nothing():
    ready, reason = detect.runtime_available()
    assert reason, "ready or not, the worker must be able to describe its own state"
    if ready:
        pytest.skip("this worker has the ML runtime installed")
    # The message has to be actionable: what's missing and how to install it.
    with pytest.raises(detect.ModelsUnavailable) as error:
        detect.detect_and_segment(["photo.jpg"])
    assert "stage 1" in str(error.value)


def test_the_absence_of_a_gpu_does_not_stop_stage_1():
    """The regression test for the CUDA gate this module used to have.

    Stage 1 refused to run without ``torch.cuda.is_available()``, which made an
    NVIDIA card a hard requirement for the app's headline feature. It is not
    one, and docs/03 §8 requires the opposite. On a machine with the runtime
    installed and no GPU, stage 1 must report itself ready.
    """
    try:
        import torch
    except ImportError:
        pytest.skip("no ML runtime on this worker; the gate cannot be exercised")

    ready, reason = detect.runtime_available()
    assert ready, f"stage 1 reported itself unavailable with the runtime present: {reason}"
    if not torch.cuda.is_available():
        assert device.select_device().kind != "cuda"
        assert "CUDA" not in reason, "a CPU worker must not be described as needing CUDA"


def test_the_compact_profile_is_chosen_when_there_is_no_accelerator():
    try:
        import torch  # noqa: F401
    except ImportError:
        pytest.skip("no ML runtime on this worker")
    chosen = detect.profile_for_device()
    assert chosen in ("full", "compact")
    assert chosen == ("full" if device.select_device().is_accelerated else "compact")
    detector, segmenter = detect.models_for(chosen)
    # Whatever profile we land on, both checkpoints stay on the docs/08 allowlist.
    assert detect.MODEL_LICENSES[detector] == "Apache-2.0"
    assert detect.MODEL_LICENSES[segmenter] == "Apache-2.0"


def test_every_device_backend_reports_without_raising():
    try:
        import torch  # noqa: F401
    except ImportError:
        pytest.skip("no ML runtime on this worker")
    described = device.describe()
    assert described["ready"] is True
    assert described["device"] in ("cuda", "mps", "xpu", "cpu")
    assert described["dtype"] in ("float16", "float32")
    # CPU is the floor: it must never be reported as accelerated.
    if described["device"] == "cpu":
        assert described["accelerated"] is False
        assert described["dtype"] == "float32"


def test_every_detection_prompt_resolves_to_a_taxonomy_id():
    """Regression: stage 1 emitted the raw prompt as the category, but stage 4
    and `getCategory` key on taxonomy ids. Only 69 of 368 prompts are spelled
    like their id, so four detections in five became unresolvable."""
    import json
    from pathlib import Path

    taxonomy = json.loads(detect.TAXONOMY_JSON.read_text())
    ids = {c["id"] for c in taxonomy}

    unresolved = []
    for prompt in detect.detection_vocabulary():
        resolved = detect.category_for_label(prompt)
        if resolved is None or resolved not in ids:
            unresolved.append((prompt, resolved))
    assert not unresolved, f"prompts with no taxonomy id: {unresolved[:10]}"


def test_synonyms_land_on_the_canonical_category():
    assert detect.category_for_label("couch") == "sofa"
    assert detect.category_for_label("sofa") == "sofa"
    # Case and trailing punctuation come off the detector's matched span.
    assert detect.category_for_label("  Couch. ") == "sofa"


def test_a_span_that_wraps_a_known_prompt_still_resolves():
    # Grounding DINO returns the matched span, which can carry a modifier.
    assert detect.category_for_label("leather couch") == "sofa"


def test_a_label_outside_the_vocabulary_resolves_to_nothing():
    assert detect.category_for_label("aardvark") is None
    assert detect.category_for_label("") is None


# --- stage 2: the affine depth solve ------------------------------------------


def _affine_room(width=64, near=2.0, far=6.0, a=3.1, b=0.27):
    """A room whose true depth ramps near→far, seen through an affine-invariant
    network: what we observe is `a / d + b`, with a and b unknown to the solver."""
    true = np.linspace(near, far, width)[None, :].repeat(width, 0)
    observed = a * (1.0 / true) + b
    return true, observed


def test_a_scale_only_solve_drifts_away_from_its_anchor():
    """Why fit_metric_depth exists, pinned as a fact rather than a comment."""
    true, observed = _affine_room()
    wall = np.zeros(true.shape, dtype=bool)
    wall[:, -3:] = True  # anchor on the far wall
    rescaled, _ = solve.rescale_depth(1.0 / observed, wall_mask=wall, expected_distance=true[0, -1])
    error = np.abs(rescaled - true)[0]
    # Small where it was measured...
    assert error[-1] < 0.10
    # ...and far outside the docs/05 §9 ±15 cm budget in the middle of the room.
    assert error[len(error) // 2] > 0.30


def test_the_affine_solve_recovers_true_metres_from_two_constraints():
    true, observed = _affine_room()
    # Single-column constraints, so each mask's median observed value
    # corresponds exactly to the distance being asserted.
    near_mask = np.zeros(true.shape, dtype=bool)
    near_mask[:, 0] = True
    far_mask = np.zeros(true.shape, dtype=bool)
    far_mask[:, -1] = True

    metric, (a, b) = solve.fit_metric_depth(
        observed,
        [(near_mask, float(true[0, 0])), (far_mask, float(true[0, -1]))],
    )
    np.testing.assert_allclose(metric, true, atol=1e-3)
    assert a > 0


def test_the_affine_solve_is_least_squares_over_every_constraint():
    """A floor plane contributes many samples; more constraints must not hurt."""
    true, observed = _affine_room()
    masks = []
    for column in (2, 20, 40, 61):
        m = np.zeros(true.shape, dtype=bool)
        m[:, column] = True
        masks.append((m, float(true[0, column])))
    metric, _ = solve.fit_metric_depth(observed, masks)
    np.testing.assert_allclose(metric, true, atol=1e-3)


def test_one_constraint_is_refused_rather_than_guessed():
    true, observed = _affine_room()
    only = np.zeros(true.shape, dtype=bool)
    only[:, -3:] = True
    with pytest.raises(ValueError) as error:
        solve.fit_metric_depth(observed, [(only, float(true[0, -1]))])
    # The message has to say what to add, not just that it failed.
    assert "two" in str(error.value) and "floor" in str(error.value)


def test_a_constraint_the_camera_cannot_see_is_skipped_not_fatal():
    true, observed = _affine_room()
    visible_near = np.zeros(true.shape, dtype=bool)
    visible_near[:, 0] = True
    visible_far = np.zeros(true.shape, dtype=bool)
    visible_far[:, -1] = True
    invisible = np.zeros(true.shape, dtype=bool)  # occluded wall: no pixels

    metric, _ = solve.fit_metric_depth(
        observed,
        [(visible_near, float(true[0, 0])), (invisible, 3.0), (visible_far, float(true[0, -1]))],
    )
    np.testing.assert_allclose(metric, true, atol=1e-3)
