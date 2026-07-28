"""Reading a hosted model's reply (docs/05 §3).

No network and no AWS account: every test drives :func:`parse_reading` with a
reply string, because the reply is the only thing about this backend that can be
wrong in an interesting way. What is tested here is that a model behaving badly
degrades the room instead of corrupting it.
"""

from __future__ import annotations

import json

import pytest

from myroom_vision.bedrock import (
    CONFIDENCE_FLOOR,
    UnreadableReading,
    configured,
    parse_reading,
    prompt_text,
)
from myroom_vision.detect import category_for_prompt

SIZE = (1600, 1200)

GOOD = {
    "wall": {
        "bottom_left": [0.05, 0.80],
        "bottom_right": [0.95, 0.78],
        "top_right": [0.95, 0.12],
        "top_left": [0.05, 0.10],
    },
    "objects": [
        {"label": "couch", "confidence": 0.93, "box": [0.20, 0.45, 0.40, 0.30], "support": "floor"},
        {"label": "floor lamp", "confidence": 0.71, "box": [0.70, 0.30, 0.08, 0.45], "support": "floor"},
    ],
}


def test_a_clean_reply_becomes_pixels_and_category_ids():
    reading = parse_reading(json.dumps(GOOD), image_size=SIZE, wall_tag="north")

    assert [d.category for d in reading.detections] == ["sofa", "floor-lamp"]
    assert reading.notes == ()
    assert all(d.wall_tag == "north" for d in reading.detections)

    sofa = reading.detections[0]
    assert sofa.box == pytest.approx((0.20 * 1600, 0.45 * 1200, 0.40 * 1600, 0.30 * 1200))

    assert reading.wall_quad is not None
    assert len(reading.wall_quad) == 4
    assert reading.wall_quad[0] == pytest.approx((0.05 * 1600, 0.80 * 1200))


def test_json_wrapped_in_prose_and_fences_is_still_read():
    reply = f"Sure! Here's what I see:\n\n```json\n{json.dumps(GOOD)}\n```\n\nHope that helps."
    reading = parse_reading(reply, image_size=SIZE)
    assert len(reading.detections) == 2
    assert reading.wall_quad is not None


def test_a_reply_that_is_not_json_is_fatal():
    with pytest.raises(UnreadableReading):
        parse_reading("I'm sorry, I can't help with that.", image_size=SIZE)


def test_labels_outside_the_vocabulary_are_dropped_quietly():
    payload = {"wall": None, "objects": [
        {"label": "hopes and dreams", "confidence": 0.99, "box": [0.1, 0.1, 0.2, 0.2]},
        {"label": "bookshelf", "confidence": 0.8, "box": [0.1, 0.1, 0.2, 0.2]},
    ]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    assert [d.category for d in reading.detections] == ["bookshelf"]
    # A model naming something we don't stock is expected, not a defect.
    assert reading.notes == ()


def test_low_confidence_detections_are_dropped():
    payload = {"objects": [
        {"label": "sofa", "confidence": CONFIDENCE_FLOOR - 0.01, "box": [0.1, 0.1, 0.2, 0.2]},
        {"label": "sofa", "confidence": CONFIDENCE_FLOOR + 0.01, "box": [0.3, 0.1, 0.2, 0.2]},
    ]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)
    assert len(reading.detections) == 1


def test_a_broken_wall_costs_the_pose_but_keeps_the_objects():
    """One bad field must not throw away the rest of the photo."""
    payload = {"wall": {"bottom_left": [0.1, 0.9]}, "objects": GOOD["objects"]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    assert reading.wall_quad is None
    assert len(reading.detections) == 2
    assert any("wall corners" in note for note in reading.notes)


def test_a_null_wall_is_the_model_declining_not_a_defect():
    payload = {"wall": None, "objects": GOOD["objects"]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    assert reading.wall_quad is None
    assert reading.notes == ()


def test_boxes_running_off_the_frame_are_clamped_into_it():
    payload = {"objects": [{"label": "sofa", "confidence": 0.9, "box": [0.8, 0.7, 0.9, 0.9]}]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    x, y, w, h = reading.detections[0].box
    assert x + w == pytest.approx(1600)
    assert y + h == pytest.approx(1200)


def test_out_of_range_coordinates_are_clamped_not_trusted():
    payload = {"objects": [{"label": "sofa", "confidence": 2.0, "box": [-0.5, -0.5, 0.4, 0.4]}]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    detection = reading.detections[0]
    assert detection.confidence == 1.0
    assert detection.box[0] == 0.0
    assert detection.box[1] == 0.0


def test_malformed_objects_are_reported_rather_than_silently_lost():
    payload = {"objects": [
        {"label": "sofa", "confidence": 0.9, "box": [0.1, 0.1]},
        {"label": "sofa", "confidence": 0.9, "box": [0.1, 0.1, 0.0, 0.2]},
        "not an object",
    ]}
    reading = parse_reading(json.dumps(payload), image_size=SIZE)

    assert reading.detections == ()
    assert len(reading.notes) == 3


def test_a_missing_object_list_is_noted():
    reading = parse_reading(json.dumps({"wall": None}), image_size=SIZE)
    assert reading.detections == ()
    assert any("no object list" in note for note in reading.notes)


def test_the_prompt_only_offers_labels_the_app_can_place():
    text = prompt_text()
    assert "sofa" in text
    # Every label the prompt offers must map back to a real category.
    vocabulary = text.split("exactly as written:\n")[1].split("\n\n")[0]
    for label in vocabulary.split(", "):
        assert category_for_prompt(label) is not None, label


def test_configuration_says_what_is_missing(monkeypatch):
    monkeypatch.delenv("MYROOM_BEDROCK_MODEL_ID", raising=False)
    ready, reason = configured()
    assert not ready
    assert "MYROOM_BEDROCK_MODEL_ID" in reason


def test_synonyms_and_ids_both_resolve():
    assert category_for_prompt("couch") == "sofa"
    assert category_for_prompt("sofa") == "sofa"
    assert category_for_prompt("  SOFA  ") == "sofa"
    assert category_for_prompt("nonsense") is None
