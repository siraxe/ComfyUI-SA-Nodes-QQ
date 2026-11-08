import json

import torch
import comfy.model_management

MAX_RESOLUTION = 8192


def _parse_curve(curve):
    """Parse the curve (JSON string or list) into a sorted list of [x, y] points.

    x is in 0..100 (position along the latent batch), y is in 0..1 (mask multiplier).
    """
    if isinstance(curve, (list, tuple)):
        points = curve
    else:
        try:
            points = json.loads(curve)
        except Exception:
            points = None
    pts = []
    for p in points or []:
        try:
            x = min(100.0, max(0.0, float(p[0])))
            y = min(1.0, max(0.0, float(p[1])))
        except Exception:
            continue
        pts.append([x, y])
    if len(pts) < 2:
        pts = [[0.0, 1.0], [100.0, 1.0]]
    pts.sort(key=lambda p: p[0])
    return pts


def _sample_curve(pts, xs):
    """Linearly interpolate the curve at positions ``xs`` (a float tensor).

    Values outside the curve range are clamped to the end values.
    """
    xp = torch.tensor([p[0] for p in pts], dtype=torch.float32)
    fp = torch.tensor([p[1] for p in pts], dtype=torch.float32)
    xs = xs.clamp(xp[0].item(), xp[-1].item())
    idx = (torch.searchsorted(xp, xs, right=True) - 1).clamp(0, len(xp) - 2)
    x0 = xp[idx]
    x1 = xp[idx + 1]
    f0 = fp[idx]
    f1 = fp[idx + 1]
    den = (x1 - x0)
    den = torch.where(den == 0, torch.ones_like(den), den)
    t = ((xs - x0) / den).clamp(0.0, 1.0)
    return f0 + (f1 - f0) * t


class LatentNoiseMaskWithCurve:
    """Same as Set Latent Noise Mask, but the mask is generated internally
    (Create Solid Mask style) and its strength per batch frame / video frame
    is controlled by a user-drawn 0-100 / 0.00-1.00 curve.

    The latent (batch frames or video temporal frames) is spread across
    X (0-100): frame i is evaluated at x = i / (n - 1) * 100.

    invert_curve OFF (direct):  strength = value * curve
    invert_curve ON (inverted): strength = value + (1 - value) * (1 - curve)
    """

    DISPLAY_NAME = "Latent Noise Mask with Curve (QQ)"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "samples": ("LATENT",),
                "curve": ("STRING", {"default": "[[0,1.0],[100,1.0]]"}),
                "value": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "width": ("INT", {"default": 512, "min": 1, "max": MAX_RESOLUTION, "step": 1}),
                "height": ("INT", {"default": 512, "min": 1, "max": MAX_RESOLUTION, "step": 1}),
                "invert_curve": ("BOOLEAN", {"default": False, "tooltip": "OFF (direct): strength = value * curve, so curve 0.00 = no masking (injection stops). ON (inverted): strength = value + (1 - value) * (1 - curve), so curve 0.00 = full mask strength (1.00) and curve 1.00 = the base value."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "set_mask"
    CATEGORY = "latent/inpaint"
    DESCRIPTION = (
        "Sets the latent noise mask like 'Set Latent Noise Mask', but builds a solid "
        "mask internally and modulates its strength per batch frame with an editable "
        "curve (X: 0-100 spread over the latent batch). The curve is inverted: "
        "curve 0.00 -> full mask strength (1.00), curve 1.00 -> the base value."
    )

    def set_mask(self, samples, curve, value, width, height, invert_curve=False):
        pts = _parse_curve(curve)
        latent = samples["samples"]

        device = comfy.model_management.intermediate_device()

        # For 5D video latents (B, C, T, H, W) spread the curve over the
        # temporal frames T, so every frame of the video gets its own strength.
        # For 4D image latents (B, C, H, W) spread it over the batch.
        is_video = latent.dim() == 5
        n = latent.shape[2] if is_video else latent.shape[0]

        # Spread the latent along X (0-100) and sample the curve per frame.
        xs = torch.linspace(0.0, 100.0, n, dtype=torch.float32)
        curve_vals = _sample_curve(pts, xs).to(device=device, dtype=torch.float32)

        if invert_curve:
            # Inverted: curve 0.0 -> full mask strength (1.0),
            # curve 1.0 -> the base value.
            strength = value + (1.0 - value) * (1.0 - curve_vals)
        else:
            # Direct: strength = value * curve,
            # so curve 0.0 -> 0.0 (no masking / injection stops).
            strength = value * curve_vals

        s = samples.copy()
        if is_video:
            m = strength.view(1, 1, n, 1, 1) * torch.ones(
                (1, 1, n, height, width), dtype=torch.float32, device=device
            )
            # Already 5D (1, 1, T, H, W) - reshape_mask maps it temporally.
            s["noise_mask"] = m
        else:
            m = strength.view(-1, 1, 1) * torch.ones(
                (1, height, width), dtype=torch.float32, device=device
            )
            s["noise_mask"] = m.reshape((-1, 1, m.shape[-2], m.shape[-1]))
        return (s,)
