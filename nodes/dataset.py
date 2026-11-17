"""Dataset Pair Save (QQ)

Lets the user review a generated "before"/"after" pair and save it as a
dataset sample with one click.

Execution never writes into the output directory: the two current images are
written to ComfyUI's temp directory and returned to the frontend as UI
previews. The Save button in the node then calls /sa_dataset/save, which
copies the previews to:

    <directory>/<subdir>/<name>_0001.png          (after)
    <directory>/<subdir>/control/<name>_0001.png  (before)

The numeric suffix is picked by scanning the existing files (both the main
and the control folder) so an existing pair is never overwritten.
"""

import os
import re
import shutil
import threading
import uuid

import numpy as np
import folder_paths
from PIL import Image

from aiohttp import web
from server import PromptServer


SAVE_ROUTE = "/sa_dataset/save"

_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_SAVE_LOCK = threading.Lock()


def _sanitize_name(name):
    """Turn the user supplied name into a safe file name (without extension)."""
    name = os.path.basename(str(name or "").strip().replace("\\", "/"))
    if name.lower().endswith(".png"):
        name = name[:-4]
    name = _INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    return name or "image"


def _normalize_subdir_parts(subdir):
    """Split an optional sub folder into safe path components."""
    parts = []
    for part in str(subdir or "").replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError("subdir must not contain '..'")
        cleaned = _INVALID_FILENAME_CHARS.sub("_", part).strip(" .")
        if cleaned:
            parts.append(cleaned)
    return parts


def _resolve_base_directory(directory):
    """Resolve the directory widget to an absolute path.

    Empty -> ComfyUI output directory. Relative paths are resolved against
    the output directory. Missing folders are created when saving.
    """
    directory = str(directory or "").strip()
    if not directory:
        directory = folder_paths.get_output_directory()
    directory = os.path.expanduser(directory)
    if not os.path.isabs(directory):
        directory = os.path.join(folder_paths.get_output_directory(), directory)
    return os.path.abspath(directory)


def _is_within(root, path):
    try:
        root = os.path.abspath(root)
        path = os.path.abspath(path)
        return os.path.commonpath([root, path]) == root
    except ValueError:
        return False


def _resolve_temp_preview(info):
    """Resolve a UI image descriptor back to a file inside the temp folder."""
    if not isinstance(info, dict):
        raise ValueError("missing preview image info")
    if str(info.get("type", "temp")) != "temp":
        raise ValueError("only temp preview images can be saved")

    filename = os.path.basename(str(info.get("filename", "") or "").replace("\\", "/"))
    subfolder = str(info.get("subfolder", "") or "")
    temp_root = folder_paths.get_temp_directory()
    path = os.path.abspath(os.path.join(temp_root, subfolder, filename))

    if not filename or not _is_within(temp_root, path) or not os.path.isfile(path):
        raise ValueError("preview image not found")
    return path


def _next_index(folders, name):
    """Return the first free _NNNN suffix by scanning the target folders."""
    pattern = re.compile(rf"^{re.escape(name)}_(\d+)\.png$", re.IGNORECASE)
    max_index = 0
    for folder in folders:
        try:
            entries = os.listdir(folder)
        except FileNotFoundError:
            continue
        for entry in entries:
            match = pattern.match(entry)
            if match:
                max_index = max(max_index, int(match.group(1)))
    return max_index + 1


def _tensor_to_pil(image):
    """Convert a ComfyUI IMAGE tensor ([B,H,W,C], 0..1) to PIL."""
    if hasattr(image, "detach"):
        image = image.detach().cpu()
    if hasattr(image, "numpy"):
        image = image.numpy()

    arr = np.asarray(image)
    if arr.ndim == 4:
        arr = arr[0]  # first image of the batch
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    if arr.ndim != 3 or arr.shape[-1] not in (1, 3, 4):
        raise ValueError(f"unsupported image shape: {arr.shape}")
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)

    arr = np.clip(arr.astype(np.float32) * 255.0, 0, 255).astype(np.uint8)
    mode = "RGBA" if arr.shape[-1] == 4 else "RGB"
    return Image.fromarray(arr, mode=mode)


def _relative_display_path(path, base):
    try:
        return os.path.relpath(path, base).replace("\\", "/")
    except ValueError:
        return path.replace("\\", "/")


class DatasetPairSave:
    """Preview a before/after pair and save it into a dataset folder on demand.

    The node has no outputs: it is an OUTPUT_NODE, so the graph still runs it
    like a Save/Preview node, but nothing is written to the output folder
    until the Save button in the node's UI is pressed.
    """

    OUTPUT_NODE = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "preview_pair"
    CATEGORY = "WanVideoWrapper_QQ/dataset"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": ("STRING", {
                    "default": folder_paths.get_output_directory(),
                    "multiline": False,
                    "tooltip": "Base directory (defaults to ComfyUI's output folder). "
                               "Relative paths are resolved against the output folder.",
                }),
                "subdir": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Optional sub folder created inside 'directory'. "
                               "Leave empty to save directly in 'directory'; nested "
                               "paths like 'set_a/portraits' are allowed.",
                }),
                "name": ("STRING", {
                    "default": "image",
                    "multiline": False,
                    "tooltip": "Base file name. A _0001, _0002, ... suffix is added "
                               "automatically by scanning the target folders.",
                }),
                "before": ("IMAGE",),
                "after": ("IMAGE",),
            }
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always refresh the temp previews on every queue.
        return float("nan")

    def preview_pair(self, directory, subdir, name, before, after):
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        token = uuid.uuid4().hex[:12]
        before_info = self._write_preview(before, temp_dir, f"sa_dataset_{token}_before.png", "before")
        after_info = self._write_preview(after, temp_dir, f"sa_dataset_{token}_after.png", "after")

        return {"ui": {"dataset_images": [before_info, after_info]}}

    @staticmethod
    def _write_preview(image, temp_dir, filename, role):
        _tensor_to_pil(image).save(os.path.join(temp_dir, filename), format="PNG")
        return {
            "filename": filename,
            "subfolder": "",
            "type": "temp",
            "role": role,
        }


@PromptServer.instance.routes.post(SAVE_ROUTE)
async def sa_dataset_save(request):
    """Copy the last previewed before/after pair into the dataset folder.

    Request JSON:
        {
            "directory": "...",
            "subdir": "...",
            "name": "...",
            "before": {"filename": "...", "subfolder": "", "type": "temp"},
            "after":  {"filename": "...", "subfolder": "", "type": "temp"}
        }
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    try:
        before_src = _resolve_temp_preview(data.get("before"))
        after_src = _resolve_temp_preview(data.get("after"))

        base_dir = _resolve_base_directory(data.get("directory"))
        subdir_parts = _normalize_subdir_parts(data.get("subdir"))
        name = _sanitize_name(data.get("name"))

        out_dir = os.path.join(base_dir, *subdir_parts)
        control_dir = os.path.join(out_dir, "control")

        with _SAVE_LOCK:
            os.makedirs(out_dir, exist_ok=True)
            os.makedirs(control_dir, exist_ok=True)

            index = _next_index([out_dir, control_dir], name)
            while True:
                stem = f"{name}_{index:04d}"
                after_dst = os.path.join(out_dir, stem + ".png")
                before_dst = os.path.join(control_dir, stem + ".png")
                if not os.path.exists(after_dst) and not os.path.exists(before_dst):
                    break
                index += 1

            shutil.copyfile(before_src, before_dst)
            shutil.copyfile(after_src, after_dst)

        return web.json_response({
            "success": True,
            "name": stem,
            "index": index,
            "directory": base_dir,
            "after": _relative_display_path(after_dst, base_dir),
            "before": _relative_display_path(before_dst, base_dir),
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


NODE_CLASS_MAPPINGS = {
    "DatasetPairSave": DatasetPairSave,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DatasetPairSave": "Dataset Pair Save (QQ)",
}
