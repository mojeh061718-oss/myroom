"""Stage 1 — detect & segment (docs/05 §3), and the honesty about what it needs.

Grounding DINO (Apache-2.0) prompted with the interior vocabulary, then SAM 2
(Apache-2.0) to refine each box into a mask. Both need model weights and a GPU;
neither is installed by the base package, so importing this module is always
safe and calling into it without the weights raises a clear, actionable error
instead of silently returning nothing.

The detection vocabulary is not defined here — it is generated from the shared
taxonomy in ``packages/catalog`` so the classes the detector can name and the
classes the app can place stay the same set (docs/05 §3, docs/07 §5).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

TAXONOMY_JSON = Path(__file__).resolve().parents[3] / "packages" / "catalog" / "assets" / "taxonomy.json"

#: Hugging Face repos for the two models (both Apache-2.0, docs/08 §3).
DETECTOR_MODEL = "IDEA-Research/grounding-dino-base"
SEGMENTER_MODEL = "facebook/sam2-hiera-large"


class ModelsUnavailable(RuntimeError):
    """Weights or the ML runtime are missing on this worker."""


@dataclass(frozen=True)
class Detection:
    category: str
    confidence: float
    box: tuple[float, float, float, float]
    mask_ref: str | None = None
    wall_tag: str | None = None


@lru_cache(maxsize=1)
def detection_vocabulary() -> list[str]:
    """The ~120-class open-vocabulary prompt set, from the shared taxonomy."""
    if not TAXONOMY_JSON.exists():
        raise ModelsUnavailable(
            f"{TAXONOMY_JSON} is missing — run `pnpm --filter @myroom/catalog build:taxonomy`"
        )
    data = json.loads(TAXONOMY_JSON.read_text())
    prompts: list[str] = []
    for category in data:
        prompts.extend(category.get("detectionPrompts", []))
    # Order-stable dedupe: the prompt string is part of the model's input, so it
    # must not shuffle between runs of the regression suite.
    seen: set[str] = set()
    return [p for p in prompts if not (p in seen or seen.add(p))]


@lru_cache(maxsize=1)
def _prompt_index() -> dict[str, str]:
    """Every name a detector might use, mapped to its taxonomy category id.

    Detectors return prompt strings ("couch"), the app places category ids
    ("sofa"). One table, built from the same taxonomy both sides share, so a new
    synonym never has to be added in two places.
    """
    if not TAXONOMY_JSON.exists():
        raise ModelsUnavailable(
            f"{TAXONOMY_JSON} is missing — run `pnpm --filter @myroom/catalog build:taxonomy`"
        )
    index: dict[str, str] = {}
    for category in json.loads(TAXONOMY_JSON.read_text()):
        identifier = category["id"]
        names = [identifier, category.get("label", ""), *category.get("detectionPrompts", [])]
        for name in names:
            key = str(name).strip().lower()
            # First writer wins: a category's own id and label outrank another
            # category's synonym when two collide.
            if key and key not in index:
                index[key] = identifier
    return index


def category_for_prompt(label: str) -> str | None:
    """Taxonomy category id for a detector's label, or None if it names nothing.

    A model asked for a closed vocabulary will still occasionally answer outside
    it. Returning None — rather than inventing a category — is what keeps an
    unplaceable label from reaching the scene.
    """
    return _prompt_index().get(label.strip().lower())


def runtime_available() -> tuple[bool, str]:
    """Whether this worker can run stage 1, and why not when it can't."""
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as error:
        return False, f"ML runtime not installed ({error.name}); install the `models` extra"
    try:
        import torch

        if not torch.cuda.is_available():
            return False, "no CUDA device visible to this worker"
    except Exception as error:  # noqa: BLE001
        return False, str(error)
    return True, ""


def detect_and_segment(image_paths: list[str], *, wall_tags: dict[str, str] | None = None) -> list[Detection]:
    """Run stage 1 over a batch of photos.

    Raises :class:`ModelsUnavailable` when the worker has no ML runtime — the
    orchestrator turns that into the docs/05 §8 fallback (an accurate empty
    room), never into a dead end.
    """
    ready, reason = runtime_available()
    if not ready:
        raise ModelsUnavailable(
            f"stage 1 (detect & segment) cannot run here: {reason}. "
            f"Deploy a GPU worker with {DETECTOR_MODEL} and {SEGMENTER_MODEL}."
        )

    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    processor = AutoProcessor.from_pretrained(DETECTOR_MODEL)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(DETECTOR_MODEL).to("cuda")
    prompt = ". ".join(detection_vocabulary()) + "."

    out: list[Detection] = []
    for path in image_paths:
        image = Image.open(path).convert("RGB")
        inputs = processor(images=image, text=prompt, return_tensors="pt").to("cuda")
        with torch.no_grad():
            outputs = model(**inputs)
        results = processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            threshold=0.35,
            text_threshold=0.25,
            target_sizes=[image.size[::-1]],
        )[0]
        for label, score, box in zip(results["labels"], results["scores"], results["boxes"]):
            x0, y0, x1, y1 = (float(v) for v in box)
            out.append(
                Detection(
                    category=str(label),
                    confidence=float(score),
                    box=(x0, y0, x1 - x0, y1 - y0),
                    wall_tag=(wall_tags or {}).get(path),
                )
            )
    return out
