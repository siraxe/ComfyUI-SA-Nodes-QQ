"""
Power Compare Video - playback preview node for IMAGE sequences.

Feed it video frames (e.g. the "image" output of PowerLoadVideo) and it
renders them in an in-node playback area with the same bottom timeline UI
as PowerLoadVideo (play/pause, scrubbing, [ ] loop-range markers).
"""

import os
import hashlib

import numpy as np
import torch
from PIL import Image
import folder_paths


def _frames_fingerprint(arrs):
    """Content hash of an [N,H,W,C] frame array (dtype + shape + raw bytes).

    Used to detect a re-run whose input frames are bit-identical to the
    previous run (e.g. ComfyUI served its cached outputs unchanged), so the
    on-disk cache can be left untouched instead of being overwritten.
    """
    h = hashlib.md5()
    h.update(str(arrs.dtype).encode())
    h.update(np.asarray(arrs.shape, dtype=np.int64).tobytes())
    for i in range(arrs.shape[0]):
        h.update(np.ascontiguousarray(arrs[i]).tobytes())
    return h.hexdigest()


class PowerCompareVideo:
    """
    Playback preview node: receives an IMAGE batch (video frames) and sends
    them to the client UI for timeline-based playback with a sliding A/B
    comparison (rgthree Image Comparer style).

    Inputs:
        images   - IMAGE tensor [frame_count, height, width, 3] (e.g. from PowerLoadVideo).
                   This is the CURRENT video (A, shown on the right of the slider).
        fps      - Playback FPS
        images_b - Optional second IMAGE sequence (B, shown on the left of the slider).
                   When connected it OVERRIDES the automatic previous-run cache.
                   When not connected, B = the previous run's frames (this node
                   keeps its last-run frames on disk, so each execution lets you
                   compare last vs new). If frame counts differ, playback uses the
                   longer count and the shorter video freezes on its last frame.
                   Re-run guard: if the incoming frames are bit-identical to the
                   previous run's input (e.g. upstream was fully cached), the
                   saved frames are left untouched - no promotion, no rewrite -
                   so B keeps pointing at the last genuinely DIFFERENT video.
        output_pick - "A" (default) or "B": which video the images output returns.
                      With images_b connected, B is returned losslessly; without it,
                      B is decoded back from the cached previous-run frames.

    Outputs:
        images - IMAGE tensor of the picked video (A or B per output_pick)
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                "fps": ("FLOAT", {"default": 24, "min": 1, "max": 120, "step": 1}),
                "images_b": ("IMAGE",),
                "output_pick": (["A", "B"], {"default": "A"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "compare_video"
    OUTPUT_NODE = True
    CATEGORY = "Power/Video"
    DESCRIPTION = "Playback preview + A/B comparison for video frames. Feed an IMAGE sequence (e.g. PowerLoadVideo's image output); compare against the previous run or an images_b input, then output the picked video."

    def compare_video(self, images, fps=24.0, images_b=None, output_pick="A", unique_id=None):
        # Type coercion (ComfyUI may pass an empty dict for untouched widgets)
        if isinstance(fps, dict):
            fps = 24.0
        try:
            fps = float(fps)
        except (TypeError, ValueError):
            fps = 24.0
        if fps <= 0:
            fps = 24.0

        def _to_numpy(t, name):
            tensor = t.cpu() if hasattr(t, "cpu") else t
            arr = tensor.numpy() if hasattr(tensor, "numpy") else np.asarray(tensor)
            if arr.ndim != 4 or arr.shape[0] == 0:
                raise ValueError(f"Expected IMAGE tensor [N,H,W,C] on {name}, got shape {tuple(arr.shape)}")
            return arr

        if images is None:
            raise ValueError("No frames received on the images input.")
        frames_a = _to_numpy(images, "images")
        frames_b = _to_numpy(images_b, "images_b") if images_b is not None else None

        # Frames are cached on disk (temp dir) and referenced via /view.
        # Per-node prefixes: _a_ = current run, _b_ = second video.
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        node_key = str(unique_id) if unique_id is not None else "shared"
        base = f"power_compare_{node_key}"
        a_prefix = base + "_a_"
        b_prefix = base + "_b_"

        def _remove_prefixed(prefix):
            try:
                for name in os.listdir(temp_dir):
                    if name.startswith(prefix):
                        try:
                            os.remove(os.path.join(temp_dir, name))
                        except OSError:
                            pass
            except OSError:
                pass

        def _save_frames(arrs, prefix):
            results = []
            for i in range(arrs.shape[0]):
                arr = np.clip(arrs[i] * 255.0, 0, 255).astype(np.uint8)
                name = f"{prefix}{i:05d}.jpg"
                Image.fromarray(arr).save(os.path.join(temp_dir, name), format="JPEG", quality=95)
                results.append({"filename": name, "subfolder": "", "type": "temp"})
            return results

        def _list_prefixed(prefix):
            # Zero-padded names, so lexicographic sort == frame order
            try:
                names = sorted(n for n in os.listdir(temp_dir) if n.startswith(prefix))
            except OSError:
                names = []
            return [{"filename": n, "subfolder": "", "type": "temp"} for n in names]

        # --- Same-input detection ------------------------------------------
        # A sidecar .hash file stores the previous run's input fingerprint.
        # If the incoming frames are bit-identical AND the cached a-frames
        # still exist (matching count), this is a re-run with unchanged
        # input: keep BOTH saved sets untouched (no promotion, no rewrite)
        # so B stays the last genuinely different video.
        hash_path = os.path.join(temp_dir, base + ".hash")
        try:
            with open(hash_path, "r") as f:
                stored_hash = f.read().strip()
        except OSError:
            stored_hash = ""

        existing_a = _list_prefixed(a_prefix)
        new_hash = _frames_fingerprint(frames_a)
        same_as_previous = (
            bool(stored_hash)
            and stored_hash == new_hash
            and len(existing_a) == frames_a.shape[0]
        )

        if same_as_previous:
            results_a = existing_a
            if frames_b is not None:
                # A unchanged but B is explicitly provided - refresh B only
                _remove_prefixed(b_prefix)
                results_b = _save_frames(frames_b, b_prefix)
            else:
                results_b = _list_prefixed(b_prefix)
        else:
            # Drop previous b frames - they get replaced this run
            _remove_prefixed(b_prefix)

            # Second video (B):
            #  - images_b connected -> rendered fresh from it (overrides the cache)
            #  - otherwise -> previous run's a-frames are PROMOTED to b (plain file
            #    renames, no re-encoding) so this run compares last vs new.
            if frames_b is not None:
                # B comes from the input: old a-frames won't be promoted, so drop
                # them now (keeps the a-set == exactly last run's frames)
                _remove_prefixed(a_prefix)
                results_b = _save_frames(frames_b, b_prefix)
            else:
                promoted = []
                try:
                    for name in os.listdir(temp_dir):
                        if name.startswith(a_prefix):
                            new_name = b_prefix + name[len(a_prefix):]
                            try:
                                os.replace(os.path.join(temp_dir, name), os.path.join(temp_dir, new_name))
                                promoted.append(new_name)
                            except OSError:
                                pass
                except OSError:
                    pass
                # Zero-padded names, so lexicographic sort == frame order
                promoted.sort()
                # Remove anything that failed to promote so a-set stays clean
                _remove_prefixed(a_prefix)
                results_b = [{"filename": n, "subfolder": "", "type": "temp"} for n in promoted]

            # Write the new a frames (always the current run's images)
            results_a = _save_frames(frames_a, a_prefix)

            # Remember this run's input for the next same-input check
            try:
                with open(hash_path, "w") as f:
                    f.write(new_hash)
            except OSError:
                pass

        # Resolve which video the images output returns.
        #  - pick A (default): the current run's frames, as received
        #  - pick B: the connected images_b tensor if present (lossless),
        #    otherwise decode the cached/promoted b JPEGs back to a tensor;
        #    falls back to A when no B exists (first run, no input)
        pick = "A"
        if isinstance(output_pick, str) and output_pick.upper() in ("A", "B"):
            pick = output_pick.upper()

        out_tensor = images
        if pick == "B":
            if images_b is not None:
                out_tensor = images_b
            elif results_b:
                arrays = []
                for ref in results_b:
                    p = os.path.join(temp_dir, ref["filename"])
                    with Image.open(p) as im:
                        arrays.append(np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0)
                out_tensor = torch.from_numpy(np.stack(arrays, axis=0))

        # NOTE: every ui value must be a list - the server iterates over each
        # value when merging ui outputs (scalars crash with 'float' not iterable)
        return {
            "ui": {
                "compare_frames": results_a,
                "compare_frames_b": results_b,
                "fps": [fps],
                "frame_count": [len(results_a)],
                "frame_count_b": [len(results_b)],
            },
            "result": (out_tensor,),
        }


# Node registration
NODE_CLASS_MAPPINGS = {
    "PowerCompareVideo": PowerCompareVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowerCompareVideo": "Power Compare Video",
}
