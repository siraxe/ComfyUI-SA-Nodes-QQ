"""
Power Load Video - A video loading node with drag-and-drop upload support
Similar to LoadImage but for videos, with an integrated timeline UI.
"""

import os
import re
import threading
import subprocess
import cv2
import numpy as np
from PIL import Image
import torch
import torch.nn.functional as F
import folder_paths
import comfy.model_management
from comfy.utils import ProgressBar


def _abort_if_interrupted():
    """Raise ComfyUI's InterruptProcessingException when the user stopped the run.

    ComfyUI's executor catches this and marks the run as interrupted instead
    of as an error, so long processing loops can poll it to become responsive
    to the Stop button.
    """
    comfy.model_management.throw_exception_if_processing_interrupted()


def _find_ffmpeg():
    """Find ffmpeg executable."""
    # Check common locations
    candidates = []
    for cmd in ["ffmpeg", "ffmpeg.exe"]:
        # Check PATH
        import shutil
        path = shutil.which(cmd)
        if path:
            candidates.append(path)
    # Check relative to ComfyUI
    for rel in ["ffmpeg", "ffmpeg.exe", "../ffmpeg", "../ffmpeg.exe"]:
        p = os.path.abspath(os.path.join(os.path.dirname(__file__), rel))
        if os.path.isfile(p):
            candidates.append(p)
    return candidates[0] if candidates else "ffmpeg"


def _to_float(val, default):
    """Coerce a value to float, handling dict and invalid types."""
    if isinstance(val, dict):
        return default
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val) if val else default
    except (ValueError, TypeError):
        return default


def _to_int(val, default):
    """Coerce a value to int, handling dict and invalid types."""
    if isinstance(val, dict) or isinstance(val, bool):
        return default
    if isinstance(val, (int, float)):
        return int(val)
    try:
        return int(val) if val else default
    except (ValueError, TypeError):
        return default


def _is_input_linked(prompt, unique_id, input_name):
    """Robustly check whether an input is connected to another node's output.

    In the raw ComfyUI prompt, linked inputs are stored as [from_node, slot]
    lists while unconnected widget values are plain scalars (or absent).
    Checking the raw prompt works regardless of what value a widget holds
    when unlinked (e.g. its default), so it is a reliable "is connected" test.
    """
    try:
        val = prompt[unique_id]["inputs"][input_name]
    except (TypeError, KeyError):
        return False
    if not isinstance(val, list) or len(val) != 2:
        return False
    # A link reference is [node_id, slot_index]
    return isinstance(val[1], int)


def _snap32(v):
    """Snap a dimension to the closest value divisible by 32 (min 32)."""
    return max(32, int(round(v / 32)) * 32)


def _resolve_target_size(target_w, target_h, cur_w, cur_h):
    """Fill in a missing side proportionally from the current aspect ratio,
    then snap both sides to dimensions divisible by 32."""
    if target_w > 0 and target_h > 0:
        pass
    elif target_w > 0:
        target_h = int(round(target_w * cur_h / cur_w))
    else:
        target_w = int(round(target_h * cur_w / cur_h))
    return _snap32(target_w), _snap32(target_h)


_LANCZOS_FALLBACK_WARNED = False


def _lanczos_scale(t, size):
    """Version/device-tolerant high-quality scale (expects NCHW tensor).

    Preference order:
      1. lanczos + antialias=True  -> new PyTorch (CPU & GPU; required there)
      2. lanczos                   -> older PyTorch on CUDA only
      3. bicubic + antialias=True  -> universal fallback (next-best quality,
                                       works on CPU in all versions)
    """
    global _LANCZOS_FALLBACK_WARNED
    try:
        return F.interpolate(t, size=size, mode="lanczos", antialias=True)
    except ValueError:
        pass  # old PyTorch rejects antialias for lanczos
    try:
        return F.interpolate(t, size=size, mode="lanczos")
    except (ValueError, NotImplementedError):
        # old PyTorch on CPU: lanczos not implemented at all
        if not _LANCZOS_FALLBACK_WARNED:
            print(f"[SA-Nodes-QQ] torch {torch.__version__} lacks lanczos support here; "
                  f"using bicubic (antialias) as fallback.")
            _LANCZOS_FALLBACK_WARNED = True
    return F.interpolate(t, size=size, mode="bicubic", antialias=True)


def _lanczos_cover(tensor, target_w, target_h):
    """LANCZOS-scale to COVER the target size (aspect ratio preserved, no
    stretching), then center-crop to the exact target dimensions."""
    cur_h, cur_w = tensor.shape[1], tensor.shape[2]
    if (target_w, target_h) == (cur_w, cur_h):
        return tensor
    scale = max(target_w / cur_w, target_h / cur_h)
    new_w = int(round(cur_w * scale))
    new_h = int(round(cur_h * scale))
    t = tensor.permute(0, 3, 1, 2)
    t = _lanczos_scale(t, (new_h, new_w))
    t = t.permute(0, 2, 3, 1).contiguous()
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return t[:, top:top + target_h, left:left + target_w, :]


def _lanczos_stretch(tensor, target_w, target_h):
    """LANCZOS-scale to the EXACT target size (stretch mode, no cropping)."""
    cur_h, cur_w = tensor.shape[1], tensor.shape[2]
    if (target_w, target_h) == (cur_w, cur_h):
        return tensor
    t = tensor.permute(0, 3, 1, 2)
    t = _lanczos_scale(t, (target_h, target_w))
    return t.permute(0, 2, 3, 1).contiguous()


def extract_audio(file_path, start_time=0, duration=0, pbar=None, pbar_base=0, pbar_units=0):
    """Extract audio from a video file using ffmpeg.

    Args:
        file_path: Path to the video file.
        start_time: Start time in seconds.
        duration: Duration in seconds (0 = until end).
        pbar: Optional comfy.utils.ProgressBar to report decoding progress.
            ffmpeg's -progress output is parsed from stderr and mapped onto
            pbar_units "units" starting at pbar_base (1 unit ~ 1 second of
            audio), so audio extraction can extend an existing progress bar.
        pbar_base: Progress value the audio phase starts from.
        pbar_units: How many progress units the audio phase spans.

    Returns:
        dict: {"waveform": Tensor[1, C, T], "sample_rate": int} or None.
    """
    ffmpeg_path = _find_ffmpeg()
    args = [ffmpeg_path, "-i", file_path]
    if start_time > 0:
        args += ["-ss", str(start_time)]
    if duration > 0:
        args += ["-t", str(duration)]
    # Machine-readable progress on stderr (interleaved with the normal log,
    # which the drain thread parses and also keeps for the sample-rate regex)
    if pbar is not None and pbar_units > 0:
        args += ["-progress", "pipe:2", "-nostats"]
    args += ["-f", "f32le", "-"]

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception:
        return None

    # Drain stderr in the background so the pipe can't fill up and stall
    # ffmpeg. Reads line-by-line so ffmpeg's -progress output can be parsed
    # live for the progress bar; the full text is still kept for the
    # end-of-run sample rate/layout parse.
    err_holder = []

    def _drain_stderr(pipe, sink, pbar=None, pbar_base=0, pbar_units=0):
        try:
            for raw_line in iter(pipe.readline, b""):
                line = raw_line.decode("utf-8", errors="replace")
                sink.append(line)
                if pbar is None or pbar_units <= 0:
                    continue
                # out_time_us= / out_time_ms= (both are microseconds in ffmpeg)
                if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                    try:
                        us = int(line.split("=", 1)[1].strip())
                    except ValueError:
                        continue
                    seconds = max(0, us / 1_000_000.0)
                    value = pbar_base + min(int(seconds), pbar_units)
                    # Do NOT pass a new total: the shared bar's total was set
                    # up front in load_video; update_absolute caps at it.
                    pbar.update_absolute(value)
        except Exception:
            pass

    stderr_thread = threading.Thread(
        target=_drain_stderr,
        args=(proc.stderr, err_holder),
        kwargs={"pbar": pbar, "pbar_base": pbar_base, "pbar_units": pbar_units},
        daemon=True,
    )
    stderr_thread.start()

    # Read stdout in the background while the main thread polls the ComfyUI
    # interrupt flag, so stopping the run kills ffmpeg immediately instead of
    # waiting for it to decode the entire audio track.
    out = bytearray()
    stdout_done = threading.Event()

    def _read_stdout():
        try:
            while True:
                chunk = proc.stdout.read(1 << 20)
                if not chunk:
                    break
                out.extend(chunk)
        except Exception:
            pass
        finally:
            stdout_done.set()

    stdout_thread = threading.Thread(target=_read_stdout, daemon=True)
    stdout_thread.start()

    try:
        while not stdout_done.wait(timeout=0.25):
            _abort_if_interrupted()
        stderr_thread.join(timeout=5.0)
        returncode = proc.wait(timeout=30.0)
    except BaseException:
        # Interrupted (or ffmpeg hung): kill the process and re-raise.
        proc.kill()
        proc.wait()
        raise

    if returncode != 0:
        return None

    try:
        audio = torch.frombuffer(bytearray(out), dtype=torch.float32)
        stderr_data = "".join(err_holder)
        match = re.search(r', (\d+) Hz, (\w+), ', stderr_data)
    except Exception:
        return None

    if match:
        sample_rate = int(match.group(1))
        ac = {"mono": 1, "stereo": 2}.get(match.group(2), 2)
    else:
        sample_rate = 44100
        ac = 2

    if audio.numel() == 0:
        return None

    audio = audio.reshape((-1, ac)).transpose(0, 1).unsqueeze(0)
    return {"waveform": audio, "sample_rate": sample_rate}


class PowerLoadVideo:
    """
    Loads a video file via drag-and-drop upload and outputs frames as IMAGE tensor.

    Outputs:
        - IMAGE: Tensor of shape [frame_count, height, width, 3]
        - AUDIO: Audio waveform dict {"waveform", "sample_rate"}
        - frame_count (INT): count of frames in the output
        - METADATA: Dict containing frame boundaries, fps settings, crop info, and final output dimensions
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        try:
            files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
            files = folder_paths.filter_files_content_types(files, ["video"])
            files = sorted(files)
        except Exception:
            files = []
        return {
            "required": {},
            "optional": {
                "video": (files, {"video_upload": True}),
                "start_frame": ("INT", {"default": 1, "min": 1}),
                "end_frame": ("INT", {"default": -1, "min": -1}),
                "force_fps": ("FLOAT", {"default": 0, "min": 0, "max": 60, "step": 1, "disable": 0}),
                "max_fps": ("FLOAT", {"default": 0, "min": 0, "step": 1}),
                "crop_enabled": ("BOOLEAN", {"default": False}),
                "crop_x": ("FLOAT", {"default": 0.5, "min": 0, "max": 1, "step": 0.01}),
                "crop_y": ("FLOAT", {"default": 0.5, "min": 0, "max": 1, "step": 0.01}),
                "crop_w": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1, "step": 0.01}),
                "crop_h": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1, "step": 0.01}),
                "width": ("INT", {"default": 0," min": 128, "step": 32, "forceInput": True}),
                "height": ("INT", {"default": 0," min": 128, "step": 32, "forceInput": True}),
                "high_size": ("FLOAT", {"default": 1.0, "step": 0.1, "forceInput": True}),
                "metadata": ("METADATA",),
            },
            # Hidden inputs: used to robustly detect whether high_size is
            # actually connected (linked inputs appear as [node, slot] in the raw prompt)
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "AUDIO", "INT", "METADATA")
    RETURN_NAMES = ("image", "high_images", "audio", "frame_count", "metadata")
    FUNCTION = "load_video"
    OUTPUT_NODE = True
    CATEGORY = "Power/Video"
    DESCRIPTION = "Load a video file via drag-and-drop. Outputs frames as IMAGE tensor, audio, frame count, and metadata."

    def load_video(self, video=None, start_frame=1, end_frame=-1, force_fps=0, max_fps=0, crop_enabled=False, crop_x=0.5, crop_y=0.5, crop_w=1.0, crop_h=1.0, width=None, height=None, high_size=1.0, metadata=None, prompt=None, unique_id=None):
        """
        Load video frames and audio from uploaded video file.

        Args:
            video: Video filename
            start_frame: First frame to load (1-based). Default 1 = first frame.
            end_frame: Last frame to load (1-based). Default -1 = last frame.
            force_fps: Force output FPS (0 = native). Same logic as VHS force_rate.
            max_fps: Maximum output frames (0 = disabled). Calculates required source frames
                    based on FPS conversion ratio. Ignores end_frame trim when set.
            width: Optional target output width (0/None = disabled). Applied after crop.
                    If only one of width/height is set, the other is computed proportionally.
                    Final size is snapped to the closest dimensions divisible by 32.
                    Frames are LANCZOS-scaled to cover the target (no stretching) and
                    center-cropped to it.
            height: Optional target output height (0/None = disabled). Same rules as width.
            high_size: Link-only (forceInput) FLOAT multiplier for the high-res output.
                     Active when ACTUALLY CONNECTED (or inherited from incoming
                     METADATA produced by a node with an active high_size - a
                     direct connection always wins) and at least one of
                     width/height is connected. high_images are produced at
                     width*high_size x height*high_size (32-divisible, cover +
                     center-crop when both sides given); the regular image output
                     then becomes an exact LANCZOS downscale (stretch mode) of
                     high_images to the base width/height target, so both outputs
                     stay pixel-aligned. When inactive, high_images simply
                     mirrors image and nothing else changes.
            metadata: Optional METADATA dict from another PowerLoadVideo or ChainEditVideo node.
                     If provided and contains crop info, will apply the same crop to this video.
                     If the source was resized via width/height inputs (resized=True),
                     applies the same resize so outputs match dimensions.
            prompt/unique_id: Hidden inputs (raw prompt + node id) used only to
                     detect whether high_size is connected.

        Returns:
            tuple: (IMAGE tensor, high IMAGE tensor, AUDIO dict, frame_count INT, metadata_dict)
        """

        # high_size inherited from upstream metadata (0 = none), plus the
        # source node's exact high-res output dimensions when available
        meta_high_size = 0.0
        meta_high_w = 0
        meta_high_h = 0

        # Extract crop settings from metadata if provided
        if metadata is not None and isinstance(metadata, dict):
            meta_crop_enabled = metadata.get("crop_enabled", False)
            if meta_crop_enabled:
                crop_x = metadata.get("crop_x", 0.5)
                crop_y = metadata.get("crop_y", 0.5)
                crop_w = metadata.get("crop_w", 1.0)
                crop_h = metadata.get("crop_h", 1.0)
                crop_enabled = True

            # Apply the same resize as the source node if it was resized via width/height inputs
            if metadata.get("resized", False):
                width = metadata.get("width") or 0
                height = metadata.get("height") or 0

            # Apply start_offset from metadata (adds to starting trim frame number)
            meta_start_offset = metadata.get("start_offset", 0)
            if meta_start_offset != 0:
                start_frame = start_frame + meta_start_offset

            # Inherit high-res scaling from the source node so chained nodes
            # produce matching high_images (a direct high_size connection on
            # this node always takes precedence over the inherited value)
            if metadata.get("high_resized", False):
                meta_high_size = _to_float(metadata.get("high_size", 0.0), 0.0)
                meta_high_w = _to_int(metadata.get("high_width", 0), 0)
                meta_high_h = _to_int(metadata.get("high_height", 0), 0)
        video_filename = video

        # Handle force_fps type coercion (ComfyUI may pass empty dict for optional params)
        if isinstance(force_fps, dict):
            force_fps = 0.0
        elif not isinstance(force_fps, (int, float)):
            try:
                force_fps = float(force_fps) if force_fps else 0.0
            except (ValueError, TypeError):
                force_fps = 0.0

        # Handle max_fps type coercion
        if isinstance(max_fps, dict):
            max_fps = 0.0
        elif not isinstance(max_fps, (int, float)):
            try:
                max_fps = float(max_fps) if max_fps else 0.0
            except (ValueError, TypeError):
                max_fps = 0.0

        # Handle crop parameter type coercion
        if isinstance(crop_enabled, dict):
            crop_enabled = False
        else:
            crop_enabled = bool(crop_enabled)
        crop_x = _to_float(crop_x, 0.5)
        crop_y = _to_float(crop_y, 0.5)
        crop_w = _to_float(crop_w, 1.0)
        crop_h = _to_float(crop_h, 1.0)

        if not video_filename:
            raise ValueError("No video file provided. Please use the Upload button or drag and drop a video onto this node.")

        # Get the actual file path
        try:
            filename = folder_paths.get_annotated_filepath(video_filename)
        except Exception:
            input_dir = folder_paths.get_input_directory()
            filename = os.path.join(input_dir, video_filename)

        if not os.path.exists(filename):
            raise ValueError(f"Video file not found: {filename}")

        # Open video with OpenCV
        cap = cv2.VideoCapture(filename)
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {filename}")

        # Get video properties
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        native_fps = cap.get(cv2.CAP_PROP_FPS)
        if native_fps <= 0:
            native_fps = 24.0

        # Calculate target FPS (same logic as VideoHelperSuite force_rate)
        if force_fps == 0:
            target_fps = native_fps
        else:
            target_fps = float(force_fps)

        # Convert 1-based frame numbers to 0-based index range
        first_idx = max(0, (start_frame or 1) - 1)

        # Calculate last_idx based on max_fps if set, otherwise use end_frame
        if max_fps > 0:
            # max_fps is the desired OUTPUT frame count after FPS conversion
            # Calculate required SOURCE frames: source_frames = ceil(max_fps * native_fps / target_fps)
            fps_ratio = native_fps / target_fps  # e.g., 30/25 = 1.2 means we need 1.2x more source frames
            required_source_frames = int(np.ceil(max_fps * fps_ratio))
            last_idx = min(first_idx + required_source_frames - 1, total_frames - 1)
        else:
            # Use end_frame trim as normal
            last_idx = (total_frames - 1) if (end_frame is None or end_frame <= 0) else min(end_frame - 1, total_frames - 1)

        # Check if we're using the full video (no trimming needed)
        full_video = (first_idx == 0) and (last_idx == total_frames - 1)

        # Read frames with force_fps logic (same as VideoHelperSuite)
        images = []

        # Single continuous progress bar (same mechanism VHS Video Combine
        # uses) spanning all three phases, with the total estimated UP FRONT so
        # the bar only ever moves forward 0 -> 100:
        #   phase 1: decoding source frames (1 unit per source frame)
        #   phase 2: converting frames to tensor (1 unit per frame)
        #   phase 3: extracting audio with ffmpeg (1 unit per second of audio)
        expected_source_frames = last_idx - first_idx + 1
        source_span = expected_source_frames / native_fps
        if force_fps == 0 or force_fps == native_fps:
            expected_output_frames = expected_source_frames
        else:
            expected_output_frames = int(np.ceil(source_span * target_fps))
        audio_units = max(1, int(np.ceil(source_span)))
        pbar_total = expected_source_frames + expected_output_frames + audio_units
        pbar = ProgressBar(pbar_total)

        try:
            if force_fps == 0 or force_fps == native_fps:
                # No FPS conversion needed - read normally
                if full_video:
                    while True:
                        _abort_if_interrupted()
                        ret, frame = cap.read()
                        if not ret:
                            break
                        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        images.append(Image.fromarray(frame))
                        pbar.update(1)
                else:
                    for frame_idx in range(first_idx, last_idx + 1):
                        _abort_if_interrupted()
                        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                        ret, frame = cap.read()
                        if ret:
                            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                            images.append(Image.fromarray(frame))
                        pbar.update(1)
            else:
                # Apply force_fps: skip or duplicate frames
                time_per_native_frame = 1.0 / native_fps
                time_per_target_frame = 1.0 / target_fps
                current_time = 0.0
                next_target_time = 0.0

                if full_video:
                    while True:
                        _abort_if_interrupted()
                        ret, frame = cap.read()
                        if not ret:
                            break
                        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                        # Add frames at target times (may duplicate or skip)
                        while next_target_time <= current_time:
                            images.append(frame.copy())
                            next_target_time += time_per_target_frame

                        current_time += time_per_native_frame
                        pbar.update(1)
                else:
                    for frame_idx in range(first_idx, last_idx + 1):
                        _abort_if_interrupted()
                        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                        ret, frame = cap.read()
                        if not ret:
                            break
                        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                        while next_target_time <= current_time:
                            images.append(frame.copy())
                            next_target_time += time_per_target_frame

                        current_time += time_per_native_frame
                        pbar.update(1)
        finally:
            cap.release()

        if not images:
            raise ValueError("No frames could be loaded from video")

        # Convert to tensor (second progress phase, same bar)
        _abort_if_interrupted()
        image_tensor = self.pil_totensor(images, pbar=pbar, pbar_base=expected_source_frames)

        # Apply crop if enabled
        if crop_enabled:
            h, w = image_tensor.shape[1], image_tensor.shape[2]
            left = max(0, int(round((crop_x - crop_w / 2) * w)))
            top = max(0, int(round((crop_y - crop_h / 2) * h)))
            right = min(w, int(round((crop_x + crop_w / 2) * w)))
            bottom = min(h, int(round((crop_y + crop_h / 2) * h)))
            if right > left and bottom > top:
                # Snap crop dimensions to multiples of 8 to avoid VHS padding warnings
                raw_w = right - left
                raw_h = bottom - top
                snapped_w = raw_w - (raw_w % 8)
                snapped_h = raw_h - (raw_h % 8)
                if snapped_w >= 8 and snapped_h >= 8:
                    # Re-center the adjusted crop within the original region
                    left = left + (raw_w - snapped_w) // 2
                    top = top + (raw_h - snapped_h) // 2
                    right = left + snapped_w
                    bottom = top + snapped_h
                image_tensor = image_tensor[:, top:bottom, left:right, :]

        # Apply width/height resize if provided (after crop, so both can work together)
        target_w = _to_int(width, 0)
        target_h = _to_int(height, 0)
        resized = False
        high_tensor = None

        # High-res dual output: active when high_size is actually connected to
        # this node (checked via the raw prompt, so an unlinked widget default
        # can never trigger it), OR inherited from upstream metadata (chained
        # PowerLoadVideo). A direct connection always wins over inheritance.
        # In either case at least one of width/height must be connected.
        local_high_linked = _is_input_linked(prompt, unique_id, "high_size")
        hs = _to_float(high_size, 0.0) if local_high_linked else meta_high_size

        high_active = hs > 0 and (target_w > 0 or target_h > 0)

        if high_active:
            cur_h, cur_w = image_tensor.shape[1], image_tensor.shape[2]
            if local_high_linked:
                # High-res target: base width/height multiplied by high_size.
                # Missing side (if only one of width/height is connected) is
                # computed proportionally from the current aspect ratio; both
                # sides snapped to 32.
                high_w = int(round(target_w * hs)) if target_w > 0 else 0
                high_h = int(round(target_h * hs)) if target_h > 0 else 0
                high_w, high_h = _resolve_target_size(high_w, high_h, cur_w, cur_h)
            elif meta_high_w > 0 and meta_high_h > 0:
                # Inherited: use the source node's exact high-res dimensions so
                # chained nodes always match (recomputing base*high_size could
                # diverge when only one side is connected, since each side is
                # snapped to 32 independently)
                high_w, high_h = meta_high_w, meta_high_h
            else:
                # Fallback for older metadata without stored high dimensions
                high_w = int(round(target_w * hs)) if target_w > 0 else 0
                high_h = int(round(target_h * hs)) if target_h > 0 else 0
                high_w, high_h = _resolve_target_size(high_w, high_h, cur_w, cur_h)
            # Cover-scale + center-crop (crop happens when both sides are supplied)
            high_tensor = _lanczos_cover(image_tensor, high_w, high_h)
            # Small output: exact LANCZOS scale of the high-res result down to the
            # base target (stretch mode, no crop, still 32-divisible) so that
            # image and high_images stay pixel-aligned.
            _abort_if_interrupted()
            small_w, small_h = _resolve_target_size(target_w, target_h, cur_w, cur_h)
            image_tensor = _lanczos_stretch(high_tensor, small_w, small_h)
            resized = True
        elif target_w > 0 or target_h > 0:
            # Normal single-output resize (high_size not connected)
            resized = True
            cur_h, cur_w = image_tensor.shape[1], image_tensor.shape[2]
            target_w, target_h = _resolve_target_size(target_w, target_h, cur_w, cur_h)
            # No stretching: LANCZOS-scale to COVER the target size (aspect ratio
            # preserved), then center-crop to the exact target dimensions.
            image_tensor = _lanczos_cover(image_tensor, target_w, target_h)

        # Extract audio (skip trimming if full video). The ffmpeg run is the
        # third phase of the same bar (1 unit ~ 1 second of audio).
        audio = None
        _abort_if_interrupted()
        audio_pbar_base = expected_source_frames + len(images)
        if full_video:
            audio = extract_audio(filename, start_time=0, duration=0,
                                  pbar=pbar, pbar_base=audio_pbar_base,
                                  pbar_units=audio_units)
        else:
            audio_start_time = first_idx / native_fps
            audio_duration = (last_idx - first_idx + 1) / native_fps
            audio = extract_audio(filename, audio_start_time, audio_duration,
                                  pbar=pbar, pbar_base=audio_pbar_base,
                                  pbar_units=audio_units)
        # Finish the bar (e.g. video has no audio stream, so ffmpeg produced
        # no -progress output at all)
        pbar.update_absolute(pbar.total)

        # Build metadata dict (note: start_offset is NOT included in output as it's a transient adjustment)
        video_metadata = {
            "start_frame": start_frame,
            "end_frame": end_frame if end_frame != -1 else total_frames,
            "max_fps": max_fps,
            "force_fps": force_fps,
            "native_fps": native_fps,
            "target_fps": target_fps,
            "total_frames": total_frames,
            "crop_enabled": crop_enabled,
            "crop_x": crop_x,
            "crop_y": crop_y,
            "crop_w": crop_w,
            "crop_h": crop_h,
            # Final output frame dimensions (after crop + optional resize)
            "width": image_tensor.shape[2],
            "height": image_tensor.shape[1],
            # True if this node was resized via width/height inputs - chained nodes
            # receiving this metadata will apply the same resize
            "resized": resized,
            # High-res dual output info - chained nodes receiving this metadata
            # will apply the same high_size scaling to their own high_images
            # (unless they have a direct high_size connection of their own).
            # The exact high dimensions are stored so chains match exactly.
            "high_resized": high_active,
            "high_size": hs if high_active else 0,
            "high_width": high_tensor.shape[2] if high_active else 0,
            "high_height": high_tensor.shape[1] if high_active else 0,
        }

        # high_images mirrors the regular image unless the high-res path was active
        return (image_tensor, high_tensor if high_active else image_tensor, audio, image_tensor.shape[0], video_metadata)

    def pil_totensor(self, images, pbar=None, pbar_base=0):
        """Convert list of PIL Images to PyTorch tensor [N, H, W, C] in [0, 1].

        If a pbar is given, each converted frame advances the shared bar
        (continuing from pbar_base). The total is NOT changed here - it was
        estimated up front in load_video so the bar stays monotonic 0 -> 100.
        """
        img_list = []
        if pbar is not None:
            pbar.update_absolute(pbar_base)
        for img in images:
            _abort_if_interrupted()
            np_img = np.array(img.copy(), dtype=np.float32) / 255.0
            img_list.append(np_img)
            if pbar is not None:
                pbar.update(1)
        stacked = np.stack(img_list, axis=0)
        return torch.from_numpy(stacked)

    @classmethod
    def IS_CHANGED(s, video=None, start_frame=1, end_frame=-1, force_fps=0, max_fps=0, crop_enabled=False, crop_x=0.5, crop_y=0.5, crop_w=1.0, crop_h=1.0, width=None, height=None, high_size=1.0, metadata=None, prompt=None, unique_id=None):
        if not video:
            return 0
        try:
            image_path = folder_paths.get_annotated_filepath(video)
            import hashlib
            m = hashlib.sha256()
            with open(image_path, 'rb') as f:
                m.update(f.read())
            # Handle force_fps type coercion (ComfyUI may pass empty dict for optional params)
            if isinstance(force_fps, dict):
                force_fps = 0.0
            elif not isinstance(force_fps, (int, float)):
                try:
                    force_fps = float(force_fps) if force_fps else 0.0
                except (ValueError, TypeError):
                    force_fps = 0.0
            # Handle max_fps type coercion
            if isinstance(max_fps, dict):
                max_fps = 0.0
            elif not isinstance(max_fps, (int, float)):
                try:
                    max_fps = float(max_fps) if max_fps else 0.0
                except (ValueError, TypeError):
                    max_fps = 0.0
            # Include force_fps and max_fps in hash so changing them triggers re-execution
            m.update(str(force_fps).encode())
            m.update(str(max_fps).encode())
            # Include crop params in hash so changing them triggers re-execution
            crop_x = _to_float(crop_x, 0.5)
            crop_y = _to_float(crop_y, 0.5)
            crop_w = _to_float(crop_w, 1.0)
            crop_h = _to_float(crop_h, 1.0)
            m.update(str(bool(crop_enabled)).encode())
            m.update(f"{crop_x:.4f}".encode())
            m.update(f"{crop_y:.4f}".encode())
            m.update(f"{crop_w:.4f}".encode())
            m.update(f"{crop_h:.4f}".encode())
            # Include width/height in hash so changing them triggers re-execution
            m.update(str(_to_int(width, 0)).encode())
            m.update(str(_to_int(height, 0)).encode())
            # Include high_size connection state + value so connecting/disconnecting
            # it or changing the multiplier triggers re-execution
            high_linked = _is_input_linked(prompt, unique_id, "high_size")
            m.update(str(high_linked).encode())
            if high_linked:
                m.update(f"{_to_float(high_size, 1.0):.6f}".encode())
            # Include metadata hash if provided
            if metadata is not None and isinstance(metadata, dict):
                m.update(str(tuple(sorted(metadata.items()))).encode())
            return m.digest().hex()
        except:
            return 0

    @classmethod
    def VALIDATE_INPUTS(s, video=None):
        if not video:
            return True
        try:
            if not folder_paths.exists_annotated_filepath(video):
                return "Invalid video file: {}".format(video)
        except:
            pass
        return True


# Node registration
NODE_CLASS_MAPPINGS = {
    "PowerLoadVideo": PowerLoadVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowerLoadVideo": "Power Load Video",
}
