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
from PIL import Image, ImageDraw, ImageFont
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


# --- Corner overlay labels (A/B stitched output) ---------------------------
# Text metrics scale with each video's resolution: size 16 and a (10, 8)
# corner offset are the reference for a 512x512 (~0.26 MP) video; larger
# videos scale both proportionally (sqrt of the pixel-count ratio) so the
# labels stay readable at any resolution.
_LABEL_BASE_SIZE = 16
_LABEL_REF_PIXELS = 512 * 512  # ~0.26 MP reference
_LABEL_BASE_OFFSET = (10, 8)   # x, y offset from the corner, at reference size
_FONT_CACHE = {}


def _label_font(size):
    """Arial at the requested size when available, else a sane fallback."""
    size = max(6, int(round(size)))
    if size not in _FONT_CACHE:
        font = None
        for candidate in (
            "arial.ttf",
            "Arial.ttf",
            r"C:\Windows\Fonts\arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "DejaVuSans.ttf",
        ):
            try:
                font = ImageFont.truetype(candidate, size)
                break
            except Exception:
                continue
        if font is None:
            try:
                font = ImageFont.load_default()
            except Exception:
                font = None
        _FONT_CACHE[size] = font
    return _FONT_CACHE[size]


def _label_scale(h, w):
    """Proportional scale factor for a region of h x w pixels."""
    return ((h * w) / _LABEL_REF_PIXELS) ** 0.5


def _draw_label_text(draw, text, x, y, size):
    """White text with a small black outline (top-left corner offsets)."""
    kwargs = {}
    font = _label_font(size)
    if font is not None:
        kwargs["font"] = font
    stroke = max(1, int(round(size / 10)))  # keep the outline thin
    try:
        draw.text((x, y), text, fill=(255, 255, 255),
                  stroke_width=stroke, stroke_fill=(0, 0, 0), **kwargs)
    except TypeError:  # older Pillow without stroke support
        draw.text((x, y), text, fill=(255, 255, 255), **kwargs)


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
        output_pick - "A" (default), "B", "A/B", or "B/A": which video the
                      images output returns. With images_b connected, B is
                      returned losslessly; without it, B is decoded back from
                      the cached previous-run frames. "A/B" / "B/A" return BOTH
                      videos stitched into a single video according to
                      ab_stitch ("A/B": A first - top/left; "B/A": B first).
        ab_stitch   - Stitch orientation for output_pick = "A/B":
                      "vertical" (default, A on top / B below) or
                      "horizontal" (A left / B right). The frontend keeps this
                      in sync with the compare mode buttons (right = horizontal,
                      slide/bottom = vertical).
        label_a / label_b - Optional overlay captions edited via the row's
                      "A:"/"B:" text fields (default empty = no overlay).
                      When set AND output_pick is "A/B"/"B/A", each text is
                      burned into the top-left corner of its video's region
                      in the stitched output: white fill, small black
                      outline, Arial (16px at a 512x512 ~ 0.26 MP video,
                      scaled proportionally with each video's resolution).
        start_frame / end_frame - Timeline crop range set by the [ ] markers
                      on the node's timeline (hidden widgets, synced by the
                      timeline UI). 1-based inclusive; 0 (default) = auto
                      (first / last frame). The images output is cropped to
                      this range. With differing A/B frame counts each video
                      crops to as much of the range as it has (the shorter
                      one just ends earlier).

    Outputs:
        images - IMAGE tensor of the picked video (A or B per output_pick),
                 cropped to the timeline [ ] marker range when set
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
                "output_pick": (["A", "B", "A/B", "B/A"], {"default": "A"}),
                "ab_stitch": (["vertical", "horizontal"], {"default": "vertical"}),
                "label_a": ("STRING", {"default": ""}),
                "label_b": ("STRING", {"default": ""}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "compare_video"
    OUTPUT_NODE = True
    CATEGORY = "Power/Video"
    DESCRIPTION = "Playback preview + A/B comparison for video frames. Feed an IMAGE sequence (e.g. PowerLoadVideo's image output); compare against the previous run or an images_b input, then output the picked video (A, B, or both stitched) cropped to the timeline's [ ] marker range when set."

    def compare_video(self, images, fps=24.0, images_b=None, output_pick="A", ab_stitch="vertical",
                      label_a="", label_b="", start_frame=0, end_frame=0, unique_id=None):
        # Type coercion (ComfyUI may pass an empty dict for untouched widgets)
        if isinstance(fps, dict):
            fps = 24.0
        try:
            fps = float(fps)
        except (TypeError, ValueError):
            fps = 24.0
        if fps <= 0:
            fps = 24.0

        def _as_int(v, default=0):
            if isinstance(v, dict):
                return default
            try:
                return int(v)
            except (TypeError, ValueError):
                return default

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
        #  - pick A/B: BOTH videos stitched into one video. Orientation is
        #    ab_stitch: "vertical" (A on top, B below - default) or
        #    "horizontal" (A left, B right). B (decoded from cache if needed)
        #    is rescaled to match A along the stitch axis, aspect preserved;
        #    if frame counts differ the shorter video repeats its last frame
        #    so both play to the end (same rule as the preview).
        #  - pick B/A: same stitched output with the videos swapped
        #    (B first: top in vertical, left in horizontal).
        pick = "A"
        if isinstance(output_pick, str):
            pick = output_pick.strip().upper()
        if pick not in ("A", "B", "A/B", "B/A"):
            pick = "A"
        horizontal = isinstance(ab_stitch, str) and ab_stitch.strip().lower() == "horizontal"

        def _decode_b_tensor():
            if images_b is not None:
                return images_b
            if results_b:
                arrays = []
                for ref in results_b:
                    p = os.path.join(temp_dir, ref["filename"])
                    with Image.open(p) as im:
                        arrays.append(np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0)
                return torch.from_numpy(np.stack(arrays, axis=0))
            return None

        def _resize_frames(t, h, w):
            if t.shape[1] == h and t.shape[2] == w:
                return t
            x = t.permute(0, 3, 1, 2).float()
            x = torch.nn.functional.interpolate(x, size=(h, w), mode="bilinear", align_corners=False)
            return x.permute(0, 2, 3, 1).clamp(0, 1)

        # Pixel size of the FIRST video's region in the stitched output
        # (width for horizontal, height for vertical) - used to place the
        # second label at the top-left of the second video's region.
        stitch_split = 0

        def _stitch(a, b):
            nonlocal stitch_split
            n = max(a.shape[0], b.shape[0])
            if a.shape[0] < n:
                a = torch.cat([a, a[-1:].repeat(n - a.shape[0], 1, 1, 1)], dim=0)
            if b.shape[0] < n:
                b = torch.cat([b, b[-1:].repeat(n - b.shape[0], 1, 1, 1)], dim=0)
            ah, aw = int(a.shape[1]), int(a.shape[2])
            bh, bw = int(b.shape[1]), int(b.shape[2])
            if horizontal:
                if bh != ah:
                    b = _resize_frames(b, ah, max(1, round(bw * ah / bh)))
                stitch_split = aw
                return torch.cat([a, b], dim=2)
            if bw != aw:
                b = _resize_frames(b, max(1, round(bh * aw / bw)), aw)
            stitch_split = ah
            return torch.cat([a, b], dim=1)

        def _clean_label(v):
            return v.strip() if isinstance(v, str) and v.strip() else None

        def _burn_stitch_labels(t, first_text, second_text, split):
            """Burn corner labels into the stitched frames.

            first_text goes at the top-left of the whole output (first
            video's region), second_text at the top-left of the second
            video's region (below the split for vertical, right of it for
            horizontal). White fill, small black outline, Arial. Size and
            corner offset scale with each video's own resolution (16px /
            (10,8)px at 512x512 ~ 0.26 MP, proportional beyond that).
            """
            if t is None or t.dim() != 4 or t.shape[0] == 0:
                return t
            h, w = int(t.shape[1]), int(t.shape[2])
            # Each label scales with ITS OWN video's region size
            if horizontal:
                regions = [(h, split), (h, w - split)]
            else:
                regions = [(split, w), (h - split, w)]
            labels = []
            for (rh, rw), text in zip(regions, (first_text, second_text)):
                if not text:
                    labels.append(None)
                    continue
                s = _label_scale(rh, rw)
                labels.append({
                    "text": text,
                    "size": _LABEL_BASE_SIZE * s,
                    "off_x": round(_LABEL_BASE_OFFSET[0] * s),
                    "off_y": round(_LABEL_BASE_OFFSET[1] * s),
                    "region_w": rw,
                })
            arrs = (t.float().clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
            out = []
            for i in range(arrs.shape[0]):
                img = Image.fromarray(arrs[i])
                draw = ImageDraw.Draw(img)
                for j, lab in enumerate(labels):
                    if lab is None:
                        continue
                    x = lab["off_x"] + (lab["region_w"] if (j == 1 and horizontal) else 0)
                    y = lab["off_y"] + (split if (j == 1 and not horizontal) else 0)
                    _draw_label_text(draw, lab["text"], x, y, lab["size"])
                out.append(torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0))
            return torch.stack(out, dim=0)

        # --- Timeline crop ([ ] markers) -----------------------------------
        # start_frame/end_frame come from the timeline's [ ] markers
        # (1-based, inclusive; 0/invalid = auto -> first / last frame).
        # Each video is cropped to as much of the range as it has, so with
        # differing A/B frame counts the shorter one simply ends earlier.
        s_marker = _as_int(start_frame)
        e_marker = _as_int(end_frame)

        def _crop_tensor(t):
            if t is None or t.dim() != 4 or t.shape[0] == 0:
                return t
            n = int(t.shape[0])
            s = 1 if s_marker <= 0 else max(1, min(s_marker, n))
            e = n if e_marker <= 0 else max(s, min(e_marker, n))
            if s == 1 and e == n:
                return t
            return t[s - 1:e]

        out_tensor = _crop_tensor(images)
        if pick == "B":
            b_tensor = _crop_tensor(_decode_b_tensor())
            if b_tensor is not None:
                out_tensor = b_tensor
        elif pick in ("A/B", "B/A"):
            a_tensor = _crop_tensor(images)
            b_tensor = _crop_tensor(_decode_b_tensor())
            if b_tensor is not None:
                stitched = _stitch(a_tensor, b_tensor) if pick == "A/B" else _stitch(b_tensor, a_tensor)
                # Corner overlay labels (only for the stitched A/B output,
                # only for labels the user actually typed)
                label_a_txt = _clean_label(label_a)
                label_b_txt = _clean_label(label_b)
                if label_a_txt or label_b_txt:
                    first_text = label_b_txt if pick == "B/A" else label_a_txt
                    second_text = label_a_txt if pick == "B/A" else label_b_txt
                    stitched = _burn_stitch_labels(stitched, first_text, second_text, stitch_split)
                out_tensor = stitched

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
