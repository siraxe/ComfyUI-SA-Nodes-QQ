import math

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    import folder_paths
    import comfy.utils
    import comfy.model_patcher
    from comfy import model_management
    from comfy_extras.frame_interpolation_models.ifnet import IFNet, detect_rife_config

    HAS_RIFE = True
except ImportError:
    HAS_RIFE = False


# --- Legacy RIFE architecture (v4.5/4.6/4.7 layout, from ComfyUI-Frame-Interpolation rife_arch.py) ---
# Supports checkpoints like rife45/46/47/48/49.pth (4 blocks + optional encode head),
# which ComfyUI core's IFNet (5-block) cannot load.

_WARP_GRIDS = {}


def _warp_legacy(img, flow):
    B, _, H, W = img.shape
    key = (H, W, str(flow.device))
    if key not in _WARP_GRIDS:
        tenHorizontal = (
            torch.linspace(-1.0, 1.0, W, device=flow.device, dtype=torch.float32)
            .view(1, 1, 1, W)
            .expand(B, -1, H, -1)
        )
        tenVertical = (
            torch.linspace(-1.0, 1.0, H, device=flow.device, dtype=torch.float32)
            .view(1, 1, H, 1)
            .expand(B, -1, -1, W)
        )
        _WARP_GRIDS.clear()  # keep only current resolution
        _WARP_GRIDS[key] = torch.cat([tenHorizontal, tenVertical], 1)
    flow = torch.cat(
        [
            flow[:, 0:1] / ((W - 1.0) / 2.0),
            flow[:, 1:2] / ((H - 1.0) / 2.0),
        ],
        1,
    )
    g = (_WARP_GRIDS[key][:B] + flow).permute(0, 2, 3, 1)
    return F.grid_sample(
        input=img.float(),
        grid=g.float(),
        mode="bilinear",
        padding_mode="border",
        align_corners=True,
    ).to(img.dtype)


class _ResConv(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.conv = nn.Conv2d(c, c, 3, 1, 1)
        self.beta = nn.Parameter(torch.ones((1, c, 1, 1)))
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        return self.relu(self.conv(x) * self.beta + x)


class _IFBlockLegacy(nn.Module):
    def __init__(self, in_planes, c=64, last_k=6):
        super().__init__()
        self.conv0 = nn.Sequential(
            nn.Sequential(nn.Conv2d(in_planes, c // 2, 3, 2, 1), nn.LeakyReLU(0.2, True)),
            nn.Sequential(nn.Conv2d(c // 2, c, 3, 2, 1), nn.LeakyReLU(0.2, True)),
        )
        self.convblock = nn.Sequential(*(_ResConv(c) for _ in range(8)))
        self.lastconv = nn.Sequential(
            nn.ConvTranspose2d(c, 4 * last_k, 4, 2, 1), nn.PixelShuffle(2)
        )

    def forward(self, x, flow=None, scale=1):
        x = F.interpolate(x, scale_factor=1.0 / scale, mode="bilinear", align_corners=False)
        if flow is not None:
            flow = (
                F.interpolate(flow, scale_factor=1.0 / scale, mode="bilinear", align_corners=False)
                * 1.0 / scale
            )
            x = torch.cat((x, flow), 1)
        feat = self.convblock(self.conv0(x))
        tmp = F.interpolate(self.lastconv(feat), scale_factor=scale, mode="bilinear", align_corners=False)
        return tmp[:, :4] * scale, tmp[:, 4:5]


class _IFNetLegacy(nn.Module):
    """RIFE v4.6/4.7 IFNet (4 blocks). Pads input to a multiple of 64 internally."""

    def __init__(self, arch_ver="4.7"):
        super().__init__()
        self.arch_ver = arch_ver
        if arch_ver == "4.7":
            self.block0 = _IFBlockLegacy(7 + 8, c=192)
            self.block1 = _IFBlockLegacy(8 + 4 + 8, c=128)
            self.block2 = _IFBlockLegacy(8 + 4 + 8, c=96)
            self.block3 = _IFBlockLegacy(8 + 4 + 8, c=64)
            self.encode = nn.Sequential(
                nn.Conv2d(3, 16, 3, 2, 1), nn.ConvTranspose2d(16, 4, 4, 2, 1)
            )
        else:  # 4.6 (4.5 identical except lastconv kernel layout, auto-detected)
            self.block0 = _IFBlockLegacy(7, c=192)
            self.block1 = _IFBlockLegacy(8 + 4, c=128)
            self.block2 = _IFBlockLegacy(8 + 4, c=96)
            self.block3 = _IFBlockLegacy(8 + 4, c=64)

    def forward(self, img0, img1, timestep=0.5, scale_list=None, training=False, fastmode=True, ensemble=True):
        if scale_list is None:
            scale_list = [8, 4, 2, 1]
        img0 = torch.clamp(img0, 0, 1)
        img1 = torch.clamp(img1, 0, 1)

        n, c, h, w = img0.shape
        ph = ((h - 1) // 64 + 1) * 64
        pw = ((w - 1) // 64 + 1) * 64
        padding = (0, pw - w, 0, ph - h)
        img0 = F.pad(img0, padding)
        img1 = F.pad(img1, padding)
        x = torch.cat((img0, img1), 1)
        channel = x.shape[1] // 2
        img0 = x[:, :channel]
        img1 = x[:, channel:]
        if not torch.is_tensor(timestep):
            timestep = (x[:, :1].clone() * 0 + 1) * timestep
        else:
            timestep = timestep.repeat(1, 1, img0.shape[2], img0.shape[3])

        if self.arch_ver == "4.7":
            f0 = self.encode(img0[:, :3])
            f1 = self.encode(img1[:, :3])

        warped_img0 = img0
        warped_img1 = img1
        flow = None
        mask = None
        blocks = [self.block0, self.block1, self.block2, self.block3]

        for i in range(4):
            if flow is None:
                if self.arch_ver == "4.7":
                    flow, mask = blocks[i](
                        torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1),
                        None,
                        scale=scale_list[i],
                    )
                else:
                    flow, mask = blocks[i](
                        torch.cat((img0[:, :3], img1[:, :3], timestep), 1),
                        None,
                        scale=scale_list[i],
                    )
                if ensemble:
                    if self.arch_ver == "4.7":
                        f_, m_ = blocks[i](
                            torch.cat((img1[:, :3], img0[:, :3], f1, f0, 1 - timestep), 1),
                            None,
                            scale=scale_list[i],
                        )
                    else:
                        f_, m_ = blocks[i](
                            torch.cat((img1[:, :3], img0[:, :3], 1 - timestep), 1),
                            None,
                            scale=scale_list[i],
                        )
                    flow = (flow + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                    mask = (mask + (-m_)) / 2
            else:
                if self.arch_ver == "4.7":
                    fd, m0 = blocks[i](
                        torch.cat(
                            (
                                warped_img0[:, :3],
                                warped_img1[:, :3],
                                _warp_legacy(f0, flow[:, :2]),
                                _warp_legacy(f1, flow[:, 2:4]),
                                timestep,
                                mask,
                            ),
                            1,
                        ),
                        flow,
                        scale=scale_list[i],
                    )
                    flow = flow + fd
                    if ensemble:
                        wf0 = _warp_legacy(f0, flow[:, :2])
                        wf1 = _warp_legacy(f1, flow[:, 2:4])
                        f_, m_ = blocks[i](
                            torch.cat(
                                (
                                    warped_img1[:, :3],
                                    warped_img0[:, :3],
                                    wf1,
                                    wf0,
                                    1 - timestep,
                                    -mask,
                                ),
                                1,
                            ),
                            torch.cat((flow[:, 2:4], flow[:, :2]), 1),
                            scale=scale_list[i],
                        )
                        fd = (fd + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                        m0 = (m0 + (-m_)) / 2
                    mask = m0
                else:
                    fd, m0 = blocks[i](
                        torch.cat((warped_img0[:, :3], warped_img1[:, :3], timestep, mask), 1),
                        flow,
                        scale=scale_list[i],
                    )
                    if ensemble:
                        f_, m_ = blocks[i](
                            torch.cat((warped_img1[:, :3], warped_img0[:, :3], 1 - timestep, -mask), 1),
                            torch.cat((flow[:, 2:4], flow[:, :2]), 1),
                            scale=scale_list[i],
                        )
                        fd = (fd + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                        m0 = (m0 + (-m_)) / 2
                    flow = flow + fd
                    mask = mask + m0

            warped_img0 = _warp_legacy(img0, flow[:, :2])
            warped_img1 = _warp_legacy(img1, flow[:, 2:4])

        mask = torch.sigmoid(mask)
        merged = warped_img0 * mask + warped_img1 * (1 - mask)
        return merged[:, :, :h, :w]


# Legacy RIFE checkpoints (rife46-49.pth) -> architecture version
_RIFE_LEGACY_ARCH = {
    "rife46.pth": "4.6",
    "rife47.pth": "4.7",
    "rife48.pth": "4.7",
    "rife49.pth": "4.7",
}


class VideoStretchStartEnd:
    """
    Time-stretches the first (or last) N frames of a video, making the start/end
    of the video play slower.

    Default mode duplicates frames (freeze-ish stretch).
    Example: 120-frame video, frames=5, factor=2.0, apply_to_end=False
    - The first 5 frames are stretched to 10 frames (each frame duplicated twice)
    - Result: 125 frames total

    With use_rife=True the stretch region is interpolated with RIFE instead of
    frame duplication. factor is used as the RIFE multiplier (rounded up, e.g.
    1.5 -> 2), and afterwards frames are thrown out / resampled so the final
    frame count still matches round(frames * factor).

    With gradual_ease=True the stretch is no longer uniform: playback speed
    starts at 1/factor at the selected edge (start or end) and eases smoothly
    (smoothstep) back to 1.0 (normal speed) at the boundary with the untouched
    part of the video. Frames are kept dense near the edge and progressively
    thrown out towards the boundary, so the video appears to gradually ease
    in/out of slow motion instead of snapping back to full speed. The output
    region is correspondingly shorter than a full uniform stretch
    (~ (frames + frames/factor) / 2 frames). Audio is remapped with the same
    non-uniform curve so it slows down gradually as well and stays in sync.

    Audio (if provided) is stretched last, using linear interpolation on the
    matching sample range, keeping A/V in sync with the final frame count.
    """

    _rife_model_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "images": ("IMAGE",),
                "apply_to_end": ("BOOLEAN", {"default": False}),
                "frames": ("INT", {"default": 5, "min": 0, "max": 10000, "step": 1}),
                "factor": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 20.0, "step": 0.1}),
                "gradual_ease": ("BOOLEAN", {"default": False}),
                "use_rife": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "audio": ("AUDIO",),
            },
        }
        if HAS_RIFE:
            ckpts = folder_paths.get_filename_list("frame_interpolation")
            inputs["required"]["ckpt_name"] = (
                sorted(ckpts) if ckpts else [""],
            )
        else:
            inputs["required"]["ckpt_name"] = ([""],)
        return inputs

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "stretch_start_end"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def stretch_start_end(self, images, apply_to_end, frames, factor, gradual_ease, use_rife, ckpt_name, audio=None):
        total_frames = images.shape[0]

        # Clamp stretch region to available frames
        safe_frames = min(frames, total_frames)

        if safe_frames <= 0 or factor == 1.0 or total_frames == 0:
            # Nothing to do - pass through
            return (images, audio)

        # Gradual ease only makes sense when slowing down
        gradual = bool(gradual_ease) and factor > 1.0
        inv_f = 1.0 / factor

        if gradual:
            # Playback speed at the selected edge is 1/factor and eases
            # (smoothstep) back to 1.0 at the boundary with the untouched part.
            # Frames are kept dense near the edge and progressively thrown out
            # towards the boundary -> the video gradually returns to / eases
            # into normal speed. Mean speed over the region is v_mean, so the
            # region is shorter than a full uniform stretch.
            v_mean = inv_f + (1.0 - inv_f) * 0.5
            out_len = max(1, int(round((safe_frames - 1) / v_mean)) + 1)
        else:
            out_len = max(1, int(round(safe_frames * factor)))

        # Decide whether RIFE interpolation is applicable
        rife_mult = None
        if use_rife:
            if not HAS_RIFE:
                raise RuntimeError(
                    "use_rife is enabled but ComfyUI frame interpolation "
                    "(comfy_extras.frame_interpolation_models) is not available."
                )
            if safe_frames >= 2 and factor > 1.0:
                # factor serves as the RIFE multiplier, rounded up (1.5 -> 2);
                # +1 extra headroom in gradual mode since the edge is denser
                rife_mult = max(2, int(math.ceil(factor)) + (1 if gradual else 0))

        if apply_to_end:
            segment = images[-safe_frames:]
            rest = images[:-safe_frames]
        else:
            segment = images[:safe_frames]
            rest = images[safe_frames:]

        if rife_mult is not None:
            # RIFE works on 3-channel images
            if segment.shape[-1] > 3:
                segment = segment[..., :3]
                rest = rest[..., :3]
            # Interpolate with RIFE at the (rounded up) multiplier
            interp = self._rife_interpolate(
                segment, self._load_rife_model(ckpt_name), rife_mult
            )
            r = interp.shape[0]
            # Resample interpolated frames back to the exact target count,
            # throwing out the extra frames caused by rounding up the factor.
            # In gradual mode the resampling is non-uniform: frames are kept
            # dense near the selected edge and dropped progressively towards
            # the boundary.
            if gradual:
                src_idx = self._eased_gather_indices(out_len, r, inv_f, apply_to_end, interp.device)
            elif out_len == 1:
                src_idx = torch.tensor([0], device=interp.device)
            else:
                src_idx = (
                    torch.arange(out_len, device=interp.device, dtype=torch.float32)
                    * (r - 1) / (out_len - 1)
                ).round().long().clamp(max=r - 1)
            stretched = interp[src_idx].to(images.dtype)
        else:
            # Frame duplication indices (nearest neighbor over the stretch region)
            if gradual:
                idx = self._eased_gather_indices(out_len, safe_frames, inv_f, apply_to_end, images.device)
            else:
                idx = torch.clamp(
                    (torch.arange(out_len, device=images.device, dtype=torch.float32) / factor).long(),
                    max=safe_frames - 1,
                )
                # Guarantee the seam frame (segment's last frame) is kept even
                # when round(frames * factor) rounded down, so the transition
                # to the untouched part never skips a frame.
                idx[-1] = safe_frames - 1
            stretched = segment[idx]

        if apply_to_end:
            result_images = torch.cat([rest, stretched], dim=0)
        else:
            result_images = torch.cat([stretched, rest], dim=0)

        # --- Audio processing (keep in sync with the stretched region) ---
        result_audio = audio
        if audio is not None:
            waveform, sample_rate = self._extract_audio(audio)
            if waveform is not None:
                w = self._to_std_audio(waveform, torch.device("cpu"))
                total_samples = w.shape[0]

                if total_samples > 0:
                    samples_per_frame = total_samples / total_frames

                    if apply_to_end:
                        seg_samples = min(int(safe_frames * samples_per_frame), total_samples)
                        audio_segment = w[total_samples - seg_samples:]
                        audio_rest = w[: total_samples - seg_samples]
                    else:
                        seg_samples = min(int(safe_frames * samples_per_frame), total_samples)
                        audio_segment = w[:seg_samples]
                        audio_rest = w[seg_samples:]

                    target_samples = max(1, int(round(out_len * samples_per_frame)))
                    if gradual and seg_samples > 1:
                        # Non-uniform remap mirroring the video speed curve:
                        # audio is stretched the most at the selected edge and
                        # progressively less towards the boundary, so it slows
                        # down gradually and stays in sync with the frames.
                        stretched_audio = self._eased_resample_waveform(
                            audio_segment, target_samples, inv_f, apply_to_end
                        )
                    else:
                        stretched_audio = self._resample_waveform(audio_segment, target_samples)

                    if apply_to_end:
                        result_waveform = torch.cat([audio_rest, stretched_audio], dim=0)
                    else:
                        result_waveform = torch.cat([stretched_audio, audio_rest], dim=0)
                    result_audio = {
                        "waveform": result_waveform.t().unsqueeze(0),
                        "sample_rate": sample_rate,
                    }

        return (result_images, result_audio)

    # --- Gradual ease helpers ---

    @staticmethod
    def _eased_positions(count, inv_f, from_end):
        """
        Normalized [0..1] source positions for a gradual-ease stretch of
        `count` output samples/frames.

        Instantaneous playback speed is inv_f (= 1/factor) at the selected
        edge and eases to 1.0 (normal) at the boundary, using a smoothstep
        blend: v(t) = inv_f + (1 - inv_f) * smoothstep(t).
        The cumulative curve (integral of smoothstep is t^3 - t^4/2) is
        normalized so positions span exactly [0, 1].
        """
        t = torch.arange(count, dtype=torch.float32) / max(1, count - 1)
        v_mean = inv_f + (1.0 - inv_f) * 0.5
        cum = t * inv_f + (1.0 - inv_f) * (t.pow(3) - t.pow(4) * 0.5)
        norm = cum / v_mean
        if from_end:
            # Mirror so the slow part sits at the end of the region instead
            # of the start (output positions still run forward in time).
            norm = torch.flip(1.0 - norm, dims=[0])
        return norm

    def _eased_gather_indices(self, out_len, src_len, inv_f, from_end, device):
        """Frame gather indices into a src_len-long source implementing the
        gradual ease curve (kept dense at the edge, thinned towards the
        boundary)."""
        norm = self._eased_positions(out_len, inv_f, from_end)
        src_pos = norm * (src_len - 1)
        idx = src_pos.round().long().clamp_(0, src_len - 1)
        return idx.to(device)

    def _eased_resample_waveform(self, waveform, target_samples, inv_f, from_end):
        """Resample audio to target_samples using the gradual ease speed
        curve (linear interpolation between neighboring source samples),
        so the audio slows down / stretches gradually like the video."""
        seg_samples = waveform.shape[0]
        if target_samples <= 0:
            return torch.empty((0, waveform.shape[1]), device=waveform.device)
        if seg_samples == 1:
            return waveform[:1].expand(target_samples, -1)
        norm = self._eased_positions(target_samples, inv_f, from_end)
        src_pos = norm.to(waveform.device) * (seg_samples - 1)
        lo = src_pos.floor().long().clamp_(max=seg_samples - 1)
        hi = (lo + 1).clamp_(max=seg_samples - 1)
        frac = (src_pos - lo.float()).unsqueeze(-1)
        return waveform[lo] * (1.0 - frac) + waveform[hi] * frac

    # --- RIFE (functionality copied from ComfyUI core nodes_frame_interpolation) ---

    def _load_rife_model(self, ckpt_name):
        """Load and cache a RIFE checkpoint from the frame_interpolation folder.

        Supports two formats:
        - New ComfyUI core format (5-block IFNet with encode head) via comfy_extras
        - Legacy v4.6/4.7 format (4-block, e.g. rife46-49.pth) via embedded arch
        Returns {"type": "core", "patcher": ...} or {"type": "legacy", "model": ...}.
        """
        if ckpt_name in self._rife_model_cache:
            return self._rife_model_cache[ckpt_name]

        model_path = folder_paths.get_full_path_or_raise("frame_interpolation", ckpt_name)
        sd = comfy.utils.load_torch_file(model_path, safe_load=True)
        sd = comfy.utils.state_dict_prefix_replace(sd, {"module.": "", "flownet.": ""})

        if "encode.cnn3.weight" in sd:
            # --- New ComfyUI core IFNet format ---
            key_map = {}
            for k in sd:
                for i in range(5):
                    if k.startswith(f"block{i}."):
                        key_map[k] = f"blocks.{i}.{k[len(f'block{i}.'):]:}"
            if key_map:
                sd = {key_map.get(k, k): v for k, v in sd.items()}
            sd = {k: v for k, v in sd.items() if not k.startswith(("teacher.", "caltime."))}

            head_ch, channels = detect_rife_config(sd)
            model = IFNet(head_ch=head_ch, channels=channels)
            model.load_state_dict(sd)

            dtype = (
                torch.float16
                if model_management.should_use_fp16(model_management.get_torch_device())
                else torch.float32
            )
            model.eval().to(dtype)
            patcher = comfy.model_patcher.CoreModelPatcher(
                model,
                load_device=model_management.get_torch_device(),
                offload_device=model_management.unet_offload_device(),
            )
            info = {"type": "core", "patcher": patcher}
        elif "block0.conv0.0.0.weight" in sd:
            # --- Legacy RIFE v4.6/4.7 format (rife46-49.pth) ---
            arch_ver = _RIFE_LEGACY_ARCH.get(ckpt_name.lower())
            if arch_ver is None:
                # Fall back to auto-detection: encode head present -> 4.7
                arch_ver = "4.7" if "encode.0.weight" in sd else "4.6"
            model = _IFNetLegacy(arch_ver=arch_ver)
            model.load_state_dict(sd)
            model.eval()
            info = {"type": "legacy", "model": model}
        else:
            raise ValueError(
                f"Unrecognized RIFE model format for '{ckpt_name}'. "
                "Supported: ComfyUI core IFNet checkpoints and legacy rife46-49.pth."
            )

        self._rife_model_cache[ckpt_name] = info
        return info

    def _rife_interpolate(self, images, model_info, multiplier):
        """
        Interpolate an IMAGE tensor [B, H, W, C] by an integer multiplier using RIFE.
        Returns [B * (multiplier - 1) + 1, H, W, C].
        """
        num_frames = images.shape[0]
        if num_frames < 2 or multiplier < 2:
            return images

        if model_info["type"] == "core":
            return self._rife_interpolate_core(images, model_info["patcher"], multiplier)
        return self._rife_interpolate_legacy(images, model_info["model"], multiplier)

    def _rife_interpolate_core(self, images, patcher, multiplier):
        """New-format IFNet path (adapted from ComfyUI core FrameInterpolate, simplified)."""
        from comfy.ldm.common_dit import pad_to_patch_size

        device = patcher.load_device
        dtype = patcher.model_dtype()
        inference_model = patcher.model
        activation_mem = inference_model.memory_used_forward(images.shape, dtype)
        model_management.load_models_gpu([patcher], memory_required=activation_mem)
        align = getattr(inference_model, "pad_align", 1)
        H, W = images.shape[1], images.shape[2]

        def prepare_frame(idx):
            frame = images[idx:idx + 1].movedim(-1, 1).to(dtype=dtype, device=device)
            if align > 1:
                frame = pad_to_patch_size(frame, (align, align), padding_mode="reflect")
            return frame

        total_pairs = images.shape[0] - 1
        num_interp = multiplier - 1
        total_out_frames = total_pairs * multiplier + 1
        out_dtype = images.dtype
        out_device = images.device
        result = torch.empty((total_out_frames, 3, H, W), dtype=out_dtype, device=out_device)
        result[0] = images[0].movedim(-1, 0).to(out_dtype)
        out_idx = 1

        # Pre-compute timestep tensor on device (padded dimensions needed)
        sample = prepare_frame(0)
        pH, pW = sample.shape[2], sample.shape[3]
        t_values = [t / multiplier for t in range(1, multiplier)]
        ts_full = torch.tensor(t_values, device=device, dtype=dtype).reshape(num_interp, 1, 1, 1)
        ts_full = ts_full.expand(-1, 1, pH, pW)
        del sample

        batch = num_interp  # reduced on OOM and persists across pairs
        feat_cache = {}
        prev_frame = None

        for i in range(total_pairs):
            img0_single = prev_frame if prev_frame is not None else prepare_frame(i)
            img1_single = prepare_frame(i + 1)
            prev_frame = img1_single

            # Cache features: img1 of pair N becomes img0 of pair N+1
            feat_cache["img0"] = feat_cache.pop("next") if "next" in feat_cache else inference_model.extract_features(img0_single)
            feat_cache["img1"] = inference_model.extract_features(img1_single)
            feat_cache["next"] = feat_cache["img1"]

            j = 0
            while j < num_interp:
                b = min(batch, num_interp - j)
                try:
                    img0 = img0_single.expand(b, -1, -1, -1)
                    img1 = img1_single.expand(b, -1, -1, -1)
                    mids = inference_model(img0, img1, timestep=ts_full[j:j + b], cache=feat_cache)
                    result[out_idx:out_idx + b] = mids[:, :, :H, :W].to(out_dtype)
                    out_idx += b
                    j += b
                except model_management.OOM_EXCEPTION:
                    if batch <= 1:
                        raise
                    batch = max(1, batch // 2)
                    model_management.soft_empty_cache()

            result[out_idx] = images[i + 1].movedim(-1, 0).to(out_dtype)
            out_idx += 1

        # BCHW -> BHWC
        return result.movedim(1, -1).clamp_(0.0, 1.0)

    def _rife_interpolate_legacy(self, images, model, multiplier):
        """Legacy v4.6/4.7 IFNet path (model pads to /64 internally, runs in fp32)."""
        device = model_management.get_torch_device()
        model = model.to(device)

        total_pairs = images.shape[0] - 1
        num_interp = multiplier - 1
        total_out_frames = total_pairs * multiplier + 1
        H, W = images.shape[1], images.shape[2]
        out_dtype = images.dtype
        out_device = images.device
        result = torch.empty((total_out_frames, 3, H, W), dtype=out_dtype, device=out_device)
        result[0] = images[0].movedim(-1, 0).to(out_dtype)
        out_idx = 1

        t_values = [t / multiplier for t in range(1, multiplier)]
        batch = num_interp  # reduced on OOM and persists across pairs

        for i in range(total_pairs):
            img0_single = images[i:i + 1].movedim(-1, 1).to(dtype=torch.float32, device=device)
            img1_single = images[i + 1:i + 2].movedim(-1, 1).to(dtype=torch.float32, device=device)

            j = 0
            while j < num_interp:
                b = min(batch, num_interp - j)
                try:
                    img0 = img0_single.expand(b, -1, -1, -1)
                    img1 = img1_single.expand(b, -1, -1, -1)
                    ts = torch.tensor(t_values[j:j + b], device=device, dtype=torch.float32).view(b, 1, 1, 1)
                    mids = model(img0, img1, timestep=ts, training=False, fastmode=True, ensemble=True)
                    result[out_idx:out_idx + b] = mids.to(out_dtype)
                    out_idx += b
                    j += b
                except model_management.OOM_EXCEPTION:
                    if batch <= 1:
                        raise
                    batch = max(1, batch // 2)
                    model_management.soft_empty_cache()

            result[out_idx] = images[i + 1].movedim(-1, 0).to(out_dtype)
            out_idx += 1

        # BCHW -> BHWC
        return result.movedim(1, -1).clamp_(0.0, 1.0)

    def _extract_audio(self, audio):
        """Standardizes input that might be a dict, LazyAudioMap, or Tensor."""
        waveform = None
        sample_rate = 44100

        if hasattr(audio, "get"):  # Handle LazyAudioMap
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        elif isinstance(audio, dict):
            waveform = audio.get("waveform")
            sample_rate = audio.get("sample_rate", 44100)
        else:
            waveform = audio

        return waveform, sample_rate

    def _to_std_audio(self, w, device):
        """Convert audio to standard [samples, channels] tensor format."""
        if not isinstance(w, torch.Tensor):
            if hasattr(w, "numpy"):
                w = torch.from_numpy(w())
            else:
                w = torch.tensor(w, dtype=torch.float32)

        w = w.to(device)
        if w.ndim == 1:
            w = w.unsqueeze(-1)
        while w.ndim > 2:
            w = w.squeeze(0)
        # Ensure samples first, channels second
        if w.shape[0] < w.shape[1]:
            w = w.t()
        return w

    def _resample_waveform(self, waveform, target_samples):
        """Resample audio waveform to target sample count using linear interpolation."""
        if target_samples <= 0:
            return torch.empty((0, waveform.shape[1]), device=waveform.device)
        if waveform.shape[0] == 0:
            return torch.zeros((target_samples, waveform.shape[1]), device=waveform.device)
        w = waveform.t().unsqueeze(0)  # [1, channels, samples]
        resampled = F.interpolate(w, size=int(target_samples), mode="linear", align_corners=False)
        return resampled.squeeze(0).t()  # [samples, channels]


NODE_CLASS_MAPPINGS = {
    "VideoStretchStartEnd": VideoStretchStartEnd,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoStretchStartEnd": "Video Stretch Start/End",
}
