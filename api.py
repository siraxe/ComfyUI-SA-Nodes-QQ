import base64
import json
import os
import sys
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

import cv2
import folder_paths
import subprocess
from aiohttp import web
from PIL import Image
from server import PromptServer

# Import SAM2 masker for point-click masking
from .nodes.sam2_masker import sam2_masker
from .nodes.prepare_refs import convert_mask_to_contour

# Constants
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
LORA_EXTENSIONS = {'.safetensors', '.ckpt', '.pt'}
PREVIEW_SUFFIXES = ["_01", "_02", "_03", "_thumb"]

# Endpoint prefix constant for consistency
API_PREFIX = "/wanvideowrapper_qq"


def _get_bg_folder_path() -> str:
    """Get the path to the bg folder where A.jpg and bg_image.png are stored."""
    current_dir = Path(__file__).parent
    bg_path = current_dir / "web" / "power_spline_editor" / "bg"
    bg_path.mkdir(parents=True, exist_ok=True)
    return str(bg_path)


def _get_ref_folder_path() -> str:
    """Get the path to the ref folder where reference images are stored."""
    current_dir = Path(__file__).parent
    ref_path = current_dir / "web" / "power_spline_editor" / "ref"
    ref_path.mkdir(parents=True, exist_ok=True)
    return str(ref_path)


def _decode_base64_image(image_data: str) -> Tuple[Image.Image, str]:
    if image_data.startswith('data:image'):
        header, encoded = image_data.split(',', 1)
        image_format = header.split('/')[1].split(';')[0]
    else:
        encoded = image_data
        # Try to infer format from data or default to png
        image_format = 'png'

    try:
        image_bytes = base64.b64decode(encoded)
        img = Image.open(BytesIO(image_bytes))
        img.verify()
        # Reopen after verification since verify() closes the file
        img = Image.open(BytesIO(image_bytes))
        return img, image_format
    except Exception as e:
        raise ValueError(f"Invalid image data: {e}")


def _save_image_with_format(img: Image.Image, filepath: str, image_format: Optional[str] = None) -> None:
    fmt = (image_format or "png").upper()
    save_kwargs = {}

    if fmt in ("JPG", "JPEG"):
        img = img.convert('RGB')
        fmt = "JPEG"
        save_kwargs["quality"] = 95
    else:
        # Preserve alpha if present
        if img.mode not in ("RGBA", "LA"):
            img = img.convert("RGBA")
        fmt = "PNG"

    img.save(filepath, format=fmt, **save_kwargs)


def _get_lora_full_path(lora_name: str) -> Optional[str]:
    try:
        lora_folders = folder_paths.get_folder_paths("loras")

        for folder in lora_folders:
            # Check exact name first
            lora_path = os.path.join(folder, lora_name)
            if os.path.exists(lora_path):
                return os.path.abspath(lora_path)

            # Check with common extensions if not provided
            if not any(lora_name.lower().endswith(ext) for ext in LORA_EXTENSIONS):
                for ext in LORA_EXTENSIONS:
                    lora_path_with_ext = os.path.join(folder, lora_name + ext)
                    if os.path.exists(lora_path_with_ext):
                        return os.path.abspath(lora_path_with_ext)

        return None
    except Exception as e:
        print(f"Error finding LoRA path: {e}")
        return None


def _rename_preview_files(old_base_name: str, new_name: str, preview_folder: str) -> List[str]:
    renamed_files = []

    try:
        # Rename JSON file
        old_json_path = os.path.join(preview_folder, f"{old_base_name}.json")
        new_json_path = os.path.join(preview_folder, f"{new_name}.json")
        if os.path.exists(old_json_path):
            try:
                os.rename(old_json_path, new_json_path)
                renamed_files.append(new_json_path)
                print(f"Renamed JSON: {old_json_path} -> {new_json_path}")
            except Exception as e:
                print(f"Warning: Failed to rename JSON file: {e}")

        # Rename preview images with suffixes
        for suffix in PREVIEW_SUFFIXES:
            for ext in IMAGE_EXTENSIONS:
                old_img_path = os.path.join(preview_folder, f"{old_base_name}{suffix}{ext}")
                new_img_path = os.path.join(preview_folder, f"{new_name}{suffix}{ext}")
                if os.path.exists(old_img_path):
                    try:
                        os.rename(old_img_path, new_img_path)
                        renamed_files.append(new_img_path)
                        print(f"Renamed image: {old_img_path} -> {new_img_path}")
                    except Exception as e:
                        print(f"Warning: Failed to rename image file: {e}")

        # Check for images without suffix (backward compatibility)
        for ext in IMAGE_EXTENSIONS:
            old_img_path = os.path.join(preview_folder, f"{old_base_name}{ext}")
            new_img_path = os.path.join(preview_folder, f"{new_name}{ext}")
            if os.path.exists(old_img_path):
                try:
                    os.rename(old_img_path, new_img_path)
                    renamed_files.append(new_img_path)
                    print(f"Renamed image: {old_img_path} -> {new_img_path}")
                except Exception as e:
                    print(f"Warning: Failed to rename image file: {e}")

    except Exception as e:
        print(f"Error in _rename_preview_files: {e}")

    return renamed_files


def _open_explorer(path: str, select_file: bool = True) -> Dict[str, Any]:
    if not sys.platform.startswith('win'):
        return {"error": "This feature is only available on Windows", "status": 400}

    try:
        if select_file and os.path.isfile(path):
            subprocess.run(['explorer', '/select,', path], check=True, shell=False)
            return {"success": True, "path": path}
        else:
            folder_path = path if os.path.isdir(path) else os.path.dirname(path)
            subprocess.run(['explorer', folder_path], check=True, shell=False)
            return {"success": True, "path": folder_path,
                   "message": "Opened folder instead of selecting file"}
    except subprocess.CalledProcessError as e:
        # Fallback: try opening just the directory
        try:
            if os.path.isfile(path):
                path = os.path.dirname(path)
            subprocess.run(['explorer', path], check=True, shell=False)
            return {"success": True, "path": path}
        except subprocess.CalledProcessError as e2:
            return {"error": f"Failed to open Explorer: {str(e2)}", "status": 500}


@PromptServer.instance.routes.post(f"{API_PREFIX}/save_ref_image")
async def save_ref_image(request) -> web.Response:
    try:
        post = await request.post()
        image_data = post.get("image")
        image_name = post.get("name", "bg_image.png")

        if not image_data:
            return web.json_response({"error": "No image data provided"}, status=400)

        # Derive filename safely
        safe_name = os.path.basename(image_name) or "bg_image.png"
        if "." not in safe_name:
            safe_name += ".png"

        # Decode and validate image
        try:
            img, image_format = _decode_base64_image(image_data)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)

        bg_folder = _get_bg_folder_path()
        ref_image_path = os.path.join(bg_folder, safe_name)

        # Save with appropriate format handling
        _save_image_with_format(img, ref_image_path, image_format)

        return web.json_response({"success": True, "path": ref_image_path,
                                  "message": "Reference image saved successfully"})

    except Exception as e:
        print(f"Error saving ref image: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post(f"{API_PREFIX}/save_prepare_refs_images")
async def save_prepare_refs_images(request) -> web.Response:
    try:
        data = await request.json()
        bg_image_data = data.get("bg_image")
        ref_images_data = data.get("ref_images", [])

        print(f"[API save_prepare_refs_images] === Received request ===")
        print(f"[API save_prepare_refs_images] bg_image present: {bg_image_data is not None}")
        print(f"[API save_prepare_refs_images] ref_images count: "
              f"{len(ref_images_data) if isinstance(ref_images_data, list) else 0}")

        saved_paths = {
            "bg_image_path": None,
            "ref_images_paths": []
        }

        ref_folder = _get_ref_folder_path()
        print(f"[API save_prepare_refs_images] Using ref folder: {ref_folder}")

        # Save background image to REF folder
        if bg_image_data:
            try:
                print(f"[API save_prepare_refs_images] Saving bg_image to REF folder...")
                img, _ = _decode_base64_image(bg_image_data)

                bg_image_path = os.path.join(ref_folder, "bg_image.png")
                img.save(bg_image_path, format="PNG")
                saved_paths["bg_image_path"] = "ref/bg_image.png"
                print(f"[API save_prepare_refs_images] ✓ Saved bg_image to {bg_image_path}")
            except Exception as e:
                print(f"[API save_prepare_refs_images] ERROR saving bg_image: {e}")
                import traceback
                traceback.print_exc()

        # Save ref images to ref folder
        if ref_images_data and isinstance(ref_images_data, list):
            for idx, ref_image_data in enumerate(ref_images_data):
                try:
                    print(f"[API save_prepare_refs_images] Saving ref_image {idx} to REF folder...")
                    img, _ = _decode_base64_image(ref_image_data)

                    ref_image_path = os.path.join(ref_folder, f"ref_image_{idx}.png")
                    img.save(ref_image_path, format="PNG")
                    saved_paths["ref_images_paths"].append(f"ref/ref_image_{idx}.png")
                    print(f"[API save_prepare_refs_images] ✓ Saved ref_image_{idx} to {ref_image_path}")
                except Exception as e:
                    print(f"[API save_prepare_refs_images] ERROR saving ref_image {idx}: {e}")
                    import traceback
                    traceback.print_exc()

        print(f"[API save_prepare_refs_images] === COMPLETE ===")
        print(f"[API save_prepare_refs_images] Saved bg_image: {saved_paths['bg_image_path']}")
        print(f"[API save_prepare_refs_images] Saved {len(saved_paths['ref_images_paths'])} ref images")

        return web.json_response({"success": True, "paths": saved_paths})

    except Exception as e:
        print(f"[API save_prepare_refs_images] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wanvideo_wrapper/open_explorer")
async def open_explorer_handler(request) -> web.Response:
    try:
        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        lora_name = data.get("lora_name") or post.get("lora_name")

        if not lora_name:
            return web.json_response({"error": "No LoRA name provided"}, status=400)

        lora_path = _get_lora_full_path(lora_name)

        if not lora_path:
            return web.json_response({"error": f"LoRA file not found: {lora_name}"}, status=404)

        result = _open_explorer(lora_path, select_file=True)

        if "error" in result:
            return web.json_response(result, status=result.get("status", 500))

        return web.json_response({"success": True, **result})

    except Exception as e:
        print(f"Error opening Explorer: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/power_load_video/open_input_dir")
async def open_input_dir(request) -> web.Response:
    try:
        if not sys.platform.startswith('win'):
            return web.json_response({"error": "This feature is only available on Windows"}, status=400)

        input_dir = folder_paths.get_input_directory()
        if not os.path.isdir(input_dir):
            return web.json_response({"error": f"Input directory not found: {input_dir}"}, status=404)

        subprocess.run(['explorer', input_dir], check=True, shell=False)
        return web.json_response({"success": True, "path": input_dir})
    except subprocess.CalledProcessError as e:
        return web.json_response({"error": f"Failed to open Explorer: {str(e)}"}, status=500)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/power_load_video/check_workflow")
async def check_video_workflow(request) -> web.Response:
    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "")

        input_dir = folder_paths.get_input_directory()
        file_path = os.path.join(input_dir, subfolder, filename) if subfolder else \
                    os.path.join(input_dir, filename)

        if not os.path.isfile(file_path):
            return web.json_response({"has_workflow": False})

        # Extract metadata via ffprobe/ffmpeg
        try:
            result = subprocess.run(
                ["ffprobe", "-show_format", "-print_format", "json", file_path],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                probe = json.loads(result.stdout)
                tags = probe.get("format", {}).get("tags", {})

                workflow = None
                # Check for 'workflow' tag (VHS VideoCombine)
                if "workflow" in tags:
                    try:
                        workflow = json.loads(tags["workflow"])
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Check for 'prompt' tag and reconstruct workflow
                if workflow is None and "prompt" in tags:
                    try:
                        prompt = json.loads(tags["prompt"])
                        workflow = {"prompt": prompt}
                    except (json.JSONDecodeError, TypeError):
                        pass

                if workflow is not None:
                    return web.json_response({"has_workflow": True, "workflow": workflow})
        except Exception:
            pass

        return web.json_response({"has_workflow": False})
    except Exception as e:
        return web.json_response({"has_workflow": False, "error": str(e)})


@PromptServer.instance.routes.post("/wanvideo_wrapper/get_lora_path")
async def get_lora_path(request) -> web.Response:
    try:
        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        lora_name = data.get("lora_name") or post.get("lora_name")

        if not lora_name:
            return web.json_response({"error": "No LoRA name provided"}, status=400)

        lora_path = _get_lora_full_path(lora_name)

        if not lora_path:
            return web.json_response({"error": f"LoRA file not found: {lora_name}"}, status=404)

        return web.json_response({"success": True, "path": lora_path})

    except Exception as e:
        print(f"Error getting LoRA path: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/wanvideo_wrapper/rename_lora")
async def rename_lora(request) -> web.Response:
    try:
        post = await request.post()
        data = await request.json() if request.content_type == 'application/json' else {}

        old_name = data.get("old_name") or post.get("old_name")
        new_name = data.get("new_name") or post.get("new_name")
        variant = data.get("variant") or post.get("variant", "high")

        if not old_name:
            return web.json_response({"error": "No old LoRA name provided"}, status=400)

        if not new_name:
            return web.json_response({"error": "No new LoRA name provided"}, status=400)

        old_lora_path = _get_lora_full_path(old_name)

        if not old_lora_path:
            return web.json_response({"error": f"LoRA file not found: {old_name}"}, status=404)

        lora_dir = os.path.dirname(old_lora_path)
        old_base_name = os.path.splitext(os.path.basename(old_lora_path))[0]
        lora_ext = os.path.splitext(old_lora_path)[1]

        new_lora_path = os.path.join(lora_dir, f"{new_name}{lora_ext}")

        if os.path.exists(new_lora_path):
            return web.json_response({"error": f"A file with the name '{new_name}{lora_ext}' already exists"}, status=409)

        try:
            os.rename(old_lora_path, new_lora_path)
            print(f"Renamed LoRA: {old_lora_path} -> {new_lora_path}")
        except Exception as e:
            return web.json_response({"error": f"Failed to rename LoRA file: {str(e)}"}, status=500)

        renamed_files = [new_lora_path]

        # Determine if this is a model or LoRA based on file path
        is_model = any(old_lora_path.startswith(folder)
                      for folder in folder_paths.get_folder_paths("checkpoints"))

        folder_type = "checkpoints" if is_model else "loras"
        folders_to_check = folder_paths.get_folder_paths(folder_type)

        for folder in folders_to_check:
            preview_folder = os.path.join(folder, "_power_preview")
            if os.path.exists(preview_folder):
                renamed_files.extend(_rename_preview_files(old_base_name, new_name, preview_folder))

        # Compute the ComfyUI-relative name (e.g. "subdir/name.safetensors") for
        # UI use - widgets store partial paths, not full filesystem paths.
        new_relative_path = new_lora_path
        for folder in folders_to_check:
            try:
                rel = os.path.relpath(new_lora_path, folder)
                if not rel.startswith('..'):
                    new_relative_path = rel.replace(os.sep, '/')
                    break
            except ValueError:
                # Different drive letters on Windows, skip this folder
                continue

        return web.json_response({
            "success": True,
            "message": f"Successfully renamed LoRA and {len(renamed_files)-1} associated files",
            "new_high_path": new_relative_path,
            "new_low_path": new_relative_path,  # For high variant, low path is the same
            "renamed_files": renamed_files
        })

    except Exception as e:
        print(f"Error renaming LoRA: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post(f"{API_PREFIX}/extract_first_frame")
async def extract_first_frame(request) -> web.Response:
    try:
        data = await request.json()
        video_path = data.get("video_path")

        if not video_path:
            return web.json_response({"success": False, "error": "No video path provided"}, status=400)

        print(f"[API extract_first_frame] Extracting first frame from: {video_path}")

        # Find the video file
        if os.path.exists(video_path):
            video_file_path = video_path
        else:
            input_folders = folder_paths.get_folder_paths("input")
            video_file_path = None
            for folder in input_folders:
                potential_path = os.path.join(folder, video_path)
                if os.path.exists(potential_path):
                    video_file_path = potential_path
                    break

        if not video_file_path:
            return web.json_response({"success": False, "error": f"Video file not found: {video_path}"}, status=404)

        print(f"[API extract_first_frame] Found video at: {video_file_path}")

        # Extract first frame using OpenCV with proper resource management
        cap = None
        try:
            cap = cv2.VideoCapture(video_file_path)

            if not cap.isOpened():
                return web.json_response({"success": False, "error": "Failed to open video file"}, status=500)

            ret, frame = cap.read()

            if not ret:
                return web.json_response({"success": False, "error": "Failed to read first frame from video"}, status=500)

            # Convert BGR to RGB
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            # Convert to PIL Image
            img = Image.fromarray(frame_rgb)

            # Convert to base64
            buffered = BytesIO()
            img.save(buffered, format="PNG")
            img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
            img_data_url = f"data:image/png;base64,{img_base64}"

            print(f"[API extract_first_frame] Successfully extracted first frame")

            return web.json_response({
                "success": True,
                "image": img_data_url
            })
        finally:
            if cap is not None and cap.isOpened():
                cap.release()

    except Exception as e:
        print(f"[API extract_first_frame] ERROR: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post(f"{API_PREFIX}/sam2_predict")
async def sam2_predict(request) -> web.Response:
    try:
        data = await request.json()

        if not data.get("image"):
            return web.json_response({"success": False, "error": "Missing image parameter"}, status=400)

        if not data.get("points") or len(data["points"]) == 0:
            return web.json_response({"success": False, "error": "Missing points parameter"}, status=400)

        # Decode base64 image
        img, _ = _decode_base64_image(data["image"])

        # Extract points
        points = data["points"]
        point_coords = [[p["x"], p["y"]] for p in points]
        point_labels = [p.get("label", 1) for p in points]  # Default to foreground

        # Predict mask using SAM2
        mask, score = sam2_masker.predict_from_points(img, point_coords, point_labels)

        # Convert mask to contour path
        path = convert_mask_to_contour(mask)

        return web.json_response({
            "success": True,
            "path": path,
            "score": score,
            "mask_shape": list(mask.shape) if hasattr(mask, 'shape') else None
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get(f"{API_PREFIX}/video_metadata")
async def get_video_metadata(request) -> web.Response:
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"success": False, "error": "Missing filename"}, status=400)

    try:
        filepath = folder_paths.get_annotated_filepath(filename)
    except Exception:
        input_dir = folder_paths.get_input_directory()
        filepath = os.path.join(input_dir, filename)

    if not os.path.exists(filepath):
        return web.json_response({"success": False, "error": "File not found"}, status=404)

    cap = None
    try:
        cap = cv2.VideoCapture(filepath)

        if not cap.isOpened():
            return web.json_response({"success": False, "error": "Failed to open video file"}, status=500)

        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if fps <= 0:
            fps = 24.0

        return web.json_response({
            "success": True,
            "fps": float(fps),
            "frame_count": frame_count,
            "width": width,
            "height": height,
        })
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)
    finally:
        if cap is not None and cap.isOpened():
            cap.release()
