"""
Power Load Audio - audio loading node with frame-based crop, speed control,
and fps-based frame mapping (same trim/speed workflow as Power Load Video).

The speed change is pitch-preserving (ffmpeg atempo) and is baked into the
exported samples, while the in-node preview plays at the same rate so what
you hear matches what gets exported.
"""

import hashlib
import math
import os
import subprocess
import threading

import torch
import folder_paths
import comfy.model_management

from .power_load_video import (
    _find_ffmpeg,
    _to_float,
    _to_int,
    _abort_if_interrupted,
    _parse_audio_props,
)


def _atempo_chain(speed):
    """ffmpeg atempo filter chain for a speed factor (each stage must stay
    within [0.5, 2.0], so e.g. 4.0 becomes "atempo=2.0,atempo=2.0")."""
    factors = []
    s = float(speed)
    while s > 2.0 + 1e-9:
        factors.append(2.0)
        s /= 2.0
    while s < 0.5 - 1e-9:
        factors.append(0.5)
        s *= 2.0
    factors.append(max(0.01, s))
    return ",".join(f"atempo={f:.6f}" for f in factors)


def decode_audio(filename, start_time=0.0, duration=0.0, speed=1.0):
    """Decode audio to f32le PCM with an optional time crop and a baked
    pitch-preserving speed change.

    Args:
        filename: Path to the audio (or video) file.
        start_time: Crop start in seconds (0 = file start).
        duration: Crop length in seconds of SOURCE time (0 = until the end).
        speed: Playback speed factor (1.0 = untouched; 2.0 = twice as fast).

    Returns:
        dict: {"waveform": Tensor[1, C, T], "sample_rate": int} or None.
    """
    args = [_find_ffmpeg()]
    # Input options (-ss/-t before -i) trim the demuxed source range, so the
    # crop happens BEFORE the atempo filter and duration stays in source time.
    if start_time > 0:
        args += ["-ss", f"{start_time:.6f}"]
    if duration > 0:
        args += ["-t", f"{duration:.6f}"]
    args += ["-i", filename]
    chain = _atempo_chain(speed)
    if chain != "atempo=1.000000":
        args += ["-filter:a", chain]
    args += ["-f", "f32le", "-"]

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception:
        return None

    # Drain stderr in the background so the pipe can't fill up and stall ffmpeg
    err_holder = []

    def _drain(pipe, sink):
        try:
            for raw_line in iter(pipe.readline, b""):
                sink.append(raw_line.decode("utf-8", errors="replace"))
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain, args=(proc.stderr, err_holder), daemon=True)
    stderr_thread.start()

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
        proc.kill()
        proc.wait()
        raise

    if returncode != 0:
        return None

    try:
        audio = torch.frombuffer(bytearray(out), dtype=torch.float32)
        stderr_data = "".join(err_holder)
    except Exception:
        return None

    if audio.numel() == 0:
        return None

    sample_rate, channels = _parse_audio_props(stderr_data)
    if sample_rate <= 0:
        print("[SA-Nodes-QQ] Could not detect the audio sample rate; assuming 44100 Hz.")
        sample_rate = 44100
    if channels <= 0:
        print("[SA-Nodes-QQ] Could not detect the audio channel layout; assuming 2 channels.")
        channels = 2

    usable = (audio.numel() // channels) * channels
    if usable != audio.numel():
        audio = audio[:usable]

    audio = audio.reshape((-1, channels)).transpose(0, 1).unsqueeze(0)
    return {"waveform": audio, "sample_rate": sample_rate}


class PowerLoadAudio:
    """
    Loads an audio file with an integrated preview UI (waveform / dB / beats,
    scrubbable timeline, frame crop markers, speed control).

    Outputs:
        - AUDIO: Audio dict {"waveform": Tensor[1, C, T], "sample_rate": int}
        - frame_count (INT): length of the output audio in frames (at fps,
          after crop and speed are applied)
        - duration (FLOAT): length of the output audio in seconds
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        try:
            files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
            files = folder_paths.filter_files_content_types(files, ["audio"])
            files = sorted(files)
        except Exception:
            files = []
        return {
            "required": {},
            "optional": {
                "audio": (files, {"audio_upload": True}),
                "start_frame": ("INT", {"default": 1, "min": 1}),
                "end_frame": ("INT", {"default": -1, "min": -1}),
                "speed": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1}),
            },
        }

    RETURN_TYPES = ("AUDIO", "INT", "FLOAT")
    RETURN_NAMES = ("audio", "frame_count", "duration")
    FUNCTION = "load_audio"
    OUTPUT_NODE = True
    CATEGORY = "Power/Audio"
    DESCRIPTION = ("Load an audio file with preview UI: crop by frames, change speed "
                   "(pitch-preserving, baked into the export), and frame mapping via fps.")

    def load_audio(self, audio=None, start_frame=1, end_frame=-1, speed=1.0, fps=24.0):
        if not audio:
            raise ValueError("No audio file provided. Please use the Upload button or drag and drop an audio file onto this node.")

        fps = _to_float(fps, 24.0)
        if fps <= 0:
            fps = 24.0
        speed = _to_float(speed, 1.0)
        speed = min(4.0, max(0.25, speed))
        start_frame = max(1, _to_int(start_frame, 1))
        end_frame = _to_int(end_frame, -1)

        try:
            filename = folder_paths.get_annotated_filepath(audio)
        except Exception:
            input_dir = folder_paths.get_input_directory()
            filename = os.path.join(input_dir, audio)

        if not os.path.exists(filename):
            raise ValueError(f"Audio file not found: {filename}")

        # Crop is frame-based (same semantics as Power Load Video): frame N
        # covers source time (N-1)/fps .. N/fps.
        start_time = (start_frame - 1) / fps
        if end_frame is None or end_frame <= 0:
            duration = 0.0  # to the end of the file
        else:
            duration = max(0.05, (end_frame - start_frame + 1) / fps)

        result = decode_audio(filename, start_time=start_time, duration=duration, speed=speed)
        if result is None:
            raise ValueError(f"Could not decode audio file: {filename} (no audio stream, or the crop range is past the end of the file)")

        waveform = result["waveform"]
        sample_rate = result["sample_rate"]
        out_duration = waveform.shape[-1] / sample_rate
        frame_count = max(1, math.ceil(out_duration * fps - 1e-4))

        return ({"waveform": waveform, "sample_rate": sample_rate}, frame_count, out_duration)

    @classmethod
    def IS_CHANGED(s, audio=None, start_frame=1, end_frame=-1, speed=1.0, fps=24.0):
        if not audio:
            return 0
        try:
            path = folder_paths.get_annotated_filepath(audio)
            m = hashlib.sha256()
            with open(path, "rb") as f:
                m.update(f.read())
            m.update(str(_to_int(start_frame, 1)).encode())
            m.update(str(_to_int(end_frame, -1)).encode())
            m.update(f"{_to_float(speed, 1.0):.4f}".encode())
            m.update(f"{_to_float(fps, 24.0):.3f}".encode())
            return m.digest().hex()
        except Exception:
            return 0

    @classmethod
    def VALIDATE_INPUTS(s, audio=None):
        if not audio:
            return True
        try:
            if not folder_paths.exists_annotated_filepath(audio):
                return "Invalid audio file: {}".format(audio)
        except Exception:
            pass
        return True


# ============================ HTTP API: crop =================================
# POST /sa_audio/crop  {filename, start_time, end_time}
# Trims the selected input audio to the [ ] range and saves it as
# "<name>_crop.mp3" next to the original (in the input directory).

import asyncio

try:
    from aiohttp import web as _web
    from server import PromptServer as _PromptServer

    _audio_routes = _PromptServer.instance.routes

    @_audio_routes.post('/sa_audio/crop')
    async def sa_audio_crop(request):
        try:
            body = await request.json()
        except Exception:
            return _web.json_response({'error': 'invalid json'}, status=400)

        filename = os.path.basename(str(body.get('filename', '')).replace(chr(92), '/'))
        if not filename:
            return _web.json_response({'error': 'missing filename'}, status=400)
        try:
            start = max(0.0, float(body.get('start_time', 0.0)))
            end = float(body.get('end_time', 0.0))
        except (TypeError, ValueError):
            return _web.json_response({'error': 'invalid times'}, status=400)
        if end - start <= 0.01:
            return _web.json_response({'error': 'empty crop range'}, status=400)
        try:
            speed = min(4.0, max(0.25, float(body.get('speed', 1.0))))
        except (TypeError, ValueError):
            speed = 1.0

        in_dir = folder_paths.get_input_directory()
        in_path = os.path.join(in_dir, filename)
        if not os.path.isfile(in_path):
            return _web.json_response({'error': 'input file not found'}, status=404)

        base = os.path.splitext(filename)[0]
        if base.endswith('_crop'):
            base = base[:-5]  # keep re-cropping idempotent (no _crop_crop)
        out_name = f"{base}_crop.mp3"
        out_path = os.path.join(in_dir, out_name)

        args = [_find_ffmpeg(), '-y']
        # -ss/-t are input options: the crop happens in SOURCE time, before
        # the speed filter - same ordering as decode_audio()
        if start > 0:
            args += ["-ss", f"{start:.6f}"]
        args += ["-i", in_path, "-t", f"{end - start:.6f}"]
        chain = _atempo_chain(speed)
        if chain != "atempo=1.000000":
            args += ["-filter:a", chain]
        args += ["-vn", "-c:a", "libmp3lame", "-q:a", "2", out_path]

        def _run():
            return subprocess.run(args, capture_output=True, timeout=600)

        try:
            # run in an executor so the (blocking) encode never stalls the
            # server's event loop
            proc = await asyncio.get_event_loop().run_in_executor(None, _run)
            if proc.returncode != 0:
                err = proc.stderr.decode('utf-8', errors='replace')[-400:]
                return _web.json_response({'error': err}, status=500)
        except Exception as e:
            return _web.json_response({'error': str(e)}, status=500)

        return _web.json_response({'name': out_name})

except Exception as _route_err:
    print(f'[PowerLoadAudio] Crop HTTP route not registered: {_route_err}')
