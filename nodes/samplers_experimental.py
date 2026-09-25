"""SamplerCustomAdvanced_LatentPick (QQ experimental).

Fork of the core SamplerCustomAdvanced (comfy_extras/nodes_custom_sampler.py) that keeps
the denoised latent of *every* step and exports the one picked with `stop_on`.

What is different from the core node:
- each step's x0 (the tensor the core node uses for `denoised_output`) is copied to the CPU
  while the run is in flight, so all of them survive the run
- `stop_on` picks which of them leaves through the new `stop_latent` output
- the whole set is stashed under a run key that covers everything deciding the sampling
  pass except `stop_on`, so changing `stop_on` re-executes only this node and is served
  from the stash -- the guider/sampler are not run a second time

Costs: one latent per step held in RAM (an H3 AV latent over 20 steps is ~100 MB; the
stash is capped, see _STASH_MAX_BYTES), and the picked latent is a copy of that step's
x0 rather than the sampler's returned tensor, so it matches `denoised_output` at that
step and not `output`.
"""

import torch

import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.utils
import latent_preview
from comfy_api.latest import io


# --------------------------------------------------------------------------- stash
# One entry per sampling pass, keyed by everything that decides the pass -- and not by
# stop_on, which is what makes re-picking free. Written by the execution that samples,
# read back by every later execution whose only change was stop_on.
_STASH = {}           # run key -> {"steps": [x0 cpu, ...], "out": LATENT, "denoised": LATENT,
                      #             "latent_shapes": [...] or None, "bytes": int, "seed": int}
_STASH_ORDER = []     # run keys, oldest first
_STASH_MAX_ENTRIES = 4
_STASH_MAX_BYTES = 2 * 1024 ** 3


def _tensor_bytes(t):
    if getattr(t, "is_nested", False):
        return sum(_tensor_bytes(x) for x in t.unbind())
    try:
        return t.numel() * t.element_size()
    except Exception:
        return 0


def _snapshot(x0):
    """Copy a step's denoised latent off the GPU without aliasing the live tensor."""
    if getattr(x0, "is_nested", False):
        return comfy.nested_tensor.NestedTensor([t.detach().to("cpu", copy=True) for t in x0.unbind()])
    return x0.detach().to("cpu", copy=True)


def _probe(samples):
    """Cheap content probe, so a matching shape/dtype cannot be mistaken for a matching latent."""
    try:
        if getattr(samples, "is_nested", False) or not isinstance(samples, torch.Tensor):
            return None
        flat = samples.detach().flatten()
        if flat.numel() == 0:
            return 0.0
        return float(flat[::max(1, flat.numel() // 64)].float().abs().sum())
    except Exception:
        return None


def _run_key(noise, sampler, guider, sigmas, latent):
    """The signature of the sampling pass: same key means same run, stop_on aside."""
    samples = latent.get("samples")
    mask = latent.get("noise_mask")
    patcher = getattr(guider, "model_patcher", None)
    if isinstance(sigmas, torch.Tensor):
        sig = (tuple(sigmas.shape), tuple(sigmas.detach().flatten().to("cpu").tolist()))
    else:
        sig = tuple(sigmas)
    return (
        type(noise).__name__, getattr(noise, "seed", -1), id(noise),
        type(sampler).__name__, getattr(getattr(sampler, "sampler_function", None), "__name__", None), id(sampler),
        type(guider).__name__, id(guider),
        id(patcher), id(getattr(patcher, "model", None)),
        sig,
        id(samples), tuple(getattr(samples, "shape", ())), str(getattr(samples, "dtype", None)), _probe(samples),
        id(mask), tuple(getattr(mask, "shape", ())),
        tuple(sorted(latent.keys())),
    )


def _store(key, entry):
    if key in _STASH:
        _STASH_ORDER.remove(key)
    _STASH[key] = entry
    _STASH_ORDER.append(key)
    total = sum(e["bytes"] for e in _STASH.values())
    while _STASH_ORDER and (len(_STASH_ORDER) > _STASH_MAX_ENTRIES or (total > _STASH_MAX_BYTES and len(_STASH_ORDER) > 1)):
        dropped = _STASH.pop(_STASH_ORDER.pop(0))
        total -= dropped["bytes"]


def _latent_from_x0(base, x0, latent_shapes, model):
    """The core node's denoised_output path: unpack if needed, process, wrap in a latent dict."""
    if latent_shapes is not None and not getattr(x0, "is_nested", False):
        x0 = comfy.nested_tensor.NestedTensor(comfy.utils.unpack_latents(x0, latent_shapes))
    out = dict(base)
    out["samples"] = model.process_latent_out(x0.cpu())
    return out


class SamplerCustomAdvanced_LatentPick(io.ComfyNode):
    DESCRIPTION = (
        "SamplerCustomAdvanced that keeps the denoised latent of EVERY step and exports the one picked "
        "with stop_on as stop_latent.\n\n"
        "output and denoised_output are what the core SamplerCustomAdvanced returns. stop_latent is a "
        "step's x0, the same space as denoised_output, so it decodes like a finished latent that stopped "
        "early.\n\n"
        "All steps are stashed under a key that covers everything deciding the sampling pass except "
        "stop_on, so changing stop_on re-runs this node and is served from the stash: the sampler does "
        "not run again and the model is not reloaded. The stash lives in RAM for the last few passes "
        "(capped); change the graph, the seed or the model and the pass is sampled again.\n\n"
        "stop_on is a 0-based step index: 0 is the latent right after the first model evaluation, "
        "steps-1 is the last one. With 6 steps, stop_on 4 is the point you would get by stopping 2 steps "
        "early, and stop_on 5 equals denoised_output. Values past the last step clamp to it."
    )

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SamplerCustomAdvanced_LatentPick",
            display_name="SamplerCustomAdvanced_LatentPick",
            category="SA-Nodes-QQ/sampling",
            inputs=[
                io.Noise.Input("noise"),
                io.Guider.Input("guider"),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.Latent.Input("latent_image"),
                io.Int.Input("stop_on", default=2, min=0, max=10000,
                             tooltip="Which stashed step latent goes to stop_latent. 0 = first step, "
                                     "steps-1 = last step (the same latent as denoised_output). Every step is "
                                     "kept, so changing this only re-picks - the sampler is not run again. "
                                     "Values past the last step clamp to it."),
            ],
            outputs=[
                io.Latent.Output(display_name="output"),
                io.Latent.Output(display_name="denoised_output"),
                io.Latent.Output(display_name="stop_latent"),
            ]
        )

    @classmethod
    def execute(cls, noise, guider, sampler, sigmas, latent_image, stop_on=2) -> io.NodeOutput:
        latent = latent_image
        latent_image = latent["samples"]
        latent = latent.copy()
        latent_image = comfy.sample.fix_empty_latent_channels(guider.model_patcher, latent_image, latent.get("downscale_ratio_spacial", None), latent.get("downscale_ratio_temporal", None))
        latent["samples"] = latent_image

        noise_mask = None
        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"]

        key = _run_key(noise, sampler, guider, sigmas, latent)
        entry = _STASH.get(key)
        if entry is None:
            entry = cls._sample_pass(noise, guider, sampler, sigmas, latent, noise_mask)
            _store(key, entry)
            print(f"[LatentPick] sampled and stashed {len(entry['steps'])} step latents "
                  f"({entry['bytes'] / 2 ** 20:.1f} MB, seed {entry['seed']})")
        else:
            print(f"[LatentPick] stash hit ({len(entry['steps'])} step latents, seed {entry['seed']}): "
                  f"sampler skipped, re-picking stop_latent")

        steps = entry["steps"]
        stop_on = max(0, int(stop_on))
        if len(steps) > 0:
            index = min(stop_on, len(steps) - 1)
            stop_latent = _latent_from_x0(entry["denoised"], steps[index], entry["latent_shapes"],
                                          guider.model_patcher.model)
            print(f"[LatentPick] stop_latent = step {index} of {len(steps) - 1} (stop_on={stop_on})")
        else:
            stop_latent = entry["denoised"]

        # copies of the dicts, so a downstream node mutating the latent it gets back
        # (adding a noise_mask, say) cannot write into the stash
        return io.NodeOutput(dict(entry["out"]), dict(entry["denoised"]), stop_latent)

    @classmethod
    def _sample_pass(cls, noise, guider, sampler, sigmas, latent, noise_mask):
        total_steps = sigmas.shape[-1] - 1
        preview_callback = latent_preview.prepare_callback(guider.model_patcher, total_steps, {})

        steps = []

        def callback(step, x0, x, total_steps_cb):
            steps.append(_snapshot(x0))
            preview_callback(step, x0, x, total_steps_cb)

        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
        samples = guider.sample(noise.generate_noise(latent), latent["samples"], sampler, sigmas, denoise_mask=noise_mask, callback=callback, disable_pbar=disable_pbar, seed=noise.seed)
        samples = samples.to(comfy.model_management.intermediate_device())

        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = samples

        latent_shapes = None
        if getattr(samples, "is_nested", False):
            latent_shapes = [tuple(x.shape) for x in samples.unbind()]

        if len(steps) > 0:
            out_denoised = _latent_from_x0(latent, steps[-1], latent_shapes, guider.model_patcher.model)
        else:
            out_denoised = out

        return {
            "steps": steps,
            "out": out,
            "denoised": out_denoised,
            "latent_shapes": latent_shapes,
            "bytes": sum(_tensor_bytes(t) for t in steps),
            "seed": getattr(noise, "seed", -1),
        }
