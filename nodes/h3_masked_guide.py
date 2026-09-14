"""Add Masked Guide for MiniMax H3.

Fork of the core MiniMaxH3AddGuide (comfy_extras/nodes_minimax_h3.py) with the
mask-driven anchoring built on top of it, kept here for independent work:

- optional spatial/temporal mask over the image guide: 1 keeps the guide anchored,
  0 lets the model generate those regions freely (soft values = partial strength)
- mask_threshold binarizes the mask for a hard anchor edge
- per-row condition timesteps in the DiT (rides the core model cond_row_masks
  support in comfy/ldm/minimax/model.py)
- latent output composites the guide into the AV latent with a nested noise_mask,
  so the sampler hard-protects anchored regions (no flicker); connect it to the
  sampler instead of the empty latent
"""

import torch
import torch.nn.functional as F

import comfy.nested_tensor
import comfy.utils
import node_helpers
from comfy.ldm.minimax.model import FRAME_PER_TOKEN, FRAME_RESCALE
from comfy_api.latest import io


def _resize(image, width, height, crop):
    # image [B, H, W, C] -> [B, height, width, 3]
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


def _encode_ref_audio(audio_vae, audio):
    import torchaudio
    waveform = audio["waveform"]  # [B, C, L]
    sr = audio["sample_rate"]
    vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
    if sr != vae_sr:
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    z = audio_vae.encode(waveform[:1].movedim(1, -1))  # [1, 32, 2, T]
    return z, z.shape[-1]


def _frame_token_offsets(n):
    # token k of the H3 video latent covers FRAME_PER_TOKEN[k % 5] pixel frames
    offs = [0]
    for k in range(n):
        offs.append(offs[-1] + FRAME_PER_TOKEN[k % 5])
    return offs


def _guide_mask_rows(mask, guide_latent, width, height, threshold=0.5):
    """Pixel mask (1 = keep the guide) -> per-patch-row anchor strengths for a guide latent.

    The mask follows the guide frames center-crop resize, then max-pools straight onto
    the DiT 32x32px patch grid: a patch anchors when any of its pixels is masked, so
    the anchored region is the mask dilated to full patches (never shrunk or displaced).
    threshold >= 0 binarizes the mask after the resize for a hard anchor edge; below 0
    keeps it soft (gray values give partial guide strength). A single-frame mask applies
    to every frame of a guide clip; a multi-frame mask maps onto the clip by relative
    time (its last frame extends to the clip end)."""
    mask = mask.reshape(-1, mask.shape[-2], mask.shape[-1]).float()  # [Tm, H, W]
    mask = comfy.utils.common_upscale(mask.unsqueeze(1), width, height, "bilinear", "center")
    if threshold >= 0.0:
        mask = (mask > threshold).float()
    lat_h, lat_w = guide_latent.shape[3], guide_latent.shape[4]
    mask = F.adaptive_max_pool2d(mask, (lat_h // 2, lat_w // 2))  # [Tm, hp, wp]
    vt = guide_latent.shape[2]
    idx = (torch.arange(vt, dtype=torch.float32) * (mask.shape[0] / vt)).long().clamp(max=mask.shape[0] - 1)
    return mask[idx].reshape(-1).cpu()


def _anchor_guide_latent(latent, keyframe, resolved_frame_index):
    """Composite an anchored guide into the target video latent, marking it preserved.

    Anchored regions get noise_mask 1 - strength, so the sampler re-injects the guide
    content there every step (the latent-inpaint path) instead of relying on the model
    copying the pinned condition rows - that alone only steers, and flickers."""
    samples = latent["samples"]
    video, audio = samples.tensors
    z = keyframe["latent"]
    vt = z.shape[2]
    t_off = _frame_token_offsets(video.shape[2])
    g_off = _frame_token_offsets(vt)
    hp, wp = video.shape[3] // 2, video.shape[4] // 2
    strengths = keyframe["mask"].reshape(vt, hp, wp)  # per-patch anchor strengths

    video = video.clone()
    noise_mask = torch.ones(video.shape[2], video.shape[3], video.shape[4], dtype=torch.float32)
    for j in range(vt):
        # guide token j covers pixel frames [g0, g1); pin it onto the maximally
        # overlapping target token (token grids only align on the 17k+5 frame grid)
        g0, g1 = resolved_frame_index + g_off[j], resolved_frame_index + g_off[j + 1]
        best_k, best_overlap = None, 0
        for k in range(len(t_off) - 1):
            overlap = min(g1, t_off[k + 1]) - max(g0, t_off[k])
            if overlap > best_overlap:
                best_overlap, best_k = overlap, k
        if best_k is None:
            continue
        s = strengths[j].repeat_interleave(2, 0).repeat_interleave(2, 1)  # [lat_h, lat_w]
        s = s.to(device=video.device, dtype=video.dtype)
        video[0, :, best_k] = s * z[0, :, j].to(video.dtype) + (1.0 - s) * video[0, :, best_k]
        noise_mask[best_k] = torch.minimum(noise_mask[best_k], 1.0 - strengths[j].repeat_interleave(2, 0).repeat_interleave(2, 1))

    prev = latent.get("noise_mask", None)
    if prev is not None:  # chained guides: keep the most preserving value
        if getattr(prev, "is_nested", False):
            prev = prev.tensors[0]
        noise_mask = torch.minimum(noise_mask, prev.reshape(-1, *noise_mask.shape)[0].to(noise_mask.dtype))

    out = dict(latent)
    out["samples"] = comfy.nested_tensor.NestedTensor((video, audio))
    # AV latents carry a nested (video, audio) noise mask; the audio stream generates fully
    out["noise_mask"] = comfy.nested_tensor.NestedTensor(
        (noise_mask.unsqueeze(0).unsqueeze(0), torch.ones(1, 1, audio.shape[-1])))
    return out


class MiniMaxH3AddMaskedGuide(io.ComfyNode):
    """Anchor a masked image and/or audio guide at an arbitrary pixel frame of the target video."""

    DISPLAY_NAME = "Add Masked Guide for MiniMax H3"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxH3AddMaskedGuide",
            display_name="Add Masked Guide for MiniMax H3",
            category="QQ/conditioning/minimax",
            description="Anchor an image, a short clip, audio, or a clip with its soundtrack at any frame of a MiniMax H3 video, with an optional mask limiting where the guide applies. The latent output hard-protects masked regions; connect it to the sampler.",
            inputs=[
                io.Conditioning.Input("positive"),
                io.Vae.Input("vae", optional=True, tooltip="Video VAE, needed when an image is connected."),
                io.Vae.Input("audio_vae", optional=True, tooltip="Audio VAE, needed when an audio is connected."),
                io.Latent.Input("latent"),
                io.Image.Input("image", optional=True, tooltip="Image or video frames to anchor. Multi-frame batches are anchored as a clip and cropped down to the model valid clip lengths: 5, 22, 39... (17k + 5) frames. Batches shorter than 5 frames use only the first image."),
                io.Audio.Input("audio", optional=True,
                               tooltip="Soundtrack to anchor starting at the same frame index, cropped to the video remaining duration."),
                io.Int.Input("frame_idx", default=0, min=-9999, max=9999,
                             tooltip="Frame index to anchor the image or the clip first frame at. Negative values are counted from the end of the video."),
                io.Mask.Input("mask", optional=True,
                              tooltip="Mask over the image guide: 1 keeps the guide anchored, 0 lets the model generate those regions freely. A single-frame mask applies to every frame of a guide clip; a multi-frame mask maps onto the clip by relative time."),
                io.Float.Input("mask_threshold", default=0.5, min=-1.0, max=1.0, step=0.01, advanced=True,
                               tooltip="Binarize the mask above this value for a hard anchor edge (recommended: kills feathering at the mask border). Set below 0 to keep the mask soft, with gray values giving partial guide strength."),
            ],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Latent.Output()],
        )

    @classmethod
    def execute(cls, positive, latent, frame_idx, vae=None, audio_vae=None, image=None, audio=None,
                mask=None, mask_threshold=0.5) -> io.NodeOutput:
        samples = latent["samples"]
        if not samples.is_nested or len(samples.tensors) != 2 or samples.tensors[0].ndim != 5 or samples.tensors[0].shape[1] != 24:
            raise ValueError("MiniMaxH3AddMaskedGuide expects a MiniMax H3 AV latent")
        if image is None and audio is None:
            raise ValueError("MiniMaxH3AddMaskedGuide needs an image or an audio to anchor")
        if mask is not None and image is None:
            raise ValueError("the mask input applies to the image guide; connect an image")
        video = samples.tensors[0]
        height = video.shape[3] * 16
        width = video.shape[4] * 16
        frame_count = sum(FRAME_PER_TOKEN[k % 5] for k in range(video.shape[2]))

        guide_frames = 1
        if image is not None:
            if vae is None:
                raise ValueError("anchoring guide frames needs the vae input")
            guide_frames = image.shape[0]
            if guide_frames < 5:
                guide_frames = 1
            else:
                while guide_frames % 17 != 5:
                    guide_frames -= 1

        resolved_frame_index = frame_idx if frame_idx >= 0 else frame_count + frame_idx
        if resolved_frame_index < 0 or resolved_frame_index + guide_frames > frame_count:
            if guide_frames == 1:
                raise ValueError("frame_idx {} is outside the video {} frames".format(frame_idx, frame_count))
            raise ValueError("a {} frame guide clip at frame_idx {} does not fit in the video {} frames".format(
                guide_frames, frame_idx, frame_count))

        keyframe = {"resolved_frame_index": resolved_frame_index}
        if image is not None:
            frames = _resize(image[:guide_frames], width, height, "center")
            keyframe["latent"] = vae.encode(frames)
            if mask is not None:
                keyframe["mask"] = _guide_mask_rows(mask, keyframe["latent"], width, height, mask_threshold)

        if audio is not None:
            if audio_vae is None:
                raise ValueError("anchoring guide audio needs the audio_vae input")
            audio_latent, audio_rt = _encode_ref_audio(audio_vae, audio)
            # the streams share one time axis: FRAME_RESCALE per pixel frame, 1.0 per audio latent frame
            max_rt = int(samples.tensors[1].shape[-1] - FRAME_RESCALE * resolved_frame_index)
            if max_rt < 1:
                raise ValueError("frame_idx {} is past the end of the video audio track".format(frame_idx))
            if audio_rt > max_rt:
                audio_latent = audio_latent[..., :max_rt].clone()
            keyframe["audio_latent"] = audio_latent

        keyframes = list(positive[0][1].get("minimax_keyframes", []))
        keyframes.append(keyframe)
        positive = node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes})
        if mask is not None:
            # hard protection: the sampler re-injects the anchored guide content every
            # step via the latent noise_mask (connect this output to the sampler)
            latent = _anchor_guide_latent(latent, keyframe, resolved_frame_index)
        return io.NodeOutput(positive, latent)
