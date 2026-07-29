"""Stage 2's metric depth (docs/05 §4), on whatever device this worker has.

Depth Anything V2 Small: 24.8 M parameters, Apache-2.0, and small enough that a
CPU-only worker produces a depth map for a room photo in seconds. The same
weights are published as ONNX for the in-browser tier, so the phone and the
server run the same model and a scene reconstructed in either place matches.

Monocular depth is only *relatively* correct — it recovers the shape of the
room but not its scale. The plan supplies the scale: a wall whose length the
user typed is a known distance, so :func:`myroom_vision.solve.rescale_depth`
maps the network's output onto metres. That correction is what docs/05 §4 means
by turning "roughly metric" depth into plan-accurate depth, and it is why the
smallest checkpoint is good enough — we need shape from the network, not scale.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .device import RuntimeMissing, select_device

#: Apache-2.0 (docs/08 §3 allowlist). The `-hf` variant carries the
#: transformers config; `onnx-community/depth-anything-v2-small` is the same
#: network exported for onnxruntime-web on the phone tier.
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
DEPTH_MODEL_ONNX = "onnx-community/depth-anything-v2-small"
DEPTH_MODEL_LICENSE = "Apache-2.0"


class DepthUnavailable(RuntimeError):
    """Depth estimation cannot run here, with a reason the operator can act on."""


@dataclass(frozen=True)
class DepthMap:
    """Relative inverse depth, plus the metadata Stage 2 needs to rescale it."""

    #: (H, W) float32. Larger values are NEARER — this is disparity-like, which
    #: is what the network emits. `to_distance` flips it.
    relative: np.ndarray
    width: int
    height: int
    device: str
    seconds: float

    def to_distance(self, *, near_clip: float = 1e-6) -> np.ndarray:
        """Convert the network's inverse depth into an unscaled distance field.

        Still not metres — :func:`solve.rescale_depth` supplies that — but
        monotonically increasing with true distance, which is what
        back-projection needs.
        """
        rel = np.asarray(self.relative, dtype=np.float64)
        # Shift so the minimum is positive before inverting: the raw output can
        # contain zeros, and 1/0 would seed the point cloud with infinities.
        floor = rel.min()
        shifted = rel - floor + max(near_clip, (rel.max() - floor) * 1e-3)
        return (1.0 / shifted).astype(np.float32)


@lru_cache(maxsize=1)
def _load():
    """Load processor + model once per worker process."""
    try:
        import torch  # noqa: F401
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    except ImportError as error:
        raise DepthUnavailable(
            f"the ML runtime is not installed ({error.name}); "
            f'pip install -e "workers/vision[models]"'
        ) from error

    try:
        device = select_device()
    except RuntimeMissing as error:
        raise DepthUnavailable(str(error)) from error

    import torch

    processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL)
    model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL)
    model.eval()
    # float16 on CPU is emulated and slower for a model this size, so device.py
    # keeps CPU at float32; only accelerators get the half-precision copy.
    if device.dtype == "float16":
        model = model.half()
    model.to(torch.device(device.kind))
    return processor, model, device


def available() -> tuple[bool, str]:
    """Whether stage 2's depth half can run, without loading the weights."""
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as error:
        return False, f"ML runtime not installed ({error.name})"
    try:
        return True, select_device().detail
    except RuntimeMissing as error:
        return False, str(error)


def estimate_depth(image) -> DepthMap:
    """Run Depth Anything V2 over one photo.

    ``image`` is a PIL image or an (H, W, 3) uint8 array. No device is hardcoded
    anywhere in this function — see :mod:`myroom_vision.device`.
    """
    import time

    import torch

    processor, model, device = _load()

    if not hasattr(image, "size"):
        from PIL import Image

        image = Image.fromarray(np.asarray(image, dtype=np.uint8)).convert("RGB")
    elif image.mode != "RGB":
        image = image.convert("RGB")

    width, height = image.size
    inputs = processor(images=image, return_tensors="pt")
    torch_device = torch.device(device.kind)
    inputs = {k: v.to(torch_device) for k, v in inputs.items()}
    if device.dtype == "float16":
        inputs = {k: (v.half() if v.is_floating_point() else v) for k, v in inputs.items()}

    started = time.perf_counter()
    with torch.no_grad():
        outputs = model(**inputs)
    elapsed = time.perf_counter() - started

    # Back to the photo's own resolution so masks from stage 1 line up pixel for
    # pixel — the processor resizes to the network's input size, and a depth map
    # at the wrong resolution would silently mis-measure every object.
    predicted = outputs.predicted_depth
    if predicted.ndim == 3:
        predicted = predicted.unsqueeze(1)
    resized = torch.nn.functional.interpolate(
        predicted.float(), size=(height, width), mode="bicubic", align_corners=False
    )

    return DepthMap(
        relative=resized[0, 0].cpu().numpy().astype(np.float32),
        width=width,
        height=height,
        device=device.kind,
        seconds=elapsed,
    )
