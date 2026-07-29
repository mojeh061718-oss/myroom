"""Stage 1 — detect & segment (docs/05 §3), on whatever device this worker has.

Grounding DINO (Apache-2.0) prompted with the interior vocabulary, then SAM
(Apache-2.0) to refine each box into a mask — the two models docs/05 §3 names.

**A correction to this module's first version.** It used to refuse to start
unless ``torch.cuda.is_available()``, and hardcoded ``.to("cuda")`` on both the
model and its inputs. That made an NVIDIA card a hard requirement for the
headline feature of the app, and it was never one: PyTorch's default device is
the CPU, and these are small models. The gate is gone. Device selection now
lives in :mod:`myroom_vision.device`, which prefers CUDA when it is there,
then Apple Metal, then Intel XPU, and falls back to the CPU — the floor docs/03
§8 requires ("full local pipeline must run on a laptop without GPU").

Two profiles, because "runs on a CPU" and "runs well on a CPU" differ:

``full``
    The checkpoints docs/05 §3 names. Best quality, wants an accelerator.
``compact``
    Distilled siblings — same architectures, ~5x less compute — for CPU workers
    and the in-browser tier. Chosen automatically when no accelerator is found.

The detection vocabulary is not defined here — it is generated from the shared
taxonomy in ``packages/catalog`` so the classes the detector can name and the
classes the app can place stay the same set (docs/05 §3, docs/07 §5).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .device import RuntimeMissing, select_device

TAXONOMY_JSON = Path(__file__).resolve().parents[3] / "packages" / "catalog" / "assets" / "taxonomy.json"

#: Hugging Face repos for the two models (both Apache-2.0, docs/08 §3).
DETECTOR_MODEL = "IDEA-Research/grounding-dino-base"
SEGMENTER_MODEL = "facebook/sam2-hiera-large"

#: CPU/phone profile. Same architectures, distilled — still Apache-2.0.
DETECTOR_MODEL_COMPACT = "IDEA-Research/grounding-dino-tiny"
SEGMENTER_MODEL_COMPACT = "Zigeng/SlimSAM-uniform-77"

MODEL_LICENSES = {
    DETECTOR_MODEL: "Apache-2.0",
    SEGMENTER_MODEL: "Apache-2.0",
    DETECTOR_MODEL_COMPACT: "Apache-2.0",
    SEGMENTER_MODEL_COMPACT: "Apache-2.0",
}

#: docs/05 §3 thresholds.
BOX_THRESHOLD = 0.35
TEXT_THRESHOLD = 0.25


class ModelsUnavailable(RuntimeError):
    """The ML runtime or the weights are missing on this worker.

    Note what this no longer means: it is *not* raised for the absence of a GPU.
    """


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
def _prompt_to_category() -> dict[str, str]:
    """Detection prompt → taxonomy id.

    The vocabulary and the catalog are deliberately not the same list: the
    taxonomy has 187 ids but 368 prompts, because "couch" and "settee" should
    both find a ``sofa``. Only 69 prompts happen to be spelled like their id, so
    emitting the raw prompt as the category would leave four detections in five
    unresolvable by ``getCategory`` and unmatched by stage 4 — the object would
    fall through to a parametric placeholder despite having been recognised
    correctly.
    """
    if not TAXONOMY_JSON.exists():
        raise ModelsUnavailable(
            f"{TAXONOMY_JSON} is missing — run `pnpm --filter @myroom/catalog build:taxonomy`"
        )
    mapping: dict[str, str] = {}
    for category in json.loads(TAXONOMY_JSON.read_text()):
        identifier = category["id"]
        mapping[identifier.lower()] = identifier
        for prompt in category.get("detectionPrompts", []):
            mapping.setdefault(prompt.strip().lower(), identifier)
    return mapping


def category_for_label(label: str) -> str | None:
    """Resolve one detector label to a taxonomy id, or ``None`` if it is not ours.

    Grounding DINO returns the matched span of the prompt string, which is
    usually one vocabulary entry but can be a fragment or a run of two when
    spans abut. Exact match first; then the longest vocabulary entry contained
    in the span, so "leather couch" resolves to ``sofa`` rather than failing.
    """
    mapping = _prompt_to_category()
    cleaned = label.strip().lower().strip(".,")
    if not cleaned:
        return None
    if cleaned in mapping:
        return mapping[cleaned]
    contained = [p for p in mapping if p in cleaned]
    if not contained:
        return None
    return mapping[max(contained, key=len)]


def profile_for_device() -> str:
    """``full`` on an accelerator, ``compact`` on a CPU."""
    return "full" if select_device().is_accelerated else "compact"


def models_for(profile: str | None = None) -> tuple[str, str]:
    """(detector, segmenter) checkpoints for a profile."""
    chosen = profile or profile_for_device()
    if chosen == "compact":
        return DETECTOR_MODEL_COMPACT, SEGMENTER_MODEL_COMPACT
    return DETECTOR_MODEL, SEGMENTER_MODEL


def runtime_available() -> tuple[bool, str]:
    """Whether this worker can run stage 1, and why not when it can't.

    The only blocker is a missing ML runtime. A worker with no GPU is a slow
    worker, not an incapable one.
    """
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as error:
        return False, f"ML runtime not installed ({error.name}); install the `models` extra"
    try:
        device = select_device()
    except RuntimeMissing as error:
        return False, str(error)
    return True, f"{device.detail}, {profile_for_device()} profile"


@lru_cache(maxsize=2)
def _load_detector(profile: str):
    try:
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
    except ImportError as error:
        raise ModelsUnavailable(
            f"stage 1 needs the ML runtime ({error.name}); "
            f'install it with: pip install -e "workers/vision[models]"'
        ) from error

    device = select_device()
    detector_repo, _ = models_for(profile)
    processor = AutoProcessor.from_pretrained(detector_repo)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(detector_repo)
    model.eval()
    if device.dtype == "float16":
        model = model.half()
    model.to(torch.device(device.kind))
    return processor, model, device


def detect_and_segment(
    image_paths: list[str],
    *,
    wall_tags: dict[str, str] | None = None,
    profile: str | None = None,
) -> list[Detection]:
    """Run stage 1 over a batch of photos.

    Raises :class:`ModelsUnavailable` only when the worker has no ML runtime at
    all — the orchestrator turns that into the docs/05 §8 fallback (an accurate
    empty room), never into a dead end.
    """
    ready, reason = runtime_available()
    if not ready:
        raise ModelsUnavailable(f"stage 1 (detect & segment) cannot run here: {reason}.")

    import torch
    from PIL import Image

    chosen = profile or profile_for_device()
    processor, model, device = _load_detector(chosen)
    torch_device = torch.device(device.kind)
    prompt = ". ".join(detection_vocabulary()) + "."

    out: list[Detection] = []
    for path in image_paths:
        image = Image.open(path).convert("RGB")
        inputs = processor(images=image, text=prompt, return_tensors="pt")
        inputs = {k: (v.to(torch_device) if hasattr(v, "to") else v) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = model(**inputs)
        results = processor.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            threshold=BOX_THRESHOLD,
            text_threshold=TEXT_THRESHOLD,
            target_sizes=[image.size[::-1]],
        )[0]
        for label, score, box in zip(results["labels"], results["scores"], results["boxes"]):
            category = category_for_label(str(label))
            if category is None:
                # The detector matched a span that is not in our vocabulary.
                # Emitting it anyway would produce an object no catalog entry
                # and no placeholder can be chosen for.
                continue
            x0, y0, x1, y1 = (float(v) for v in box)
            out.append(
                Detection(
                    category=category,
                    confidence=float(score),
                    box=(x0, y0, x1 - x0, y1 - y0),
                    wall_tag=(wall_tags or {}).get(path),
                )
            )
    return out
