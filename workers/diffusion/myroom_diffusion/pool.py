"""The diffusion pool — restyle renders of a room we already measured.

What this is *not*: part of the reconstruction pipeline. Reconstruction is a
discriminative problem (which object is that, how big is it, where is it), and
a generative model cannot answer any of those questions. docs/05's pipeline is
untouched by this module.

What it is: the generative half of docs/06 §6 — compare and share. The sandbox
already holds a metrically correct 3D room, so "show me this room in a warmer
palette" is a legitimate image-to-image problem, and that is what a diffusion
model is for.

**The geometry is not guessed.** Restyling a photograph means estimating depth
and hoping the model respects it. Here the input is a render of a scene we
built ourselves, so the depth buffer is exact — every pixel's distance is known
to the millimetre. Feeding that to a depth ControlNet constrains the result to
the room's real shape: the couch stays couch-sized and where the user put it,
and only the surfaces change. A restyle that invents a different room would be
worse than useless in an app whose entire promise is true scale.

Device handling follows the same rule as the vision workers: prefer an
accelerator, fall back to the CPU, never refuse for want of a particular
vendor. On CPU this is minutes per image, which is why it is an explicit,
progress-tracked action the user asks for — not something that runs on a timer.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .registry import (
    BASE_DIFFUSION,
    CONTROLNET_DEPTH,
    STYLE_LORAS,
    LicenseRejected,
    ModelWeights,
    lora,
    require,
)

#: The operator must set this before any opt-in weights are fetched. Absent it,
#: restyle reports itself unavailable rather than downloading OpenRAIL weights
#: into a repository whose policy does not allow them (see registry.py).
ENABLE_ENV_VAR = "MYROOM_ENABLE_DIFFUSION"

#: Where fetched weights land. Deliberately outside the repo tree.
CACHE_ENV_VAR = "MYROOM_DIFFUSION_CACHE"

#: docs/06 §6 budget. Restyle is a foreground action with a progress bar, but a
#: user should never wait longer than this for one.
DEFAULT_STEPS_ACCELERATED = 24
DEFAULT_STEPS_CPU = 8


class DiffusionUnavailable(RuntimeError):
    """Restyle cannot run here, with a reason the operator can act on."""


@dataclass(frozen=True)
class RestyleResult:
    image: np.ndarray
    style: str
    steps: int
    device: str
    seconds: float
    seed: int


def _device():
    """Reuse the vision workers' device selection so both tiers agree."""
    import sys
    from pathlib import Path

    workers = Path(__file__).resolve().parents[2] / "vision"
    if str(workers) not in sys.path:
        sys.path.insert(0, str(workers))
    from myroom_vision.device import RuntimeMissing, select_device  # noqa: PLC0415

    try:
        return select_device()
    except RuntimeMissing as error:
        raise DiffusionUnavailable(str(error)) from error


def enabled() -> bool:
    return os.environ.get(ENABLE_ENV_VAR, "").strip().lower() in ("1", "true", "yes", "on")


def available() -> tuple[bool, str]:
    """Whether a restyle can run, and why not when it can't."""
    if not enabled():
        return False, (
            f"restyle is off. The base model ({BASE_DIFFUSION.repo}) is "
            f"{BASE_DIFFUSION.spdx}, which docs/08 §7 does not permit bundling, so it is "
            f"fetched only when an operator sets {ENABLE_ENV_VAR}=1 and accepts its terms."
        )
    try:
        import diffusers  # noqa: F401
        import torch  # noqa: F401
    except ImportError as error:
        return False, f"the diffusion runtime is not installed ({error.name})"
    try:
        device = _device()
    except DiffusionUnavailable as error:
        return False, str(error)
    return True, f"{device.detail}, {len(STYLE_LORAS)} styles"


def styles() -> list[dict[str, object]]:
    """The pool's style menu, with each entry's licence terms attached."""
    out: list[dict[str, object]] = []
    for key, model in STYLE_LORAS.items():
        try:
            require(model)
            allowed, why = True, ""
        except LicenseRejected as error:
            allowed, why = False, str(error)
        out.append(
            {
                "key": key,
                "label": model.purpose,
                "triggerWords": list(model.trigger_words),
                "source": model.source,
                "civitaiId": model.civitai_id,
                "spdx": model.spdx,
                "commercialImages": model.allows_commercial_images,
                "allowed": allowed,
                "reason": why,
            }
        )
    return out


def _cache_dir() -> str | None:
    return os.environ.get(CACHE_ENV_VAR) or None


#: Some Civitai downloads are gated behind an account. Set this to fetch those.
CIVITAI_TOKEN_ENV_VAR = "CIVITAI_API_TOKEN"


def fetch_lora(weights: ModelWeights) -> str:
    """Download a Civitai LoRA to the cache and return its local path.

    ``diffusers.load_lora_weights`` accepts a Hugging Face repo id or a path on
    disk — never a URL. Civitai serves single ``.safetensors`` files over HTTP,
    so they have to land on disk first. Cached by Civitai model id, because the
    download URL carries a *version* id and the same style re-resolves to a new
    one whenever its author publishes an update.
    """
    import urllib.error
    import urllib.request
    from pathlib import Path

    if weights.source != "civitai":
        return weights.repo  # a Hugging Face repo id passes straight through

    root = Path(_cache_dir() or Path.home() / ".cache" / "myroom-diffusion") / "loras"
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"civitai-{weights.civitai_id}.safetensors"
    if target.exists() and target.stat().st_size > 0:
        return str(target)

    request = urllib.request.Request(
        weights.repo,
        headers={"User-Agent": "myroom-sandbox/0.1 (+docs/06 restyle)"},
    )
    token = os.environ.get(CIVITAI_TOKEN_ENV_VAR, "").strip()
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    partial = target.with_suffix(".partial")
    try:
        with urllib.request.urlopen(request, timeout=180) as response, partial.open("wb") as handle:
            while chunk := response.read(1 << 20):
                handle.write(chunk)
    except urllib.error.HTTPError as error:
        partial.unlink(missing_ok=True)
        if error.code in (401, 403):
            raise DiffusionUnavailable(
                f"Civitai refused the download for {weights.key} (HTTP {error.code}). "
                f"That model requires an account — set {CIVITAI_TOKEN_ENV_VAR}."
            ) from error
        raise DiffusionUnavailable(
            f"could not fetch the {weights.key} LoRA from Civitai: HTTP {error.code}"
        ) from error
    except (urllib.error.URLError, TimeoutError) as error:
        partial.unlink(missing_ok=True)
        raise DiffusionUnavailable(
            f"could not reach Civitai for the {weights.key} LoRA: {error}"
        ) from error

    # A truncated file would fail deep inside safetensors with a confusing
    # error, so only publish the cache entry once the download is complete.
    if partial.stat().st_size < 1024:
        partial.unlink(missing_ok=True)
        raise DiffusionUnavailable(
            f"the {weights.key} LoRA download was empty — Civitai may have returned an error page"
        )
    partial.rename(target)
    return str(target)


@lru_cache(maxsize=1)
def _load_pipeline():
    """Build the SD 1.5 + depth-ControlNet pipeline on this worker's device."""
    ok, why = available()
    if not ok:
        raise DiffusionUnavailable(why)

    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetImg2ImgPipeline

    base = require(BASE_DIFFUSION)
    control = require(CONTROLNET_DEPTH)
    device = _device()
    dtype = torch.float16 if device.dtype == "float16" else torch.float32

    controlnet = ControlNetModel.from_pretrained(
        control.repo, torch_dtype=dtype, cache_dir=_cache_dir()
    )
    pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
        base.repo,
        controlnet=controlnet,
        torch_dtype=dtype,
        cache_dir=_cache_dir(),
        # The app renders furniture in real homes; the checker adds a model
        # download and a false-positive rate we would then have to explain.
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe.to(torch.device(device.kind))

    if device.kind == "cpu":
        # Trades a little speed for a much smaller peak footprint, which is what
        # keeps this inside a CI container's memory.
        pipe.enable_attention_slicing()
        pipe.enable_vae_slicing()

    return pipe, device


def depth_to_control_image(depth_buffer: np.ndarray) -> np.ndarray:
    """Turn the sandbox's depth buffer into the 3-channel map ControlNet wants.

    ``depth_buffer`` is metres from the camera, straight out of the WebGL depth
    attachment — exact, not estimated. ControlNet-depth was trained on inverted,
    normalised maps where *near is bright*, so that is the convention here.
    """
    depth = np.asarray(depth_buffer, dtype=np.float32)
    finite = np.isfinite(depth)
    if not finite.any():
        raise ValueError("depth buffer is entirely non-finite")

    valid = depth[finite]
    near, far = float(valid.min()), float(valid.max())
    if far - near < 1e-6:
        # A flat wall filling the frame: uniform depth is legitimate, and any
        # normalisation of it is arbitrary, so pick the mid grey.
        normalised = np.full(depth.shape, 0.5, dtype=np.float32)
    else:
        normalised = (depth - near) / (far - near)
        normalised = 1.0 - normalised  # near is bright

    normalised[~finite] = 0.0  # sky/background reads as maximally far
    eight_bit = (np.clip(normalised, 0.0, 1.0) * 255.0).astype(np.uint8)
    return np.repeat(eight_bit[:, :, None], 3, axis=2)


#: Kohya-format prefixes. Community LoRAs are published in this layout almost
#: universally, whatever tool trained them.
UNET_PREFIX = "lora_unet_"
TEXT_ENCODER_PREFIX = "lora_te_"


def split_lora_state_dict(state_dict: dict) -> tuple[dict, dict]:
    """Partition a kohya LoRA into its UNet and text-encoder halves."""
    unet = {k: v for k, v in state_dict.items() if k.startswith(UNET_PREFIX)}
    text = {k: v for k, v in state_dict.items() if k.startswith(TEXT_ENCODER_PREFIX)}
    return unet, text


def apply_lora(pipe, path: str, *, adapter_name: str = "style") -> str:
    """Load a LoRA, degrading to the UNet half if the text encoder will not map.

    Community LoRAs are trained by many different tools, and while the UNet half
    converts reliably, the text-encoder half does not: layer names drift between
    trainers, and diffusers raises rather than skipping what it cannot match.
    A style LoRA's *look* lives almost entirely in the UNet — 576 of the 792
    tensors in the reference file here — so dropping the text encoder costs a
    little prompt adherence and keeps the feature working across the catalogue
    instead of only for LoRAs from one trainer.

    Returns which halves were applied, so the caller can report it honestly.
    """
    from safetensors.torch import load_file

    try:
        pipe.load_lora_weights(path, adapter_name=adapter_name)
        return "unet+text-encoder"
    except (IndexError, KeyError, ValueError, RuntimeError):
        # The full load reaches the UNet before it reaches the text encoder, so
        # a failure on the second half leaves the first half registered. Clear
        # it, or the retry below collides on the adapter name.
        try:
            pipe.unload_lora_weights()
        except Exception:  # noqa: BLE001 - nothing here is worth masking the real error
            pass

    state_dict = load_file(path)
    unet, _text = split_lora_state_dict(state_dict)
    if not unet:
        raise DiffusionUnavailable(
            f"{path} has no recognisable UNet LoRA weights "
            f"(expected keys prefixed {UNET_PREFIX!r})"
        )
    pipe.load_lora_weights(unet, adapter_name=adapter_name)
    return "unet"


def restyle(
    render: np.ndarray,
    depth_buffer: np.ndarray,
    *,
    style: str,
    prompt: str | None = None,
    strength: float = 0.45,
    steps: int | None = None,
    seed: int = 0,
    lora_scale: float = 0.8,
) -> RestyleResult:
    """Restyle one sandbox render, holding its geometry fixed.

    ``strength`` is deliberately below half: above roughly 0.6 the model starts
    moving furniture, and an app that promises true scale cannot ship a feature
    that quietly rearranges the user's room.
    """
    import torch
    from PIL import Image

    pipe, device = _load_pipeline()
    weights = lora(style)

    steps = steps or (DEFAULT_STEPS_ACCELERATED if device.is_accelerated else DEFAULT_STEPS_CPU)

    pipe.unload_lora_weights()
    apply_lora(pipe, fetch_lora(weights))

    trigger = ", ".join(weights.trigger_words)
    text = prompt or f"{trigger}, interior photograph of a room, natural light, high detail"

    control = Image.fromarray(depth_to_control_image(depth_buffer))
    source = Image.fromarray(np.asarray(render, dtype=np.uint8)).convert("RGB")
    if control.size != source.size:
        control = control.resize(source.size, Image.BILINEAR)

    generator = torch.Generator(device="cpu").manual_seed(seed)

    started = time.perf_counter()
    output = pipe(
        prompt=text,
        negative_prompt="distorted geometry, warped walls, extra furniture, text, watermark",
        image=source,
        control_image=control,
        strength=strength,
        num_inference_steps=steps,
        guidance_scale=7.0,
        generator=generator,
        cross_attention_kwargs={"scale": lora_scale},
    )
    elapsed = time.perf_counter() - started

    return RestyleResult(
        image=np.asarray(output.images[0], dtype=np.uint8),
        style=style,
        steps=steps,
        device=device.kind,
        seconds=elapsed,
        seed=seed,
    )


def describe() -> dict[str, object]:
    ok, why = available()
    return {
        "ready": ok,
        "reason": "" if ok else why,
        "baseModel": BASE_DIFFUSION.repo,
        "baseLicense": BASE_DIFFUSION.spdx,
        "bundled": False,
        "styles": styles(),
    }
