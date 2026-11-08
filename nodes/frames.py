import torch


class H3Frames_cut:
    """
    Cuts a range of frames out of an image sequence.
    Keeps frames [start_from, cut_from) and [cut_to, end_at),
    effectively removing the frames between cut_from and cut_to.
    The widgets accept any frame (step 1), but cut_to is snapped
    at runtime to the closest multiple of 17 relative to cut_from,
    so the cut region is always n * 17 frames (at 24 fps that's
    ~0.7s of video per step).

    If an audio input is connected, the matching audio segment
    is cut out as well (using fps to map frames -> samples).

    Outputs the actual (snapped) number of removed frames as INT
    "cut_num" (always n * 17 unless clamped by end_at).
    """

    FPS = 24
    STEP = 17

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "start_from": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "cut_from": ("INT", {"default": 22, "min": 5, "max": 100000, "step": 1}),
                "cut_to": ("INT", {"default": 39, "min": 5, "max": 100000, "step": 1}),
                "end_at": ("INT", {"default": -1, "min": -1, "max": 100000, "step": 1}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 240, "step": 1}),
            },
            "optional": {
                "audio": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("image", "audio", "cut_num")
    FUNCTION = "cut_frames"
    CATEGORY = "WanVideoWrapper_QQ/video"

    def cut_frames(self, image, start_from, cut_from, cut_to, end_at, fps=24, audio=None):
        total_frames = image.shape[0]

        # Resolve end_at (-1 = last frame available, exclusive)
        if end_at < 0 or end_at > total_frames:
            end_at = total_frames

        # Clamp / sanitize
        start_from = max(0, min(start_from, total_frames))
        cut_from = max(start_from, min(cut_from, end_at))

        # Snap cut_to to the closest multiple of 17 relative to cut_from,
        # so the cut length is always n * 17 frames (minimum 17 = 1 step).
        raw_span = max(0, cut_to - cut_from)
        snapped_span = max(self.STEP, int(round(raw_span / self.STEP)) * self.STEP)
        cut_to = min(cut_from + snapped_span, end_at)
        # If end_at forced the cut shorter than one full step, keep at least one step
        # when there is room between cut_from and end_at, otherwise fall back to end_at.
        if cut_to - cut_from < self.STEP and end_at - cut_from >= self.STEP:
            cut_to = cut_from + self.STEP

        # Keep everything except the [cut_from, cut_to) range
        keep_parts = []
        if start_from < cut_from:
            keep_parts.append(image[start_from:cut_from])
        if cut_to < end_at:
            keep_parts.append(image[cut_to:end_at])

        if keep_parts:
            result_image = torch.cat(keep_parts, dim=0)
        else:
            # Everything was cut; return a single (black) frame so the node stays valid
            result_image = image[start_from:start_from + 1] * 0.0

        # Cut the matching audio segment if audio is connected
        result_audio = None
        if audio is not None:
            waveform = audio["waveform"]
            sample_rate = audio["sample_rate"]
            samples_per_frame = sample_rate / fps

            cut_start_sample = int(round(start_from * samples_per_frame))
            cut_mid_sample = int(round(cut_from * samples_per_frame))
            cut_end_sample = int(round(cut_to * samples_per_frame))
            cut_stop_sample = int(round(end_at * samples_per_frame))

            cut_start_sample = max(0, min(cut_start_sample, waveform.shape[-1]))
            cut_mid_sample = max(cut_start_sample, min(cut_mid_sample, waveform.shape[-1]))
            cut_end_sample = max(cut_mid_sample, min(cut_end_sample, waveform.shape[-1]))
            cut_stop_sample = max(cut_end_sample, min(cut_stop_sample, waveform.shape[-1]))

            audio_parts = []
            if cut_start_sample < cut_mid_sample:
                audio_parts.append(waveform[..., cut_start_sample:cut_mid_sample])
            if cut_end_sample < cut_stop_sample:
                audio_parts.append(waveform[..., cut_end_sample:cut_stop_sample])

            if audio_parts:
                result_waveform = torch.cat(audio_parts, dim=-1)
            else:
                # Everything was cut; return a tiny silent slice
                result_waveform = waveform[..., :1] * 0.0

            result_audio = {"waveform": result_waveform, "sample_rate": sample_rate}

        # Actual number of frames removed (after snapping / clamping)
        cut_num = int(cut_to - cut_from)

        return (result_image, result_audio, cut_num)


NODE_CLASS_MAPPINGS = {
    "H3Frames_cut": H3Frames_cut,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3Frames_cut": "H3 Frames Cut",
}
