"""Stage 1 through a hosted multimodal model on Amazon Bedrock (docs/05 §3).

The blueprint's stage 1 is Grounding DINO plus SAM 2 on a GPU. This is the
alternative for deployments that have a Bedrock account but no GPU: one call per
photo to a vision-capable model, which returns the same thing the detector
returns — labelled boxes — plus the four corners of the wall the photo was tagged
to, which :mod:`myroom_vision.place` needs to recover the camera pose.

What this does **not** replace:

* **Segmentation.** There are no pixel masks here, only boxes. Stage 3 measures
  from box edges instead of mask edges, which is coarser and is why rooms built
  this way stay in the "photo" accuracy tier.
* **Metric depth.** Nothing here returns a depth map. Placement comes from the
  room's own geometry — see :mod:`myroom_vision.place`.

Configuration is environment-only, so no account detail is ever committed:

    MYROOM_BEDROCK_MODEL_ID   e.g. the Bedrock model or inference-profile id
    MYROOM_BEDROCK_REGION     the AWS region the model is enabled in
    MYROOM_BEDROCK_MAX_TOKENS optional, defaults to 4096

The network call is deliberately three lines at the bottom of this module.
Everything that can be wrong — the prompt, the JSON, the coordinate frame, the
label vocabulary — is in pure functions above it, where the tests can reach it
without an AWS account.
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache

from .detect import Detection, category_for_prompt, detection_vocabulary

MODEL_ID_ENV = "MYROOM_BEDROCK_MODEL_ID"
REGION_ENV = "MYROOM_BEDROCK_REGION"
MAX_TOKENS_ENV = "MYROOM_BEDROCK_MAX_TOKENS"

DEFAULT_MAX_TOKENS = 4096

#: Detections below this are noise; the same bar stage 1's GPU path uses.
CONFIDENCE_FLOOR = 0.35

#: Corner names in the order :func:`myroom_vision.place.pose_from_wall_quad` wants.
WALL_CORNERS = ("bottom_left", "bottom_right", "top_right", "top_left")

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.DOTALL)


class BedrockUnavailable(RuntimeError):
    """Bedrock is not configured, or the SDK is not installed."""


class UnreadableReading(ValueError):
    """The model replied with something that is not a usable reading."""


@dataclass(frozen=True)
class ImageReading:
    """Everything one photo contributes to the pipeline."""

    detections: tuple[Detection, ...]
    #: Wall corners in pixels, in :data:`WALL_CORNERS` order, or None if the
    #: model could not see the whole wall — that photo cannot be localized.
    wall_quad: tuple[tuple[float, float], ...] | None
    #: Anything the model flagged that a human might want to know.
    notes: tuple[str, ...] = ()


def configured() -> tuple[bool, str]:
    """Whether this worker can call Bedrock, and why not when it can't."""
    if not os.environ.get(MODEL_ID_ENV):
        return False, f"{MODEL_ID_ENV} is not set"
    if not os.environ.get(REGION_ENV):
        return False, f"{REGION_ENV} is not set"
    try:
        import boto3  # noqa: F401, PLC0415
    except ImportError:
        return False, "boto3 is not installed; install the `bedrock` extra"
    return True, ""


@lru_cache(maxsize=1)
def prompt_text() -> str:
    """The instruction sent with every photo.

    The vocabulary is the same list stage 1's GPU path prompts Grounding DINO
    with, so both backends can only name classes the app can actually place.
    """
    vocabulary = ", ".join(detection_vocabulary())
    return (
        "You are a measurement instrument for an interior reconstruction pipeline, "
        "not an assistant. Reply with one JSON object and nothing else.\n\n"
        "The photo shows one wall of a room, taken from inside that room.\n\n"
        "Report two things.\n\n"
        '1. "wall": the four corners of that wall as it appears in this photo — '
        "where the wall meets the floor on the left and right, and where it meets "
        "the ceiling on the left and right. Use the wall that fills most of the "
        "frame. If any of the four corners is outside the frame or hidden behind "
        "furniture so that you would be guessing, set \"wall\" to null.\n\n"
        '2. "objects": every piece of furniture, fixture or fitting you can see, '
        "with a tight box around it. Use only these labels, exactly as written:\n"
        f"{vocabulary}\n\n"
        "If something does not fit one of those labels, leave it out.\n\n"
        "All coordinates are fractions of the image, x from 0 at the left edge to "
        "1 at the right, y from 0 at the top edge to 1 at the bottom. Boxes are "
        "[x, y, width, height]. Confidence is 0 to 1.\n\n"
        '"support" is "floor" for anything standing on the floor, "wall" for '
        'anything mounted on a wall, "ceiling" for anything hanging from above.\n\n'
        "Shape:\n"
        '{"wall": {"bottom_left": [x, y], "bottom_right": [x, y], '
        '"top_right": [x, y], "top_left": [x, y]}, '
        '"objects": [{"label": "sofa", "confidence": 0.9, '
        '"box": [x, y, w, h], "support": "floor"}]}'
    )


def _extract_json(text: str) -> dict:
    """Pull the JSON object out of a reply that may be wrapped in prose."""
    candidates = [match.group(1) for match in _JSON_FENCE.finditer(text)]
    stripped = text.strip()
    if stripped:
        candidates.append(stripped)
        start, end = stripped.find("{"), stripped.rfind("}")
        if 0 <= start < end:
            candidates.append(stripped[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise UnreadableReading("no JSON object in the model's reply")


def _unit(value: object) -> float:
    number = float(value)  # type: ignore[arg-type]
    if number != number:  # NaN
        raise UnreadableReading("coordinate is not a number")
    return min(1.0, max(0.0, number))


def _point(raw: object, size: tuple[int, int]) -> tuple[float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise UnreadableReading("a corner must be a pair of numbers")
    width, height = size
    return _unit(raw[0]) * width, _unit(raw[1]) * height


def parse_reading(reply: str, *, image_size: tuple[int, int], wall_tag: str | None = None) -> ImageReading:
    """Turn a model reply into a reading, in pixels, keeping only usable parts.

    A malformed *object* is dropped and noted; a malformed *wall* costs the photo
    its pose but not its detections, since another photo of the same wall may
    still localize. Only a reply that is not JSON at all is fatal.
    """
    payload = _extract_json(reply)
    notes: list[str] = []
    width, height = image_size

    quad: tuple[tuple[float, float], ...] | None = None
    wall = payload.get("wall")
    if isinstance(wall, dict) and all(corner in wall for corner in WALL_CORNERS):
        try:
            quad = tuple(_point(wall[corner], image_size) for corner in WALL_CORNERS)
        except UnreadableReading as error:
            notes.append(f"wall corners unusable ({error})")
            quad = None
    elif wall is not None:
        notes.append("wall corners missing or malformed")

    detections: list[Detection] = []
    raw_objects = payload.get("objects")
    if not isinstance(raw_objects, list):
        raw_objects = []
        notes.append("no object list in the reply")

    for index, item in enumerate(raw_objects):
        if not isinstance(item, dict):
            notes.append(f"object {index} is not an object")
            continue
        category = category_for_prompt(str(item.get("label", "")))
        if category is None:
            # Not a note: the model naming something outside the taxonomy is
            # expected and uninteresting. Only defects are worth surfacing.
            continue
        box = item.get("box")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            notes.append(f"object {index} ({category}) has no usable box")
            continue
        try:
            x, y, w, h = (_unit(value) for value in box)
            confidence = min(1.0, max(0.0, float(item.get("confidence", 0.0))))
        except (UnreadableReading, TypeError, ValueError):
            notes.append(f"object {index} ({category}) has unreadable numbers")
            continue
        if w <= 0 or h <= 0:
            notes.append(f"object {index} ({category}) has an empty box")
            continue
        if confidence < CONFIDENCE_FLOOR:
            continue
        # Clamp to the frame: a box that runs off the edge is common and fine,
        # but its pixels must still be inside the image for stage 3.
        x1, y1 = min(1.0, x + w), min(1.0, y + h)
        detections.append(
            Detection(
                category=category,
                confidence=confidence,
                box=(x * width, y * height, (x1 - x) * width, (y1 - y) * height),
                wall_tag=wall_tag,
            )
        )

    return ImageReading(detections=tuple(detections), wall_quad=quad, notes=tuple(notes))


def read_photo(image_bytes: bytes, *, media_type: str = "jpeg", wall_tag: str | None = None,
               image_size: tuple[int, int]) -> ImageReading:
    """Send one photo to Bedrock and parse the reply.

    Uses the Converse API so the request shape does not depend on which vendor's
    model is configured.
    """
    ready, reason = configured()
    if not ready:
        raise BedrockUnavailable(f"stage 1 cannot run through Bedrock: {reason}")

    import boto3  # noqa: PLC0415

    client = boto3.client("bedrock-runtime", region_name=os.environ[REGION_ENV])
    response = client.converse(
        modelId=os.environ[MODEL_ID_ENV],
        messages=[
            {
                "role": "user",
                "content": [
                    {"image": {"format": media_type, "source": {"bytes": image_bytes}}},
                    {"text": prompt_text()},
                ],
            }
        ],
        inferenceConfig={
            "maxTokens": int(os.environ.get(MAX_TOKENS_ENV, DEFAULT_MAX_TOKENS)),
            # Detection is a measurement, not a composition: same photo, same answer.
            "temperature": 0.0,
        },
    )
    blocks = response.get("output", {}).get("message", {}).get("content", [])
    text = "".join(block.get("text", "") for block in blocks)
    if not text.strip():
        raise UnreadableReading("the model returned no text")
    return parse_reading(text, image_size=image_size, wall_tag=wall_tag)


def encode_image(image_bytes: bytes) -> str:
    """Base64 for the request shapes that want a string rather than raw bytes."""
    return base64.standard_b64encode(image_bytes).decode("ascii")
