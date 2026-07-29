"""Where the model stages actually execute — and the correction of an old assumption.

The first cut of this pipeline treated "GPU" as "CUDA", and stage 1 refused to
start unless ``torch.cuda.is_available()``. That conflated a *backend* with a
*requirement*. PyTorch's default device is the CPU; CUDA is one optional
backend among several, and the pipeline's models are all small enough to run
without any of them:

===========================  ==========  ============================================
Model                        Params      Why it fits on a CPU or a phone
===========================  ==========  ============================================
Depth Anything V2 Small       24.8 M     ~1-3 s per photo on four CPU cores
SlimSAM (SAM, distilled)      27   M     mask refinement is one forward pass per box
OWLv2 base                    ~150 M     open-vocabulary detection, no CUDA kernels
OpenCLIP ViT-B/32             ~150 M     one embedding per crop for catalog ranking
===========================  ==========  ============================================

A reconstruction is a handful of photos, not a video stream. Minutes are an
acceptable budget for a job the user already sees a progress screen for, and
docs/03 §8 requires the full local pipeline to run on a laptop without a GPU.

So this module picks the best device present and never refuses to run for lack
of a particular vendor. The preference order is fastest-first, with CPU as the
floor that is always available.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

#: Honoured when set: "cuda", "mps", "xpu", "cpu". Anything else is ignored.
DEVICE_ENV_VAR = "MYROOM_VISION_DEVICE"

_VALID = ("cuda", "mps", "xpu", "cpu")


@dataclass(frozen=True)
class Device:
    """The chosen execution device and how we got there."""

    kind: str
    #: Human-readable, for the job log and the worker's health endpoint.
    detail: str
    #: torch dtype name appropriate for this device; float32 everywhere that
    #: half precision is either unsupported or slower (CPU half is emulated).
    dtype: str = "float32"

    @property
    def is_accelerated(self) -> bool:
        return self.kind != "cpu"


class RuntimeMissing(RuntimeError):
    """The ML runtime itself is absent — not the GPU, the *runtime*."""


def _probe(kind: str) -> tuple[bool, str]:
    """Is this backend usable right now?"""
    try:
        import torch
    except ImportError as error:
        raise RuntimeMissing(
            f"PyTorch is not installed ({error.name}). Install the `models` extra: "
            f'pip install -e "workers/vision[models]". For a machine with no NVIDIA '
            f"card, the CPU wheel is the small one: "
            f"pip install torch --index-url https://download.pytorch.org/whl/cpu"
        ) from error

    if kind == "cpu":
        return True, f"CPU ({torch.get_num_threads()} threads)"
    if kind == "cuda":
        if torch.cuda.is_available():
            return True, f"CUDA ({torch.cuda.get_device_name(0)})"
        return False, "no CUDA device"
    if kind == "mps":
        backend = getattr(torch.backends, "mps", None)
        if backend is not None and backend.is_available():
            return True, "Apple Metal (MPS)"
        return False, "no MPS device"
    if kind == "xpu":
        xpu = getattr(torch, "xpu", None)
        if xpu is not None and xpu.is_available():
            return True, "Intel XPU"
        return False, "no XPU device"
    return False, f"unknown backend {kind!r}"


@lru_cache(maxsize=1)
def select_device() -> Device:
    """The device this worker will use.

    Order: an explicit override, then CUDA, then Apple Metal, then Intel XPU,
    then the CPU. The CPU branch is not a failure mode — it is the documented
    floor (docs/03 §8), and it is what CI runs on.
    """
    override = os.environ.get(DEVICE_ENV_VAR, "").strip().lower()
    if override in _VALID:
        ok, detail = _probe(override)
        if ok:
            return Device(override, f"{detail} (pinned by {DEVICE_ENV_VAR})", _dtype_for(override))
        # An override that cannot be honoured is a configuration error worth
        # surfacing loudly rather than silently downgrading underneath someone.
        raise RuntimeMissing(f"{DEVICE_ENV_VAR}={override} was requested but {detail}")

    for kind in ("cuda", "mps", "xpu"):
        ok, detail = _probe(kind)
        if ok:
            return Device(kind, detail, _dtype_for(kind))

    ok, detail = _probe("cpu")
    return Device("cpu", detail, "float32")


def _dtype_for(kind: str) -> str:
    # Half precision is a win on CUDA and MPS. On CPU it is emulated and slower
    # than float32 for these model sizes, so the floor stays float32.
    return "float16" if kind in ("cuda", "mps") else "float32"


def torch_device():
    """The chosen device as a ``torch.device``."""
    import torch

    return torch.device(select_device().kind)


def torch_dtype():
    import torch

    return getattr(torch, select_device().dtype)


def runtime_available() -> tuple[bool, str]:
    """Whether the model stages can run here, and why not when they can't.

    The only real blocker is a missing runtime. Absence of a GPU is not one.
    """
    try:
        device = select_device()
    except RuntimeMissing as error:
        return False, str(error)
    return True, device.detail


def describe() -> dict[str, object]:
    """Health-endpoint payload: what this worker is and what it can do."""
    ok, detail = runtime_available()
    if not ok:
        return {"ready": False, "reason": detail, "device": None, "accelerated": False}
    device = select_device()
    return {
        "ready": True,
        "reason": "",
        "device": device.kind,
        "detail": device.detail,
        "dtype": device.dtype,
        "accelerated": device.is_accelerated,
    }
