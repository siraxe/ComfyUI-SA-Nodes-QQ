import os
import json
import hashlib

import torch
import torch.nn.functional as F
import numpy as np

from PIL import Image, ImageOps, ImageSequence

import comfy.model_management
from comfy.comfy_types import IO
from comfy_api.latest import InputImpl
import folder_paths
import node_helpers

class WanVideoMotionToFlowmap:
    """
    Analyzes video motion and generates flowmap (displacement map).
    Supports multiple motion detection algorithms.
    """

    MOTION_MODES = [
        "gradient_flow",      # Gradient-based optical flow (GPU, fast)
        "frame_diff",         # Simple frame difference with directional analysis
        "centroid_track",     # Track bright regions/orbs
        "optical_flow"        # OpenCV Farneback (if available)
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE",),  # BHWC tensor
                "mode": (cls.MOTION_MODES,),
                "strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "smoothing": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider"
                }),
                "threshold": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("flowmap",)
    FUNCTION = "generate_flowmap"
    CATEGORY = "WanVideoWrapper_QQ/video"
    DESCRIPTION = "Detects motion in video and generates RGB flowmap (R=horizontal, G=vertical, B=magnitude)"

    def generate_flowmap(self, video, mode, strength, smoothing, threshold):
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        video_tensor = video.to(device)

        if mode == "gradient_flow":
            flowmap = self._gradient_flow(video_tensor, strength, smoothing)
        elif mode == "frame_diff":
            flowmap = self._frame_diff(video_tensor, strength, smoothing)
        elif mode == "centroid_track":
            flowmap = self._centroid_track(video_tensor, strength, threshold, smoothing)
        elif mode == "optical_flow":
            flowmap = self._optical_flow(video_tensor, strength, smoothing)
        else:
            flowmap = self._frame_diff(video_tensor, strength, smoothing)

        return (flowmap.cpu(),)

    def _gradient_flow(self, video, strength, smoothing):
        """
        Gradient-based optical flow using PyTorch.
        Based on Lucas-Kanade brightness constancy assumption.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale if needed
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        # Initialize flow output [B, H, W, 3] (R=u, G=v, B=magnitude)
        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        # For first frame, no motion
        if b < 2:
            flow_output[..., :] = 0.5  # Neutral (no displacement)
            return flow_output

        # Calculate flow for each frame pair
        prev_smoothed_flow = None

        for i in range(1, b):
            frame_prev = gray[i-1]
            frame_curr = gray[i]

            # Spatial gradients (Sobel filters)
            # Convert to NCHW for conv2d: [1, 1, H, W]
            frame_prev_nchw = frame_prev.unsqueeze(0).unsqueeze(0)
            frame_curr_nchw = frame_curr.unsqueeze(0).unsqueeze(0)

            # Sobel kernels
            sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0
            sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0

            # Calculate gradients (average between frames for stability)
            Ix_prev = F.conv2d(frame_prev_nchw, sobel_x, padding=1)
            Iy_prev = F.conv2d(frame_prev_nchw, sobel_y, padding=1)
            Ix_curr = F.conv2d(frame_curr_nchw, sobel_x, padding=1)
            Iy_curr = F.conv2d(frame_curr_nchw, sobel_y, padding=1)

            Ix = (Ix_prev + Ix_curr) / 2.0
            Iy = (Iy_prev + Iy_curr) / 2.0

            # Temporal gradient
            It = (frame_curr - frame_prev).unsqueeze(0).unsqueeze(0)

            # Remove batch/channel dims [H, W]
            Ix = Ix.squeeze()
            Iy = Iy.squeeze()
            It = It.squeeze()

            # Lucas-Kanade: solve for flow (u, v)
            # Using simplified approach: u = -Ix*It / (Ix^2 + eps), v = -Iy*It / (Iy^2 + eps)
            eps = 1e-6
            denominator = Ix**2 + Iy**2 + eps

            u = -(Ix * It) / denominator  # Horizontal flow
            v = -(Iy * It) / denominator  # Vertical flow

            # Apply strength multiplier
            u = u * strength
            v = v * strength

            # Apply temporal smoothing
            if smoothing > 0 and prev_smoothed_flow is not None:
                u = smoothing * prev_smoothed_flow[..., 0] + (1 - smoothing) * u
                v = smoothing * prev_smoothed_flow[..., 1] + (1 - smoothing) * v

            # Calculate magnitude
            magnitude = torch.sqrt(u**2 + v**2)

            # Normalize to [0, 1] range
            # Flow values centered at 0.5 (no motion), scaled by max observed flow
            max_flow = torch.max(torch.abs(torch.stack([u, v]))) + eps
            u_norm = (u / (max_flow * 2.0)) + 0.5
            v_norm = (v / (max_flow * 2.0)) + 0.5
            mag_norm = magnitude / (max_flow + eps)

            # Clamp to valid range
            u_norm = torch.clamp(u_norm, 0.0, 1.0)
            v_norm = torch.clamp(v_norm, 0.0, 1.0)
            mag_norm = torch.clamp(mag_norm, 0.0, 1.0)

            # Store in output [H, W, 3]
            flow_output[i, :, :, 0] = u_norm
            flow_output[i, :, :, 1] = v_norm
            flow_output[i, :, :, 2] = mag_norm

            # Store for smoothing
            prev_smoothed_flow = torch.stack([u, v], dim=-1)

        # First frame copies second frame's flow
        if b > 1:
            flow_output[0] = flow_output[1]

        return flow_output

    def _frame_diff(self, video, strength, smoothing):
        """
        Simple frame difference with directional analysis.
        Faster but less accurate than optical flow.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        if b < 2:
            flow_output[..., :] = 0.5
            return flow_output

        prev_flow = None

        for i in range(1, b):
            # Frame difference
            diff = (gray[i] - gray[i-1]) * strength

            # Estimate directional flow using spatial gradients
            diff_nchw = diff.unsqueeze(0).unsqueeze(0)

            # Simple gradient
            sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0
            sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
                                   dtype=video.dtype, device=device).view(1, 1, 3, 3) / 8.0

            grad_x = F.conv2d(diff_nchw, sobel_x, padding=1).squeeze()
            grad_y = F.conv2d(diff_nchw, sobel_y, padding=1).squeeze()

            # Apply smoothing
            if smoothing > 0 and prev_flow is not None:
                grad_x = smoothing * prev_flow[..., 0] + (1 - smoothing) * grad_x
                grad_y = smoothing * prev_flow[..., 1] + (1 - smoothing) * grad_y

            # Magnitude
            magnitude = torch.sqrt(grad_x**2 + grad_y**2)

            # Normalize
            max_val = torch.max(torch.abs(torch.stack([grad_x, grad_y]))) + 1e-6
            u_norm = (grad_x / (max_val * 2.0)) + 0.5
            v_norm = (grad_y / (max_val * 2.0)) + 0.5
            mag_norm = magnitude / (max_val + 1e-6)

            flow_output[i, :, :, 0] = torch.clamp(u_norm, 0.0, 1.0)
            flow_output[i, :, :, 1] = torch.clamp(v_norm, 0.0, 1.0)
            flow_output[i, :, :, 2] = torch.clamp(mag_norm, 0.0, 1.0)

            prev_flow = torch.stack([grad_x, grad_y], dim=-1)

        if b > 1:
            flow_output[0] = flow_output[1]

        return flow_output

    def _centroid_track(self, video, strength, threshold, smoothing):
        """
        Track bright regions (orbs) and generate flow field.
        Good for videos with distinct bright objects.
        """
        device = video.device
        b, h, w, c = video.shape

        # Convert to grayscale
        if c == 3:
            gray = 0.299 * video[..., 0] + 0.587 * video[..., 1] + 0.114 * video[..., 2]
        else:
            gray = video[..., 0]

        flow_output = torch.zeros((b, h, w, 3), device=device, dtype=video.dtype)

        if b < 2:
            flow_output[..., :] = 0.5
            return flow_output

        # Create coordinate grids
        y_coords = torch.arange(h, device=device, dtype=video.dtype).view(h, 1).expand(h, w)
        x_coords = torch.arange(w, device=device, dtype=video.dtype).view(1, w).expand(h, w)

        prev_centroid = None

        for i in range(b):
            # Threshold to find bright regions
            mask = (gray[i] > threshold).float()

            if mask.sum() > 0:
                # Calculate centroid
                total_mass = mask.sum()
                cx = (mask * x_coords).sum() / total_mass
                cy = (mask * y_coords).sum() / total_mass

                if prev_centroid is not None and i > 0:
                    # Calculate displacement
                    dx = (cx - prev_centroid[0]) * strength
                    dy = (cy - prev_centroid[1]) * strength

                    # Create flow field: pixels closer to bright regions have stronger flow
                    # Distance from each pixel to current centroid
                    dist_x = x_coords - cx
                    dist_y = y_coords - cy
                    dist = torch.sqrt(dist_x**2 + dist_y**2) + 1e-6

                    # Falloff: closer pixels get more displacement
                    max_dist = torch.sqrt(torch.tensor(h**2 + w**2, dtype=video.dtype, device=device))
                    falloff = torch.clamp(1.0 - (dist / (max_dist * 0.3)), 0.0, 1.0)

                    # Apply displacement with falloff
                    u = dx * falloff * mask
                    v = dy * falloff * mask
                    magnitude = torch.sqrt(u**2 + v**2)

                    # Normalize
                    max_disp = max(torch.max(torch.abs(u)), torch.max(torch.abs(v))) + 1e-6
                    u_norm = (u / (max_disp * 2.0)) + 0.5
                    v_norm = (v / (max_disp * 2.0)) + 0.5
                    mag_norm = magnitude / (max_disp + 1e-6)

                    flow_output[i, :, :, 0] = torch.clamp(u_norm, 0.0, 1.0)
                    flow_output[i, :, :, 1] = torch.clamp(v_norm, 0.0, 1.0)
                    flow_output[i, :, :, 2] = torch.clamp(mag_norm, 0.0, 1.0)
                else:
                    flow_output[i, :, :, :] = 0.5

                prev_centroid = (cx, cy)
            else:
                flow_output[i, :, :, :] = 0.5
                prev_centroid = None

        return flow_output

    def _optical_flow(self, video, strength, smoothing):
        """
        OpenCV Farneback optical flow (CPU fallback if GPU unavailable).
        """
        try:
            import cv2
        except ImportError:
            print("[WARNING] OpenCV not available, falling back to gradient_flow")
            return self._gradient_flow(video, strength, smoothing)

        b, h, w, c = video.shape

        # Convert to numpy and grayscale
        video_np = video.cpu().numpy()

        if c == 3:
            gray_frames = []
            for i in range(b):
                gray = cv2.cvtColor((video_np[i] * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                gray_frames.append(gray)
        else:
            gray_frames = [(video_np[i, :, :, 0] * 255).astype(np.uint8) for i in range(b)]

        flow_output = np.zeros((b, h, w, 3), dtype=np.float32)

        if b < 2:
            flow_output[..., :] = 0.5
            return torch.from_numpy(flow_output).to(video.device)

        prev_flow = None

        for i in range(1, b):
            # Calculate optical flow
            flow = cv2.calcOpticalFlowFarneback(
                gray_frames[i-1], gray_frames[i],
                None, 0.5, 3, 15, 3, 5, 1.2, 0
            )

            # flow is [H, W, 2] where [:,:,0]=horizontal, [:,:,1]=vertical
            u = flow[..., 0] * strength
            v = flow[..., 1] * strength

            # Apply smoothing
            if smoothing > 0 and prev_flow is not None:
                u = smoothing * prev_flow[..., 0] + (1 - smoothing) * u
                v = smoothing * prev_flow[..., 1] + (1 - smoothing) * v

            magnitude = np.sqrt(u**2 + v**2)

            # Normalize
            max_flow = max(np.max(np.abs(u)), np.max(np.abs(v))) + 1e-6
            u_norm = np.clip((u / (max_flow * 2.0)) + 0.5, 0.0, 1.0)
            v_norm = np.clip((v / (max_flow * 2.0)) + 0.5, 0.0, 1.0)
            mag_norm = np.clip(magnitude / (max_flow + 1e-6), 0.0, 1.0)

            flow_output[i, :, :, 0] = u_norm
            flow_output[i, :, :, 1] = v_norm
            flow_output[i, :, :, 2] = mag_norm

            prev_flow = np.stack([u, v], axis=-1)

        if b > 1:
            flow_output[0] = flow_output[1]

        return torch.from_numpy(flow_output).to(video.device)


class WanVideoFlowmapDistortion:
    """
    Applies flowmap distortion to a video using displacement mapping.
    Uses GPU-accelerated grid_sample for efficient warping.
    """

    EDGE_MODES = ["border", "reflection", "zeros"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE",),        # Source video to distort
                "flowmap": ("IMAGE",),      # Displacement map (R=X, G=Y, B=magnitude)
                "distortion_strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "edge_mode": (cls.EDGE_MODES,),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("distorted_video",)
    FUNCTION = "apply_flowmap"
    CATEGORY = "WanVideoWrapper_QQ/video"
    DESCRIPTION = "Applies flowmap-based distortion to video using displacement mapping"

    def apply_flowmap(self, video, flowmap, distortion_strength, edge_mode):
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        video_tensor = video.to(device)
        flowmap_tensor = flowmap.to(device)

        b, h, w, c = video_tensor.shape
        bf, hf, wf, cf = flowmap_tensor.shape

        # Ensure flowmap matches video dimensions
        if (hf != h) or (wf != w):
            # Resize flowmap to match video
            flowmap_bchw = flowmap_tensor.permute(0, 3, 1, 2)
            flowmap_bchw = F.interpolate(flowmap_bchw, size=(h, w), mode='bilinear', align_corners=False)
            flowmap_tensor = flowmap_bchw.permute(0, 2, 3, 1)

        # Ensure batch sizes match
        if bf != b:
            if bf < b:
                # Repeat last flowmap frame
                flowmap_tensor = torch.cat([
                    flowmap_tensor,
                    flowmap_tensor[-1:].repeat(b - bf, 1, 1, 1)
                ], dim=0)
            else:
                flowmap_tensor = flowmap_tensor[:b]

        # Process each frame
        output_frames = []

        for i in range(b):
            distorted_frame = self._apply_single_frame(
                video_tensor[i:i+1],
                flowmap_tensor[i:i+1],
                distortion_strength,
                edge_mode,
                device
            )
            output_frames.append(distorted_frame)

        output_video = torch.cat(output_frames, dim=0)

        return (output_video.cpu(),)

    def _apply_single_frame(self, frame, flowmap, strength, edge_mode, device):
        """
        Apply flowmap distortion to a single frame using grid_sample.
        """
        # frame: [1, H, W, C]
        # flowmap: [1, H, W, 3] (R=u, G=v, B=magnitude)

        h, w = frame.shape[1:3]

        # Convert frame to BCHW for grid_sample
        frame_bchw = frame.permute(0, 3, 1, 2)

        # Extract flow components (stored as [0, 1] range, 0.5 = no motion)
        u_norm = flowmap[0, :, :, 0]  # Horizontal displacement
        v_norm = flowmap[0, :, :, 1]  # Vertical displacement

        # Convert from [0, 1] to displacement in pixels
        # 0.5 = no displacement, <0.5 = negative, >0.5 = positive
        u_pixels = (u_norm - 0.5) * 2.0 * strength * w  # Scale by image width
        v_pixels = (v_norm - 0.5) * 2.0 * strength * h  # Scale by image height

        # Create base coordinate grid
        y_coords = torch.arange(h, device=device, dtype=frame.dtype)
        x_coords = torch.arange(w, device=device, dtype=frame.dtype)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')

        # Apply displacement
        sample_x = grid_x + u_pixels
        sample_y = grid_y + v_pixels

        # Normalize to [-1, 1] for grid_sample
        norm_x = (sample_x / max(w - 1.0, 1e-6)) * 2.0 - 1.0
        norm_y = (sample_y / max(h - 1.0, 1e-6)) * 2.0 - 1.0

        # Stack as [H, W, 2] and add batch dimension [1, H, W, 2]
        grid_normalized = torch.stack([norm_x, norm_y], dim=-1).unsqueeze(0)

        # Map edge_mode to grid_sample padding_mode
        padding_mode_map = {
            "border": "border",
            "reflection": "reflection",
            "zeros": "zeros"
        }
        padding_mode = padding_mode_map.get(edge_mode, "border")

        # Apply grid sampling
        distorted_bchw = F.grid_sample(
            frame_bchw,
            grid_normalized,
            mode='bilinear',
            padding_mode=padding_mode,
            align_corners=True
        )

        # Convert back to BHWC
        distorted_bhwc = distorted_bchw.permute(0, 2, 3, 1)

        # Clamp to valid range
        distorted_bhwc = torch.clamp(distorted_bhwc, 0.0, 1.0)

        return distorted_bhwc


class LoadImageExtra:
    """
    Same as core Load Image, but also outputs the selected image's
    filename without extension as a STRING (output "name").
    """

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {"required":
                    {"image": (sorted(files), {"image_upload": True})},
                }

    CATEGORY = "image"
    RETURN_TYPES = ("IMAGE", "MASK", IO.STRING)
    RETURN_NAMES = ("IMAGE", "MASK", "name")
    FUNCTION = "load_image"

    def load_image(self, image):
        image_path = folder_paths.get_annotated_filepath(image)

        dtype = comfy.model_management.intermediate_dtype()
        device = comfy.model_management.intermediate_device()

        components = InputImpl.VideoFromFile(image_path).get_components()
        if components.images.shape[0] > 0:
            out_image = components.images.to(device=device, dtype=dtype)
            out_mask = (1.0 - components.alpha[..., -1]).to(device=device, dtype=dtype) if components.alpha is not None else torch.zeros((components.images.shape[0], 64, 64), dtype=dtype, device=device)
        else:
            # This code is left here to handle animated webp which pyav does not support loading
            img = node_helpers.pillow(Image.open, image_path)

            output_images = []
            output_masks = []
            w, h = None, None

            for i in ImageSequence.Iterator(img):
                i = node_helpers.pillow(ImageOps.exif_transpose, i)

                im = i.convert("RGB")

                if len(output_images) == 0:
                    w = im.size[0]
                    h = im.size[1]

                if im.size[0] != w or im.size[1] != h:
                    continue

                im = np.array(im).astype(np.float32) / 255.0
                im = torch.from_numpy(im)[None,]
                if 'A' in i.getbands():
                    mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                    mask = 1. - torch.from_numpy(mask)
                else:
                    mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
                output_images.append(im.to(dtype=dtype))
                output_masks.append(mask.unsqueeze(0).to(dtype=dtype))

            out_image = torch.cat(output_images, dim=0)
            out_mask = torch.cat(output_masks, dim=0)

            out_image = out_image.to(device=device, dtype=dtype)
            out_mask = out_mask.to(device=device, dtype=dtype)

        name = os.path.splitext(os.path.basename(image))[0]
        return (out_image, out_mask, name)

    @classmethod
    def IS_CHANGED(s, image):
        image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, 'rb') as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image):
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)

        return True


_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}


def _list_image_files(directory):
    """Image files located directly in `directory`, sorted case-insensitively."""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    files = [n for n in names
             if os.path.splitext(n)[1].lower() in _IMAGE_EXTENSIONS
             and os.path.isfile(os.path.join(directory, n))]
    return sorted(files, key=lambda n: (n.lower(), n))


def _list_nonempty_txt_stems(directory):
    """Lower-cased stems of non-empty .txt files located directly in `directory`."""
    try:
        names = os.listdir(directory)
    except OSError:
        return set()
    stems = set()
    for name in names:
        stem, ext = os.path.splitext(name)
        if ext.lower() != ".txt":
            continue
        file_path = os.path.join(directory, name)
        try:
            if os.path.isfile(file_path) and os.path.getsize(file_path) > 0:
                stems.add(stem.lower())
        except OSError:
            continue
    return stems


def _load_pair_image(image_path):
    """Load an image file as a [1, H, W, 3] float32 CPU tensor (first frame)."""
    img = node_helpers.pillow(Image.open, image_path)
    img = node_helpers.pillow(ImageOps.exif_transpose, img)
    img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


class LoadImagePair_FromPath:
    """
    Loads image pairs from a folder.

    Scans the given folder for images. Every image whose file name (extension
    stripped, case-insensitive) also exists in the folder's "control"
    sub-folder forms a pair - the extensions may differ
    (e.g. "a.png" pairs with "control/a.jpg"). Only complete pairs are output,
    in alphabetical order of the main folder image name.

    Outputs (parallel lists, one entry per pair):
        control - IMAGE list: the images from the "control" sub-folder.
        result  - IMAGE list: the images from the folder itself.
        path    - STRING list: absolute file paths of the result images with
                  the file extension stripped (never the ones inside
                  "control"), e.g. "C:/images/foo" for "C:/images/foo.png".

    With skip_existing enabled, pairs whose result image already has a
    non-empty "<name>.txt" next to it (in the folder itself, not in "control")
    are left out of the output - useful for resuming captioning runs, since
    already captioned pairs are not processed again. Empty (0-byte) .txt files
    count as missing, so emptying a caption re-includes that pair.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Folder with the images. Each image needs a name-matching counterpart in the 'control' sub-folder (extension may differ). Quoted paths are accepted.",
                }),
            },
            "optional": {
                "skip_existing": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "When enabled, pairs whose result image already has a non-empty '<name>.txt' next to it (in the folder itself, never in 'control') are not output. Useful to resume captioning runs; empty (0-byte) .txt files count as missing.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", IO.STRING)
    RETURN_NAMES = ("control", "result", "path")
    FUNCTION = "load_pairs"
    # All three outputs are real Python lists (one entry per pair). Without
    # this flag, execution.py's merge_result_data would wrap each returned
    # list into a 1-element list, so a downstream node (e.g. SaveImage) would
    # receive the whole list as a single "batch" and iterate over 4D tensors.
    # With it, list-aware nodes get the full list and plain nodes are called
    # once per element - the standard ComfyUI list-output behaviour.
    OUTPUT_IS_LIST = (True, True, True)
    CATEGORY = "WanVideoWrapper_QQ/image"
    DESCRIPTION = ("Scans a folder for image pairs: the image in the folder itself and its counterpart "
                   "in the 'control' sub-folder with the same name (extension may differ, e.g. a.png + "
                   "control/a.jpg). Outputs parallel lists: control (from 'control'), result (from the "
                   "folder itself) and path (full file paths of the result images, file extension "
                   "stripped). Only complete pairs are output. With skip_existing enabled, pairs that "
                   "already have a non-empty '<name>.txt' next to the result image are left out, so "
                   "captioning runs can be resumed.")

    @staticmethod
    def _resolve_dirs(path):
        p = (path or "").strip().strip('"').strip("'")
        if not p:
            raise ValueError("Load Image Pair From Path: 'path' is empty.")
        p = os.path.normpath(os.path.abspath(os.path.expanduser(p)))
        main_dir = os.path.dirname(p) if os.path.isfile(p) else p
        if not os.path.isdir(main_dir):
            raise ValueError(f"Load Image Pair From Path: folder does not exist: {main_dir}")
        control_dir = os.path.join(main_dir, "control")
        if not os.path.isdir(control_dir):
            raise ValueError(f"Load Image Pair From Path: no 'control' sub-folder found in: {main_dir}")
        return main_dir, control_dir

    def load_pairs(self, path, skip_existing=False):
        skip_existing = skip_existing if isinstance(skip_existing, bool) else str(skip_existing).lower() == "true"
        main_dir, control_dir = self._resolve_dirs(path)

        main_files = _list_image_files(main_dir)
        control_files = _list_image_files(control_dir)

        if not main_files:
            raise ValueError(f"Load Image Pair From Path: no images found in: {main_dir}")
        if not control_files:
            raise ValueError(f"Load Image Pair From Path: no images found in: {control_dir}")

        # stems of non-empty <name>.txt files next to the result images (never 'control')
        existing_caption_stems = _list_nonempty_txt_stems(main_dir) if skip_existing else set()

        # stem (lower-case, extension stripped) -> [(filename, extension), ...]
        control_by_stem = {}
        for name in control_files:
            stem, ext = os.path.splitext(name)
            control_by_stem.setdefault(stem.lower(), []).append((name, ext.lower()))

        control_images, result_images, result_paths = [], [], []
        skipped = []
        already_captioned = []

        for name in main_files:
            stem, ext = os.path.splitext(name)
            candidates = control_by_stem.get(stem.lower())
            if not candidates:
                skipped.append(name)
                continue
            # Pair already has a non-empty caption .txt next to the result image
            if skip_existing and stem.lower() in existing_caption_stems:
                already_captioned.append(name)
                continue
            # Prefer the control file with the same extension, else alphabetical
            ext = ext.lower()
            control_name = next((c[0] for c in candidates if c[1] == ext), candidates[0][0])
            result_path = os.path.join(main_dir, name)
            control_images.append(_load_pair_image(os.path.join(control_dir, control_name)))
            result_images.append(_load_pair_image(result_path))
            # Full path with the file extension stripped (e.g. ".../foo.png" -> ".../foo")
            result_paths.append(os.path.splitext(result_path)[0])

        if not result_images:
            if already_captioned:
                details = []
                if skipped:
                    details.append(f"{len(skipped)} image(s) without a matching control file")
                details.append(f"{len(already_captioned)} pair(s) already have a non-empty caption "
                               f".txt next to the result image (skip_existing=True)")
                reason = "; ".join(details)
            else:
                reason = f"{len(main_files)} image(s), none has a name-matching file in 'control'"
            raise ValueError(
                f"Load Image Pair From Path: no pairs left to output in {main_dir} ({reason})."
            )

        parts = []
        if skipped:
            preview = ", ".join(skipped[:10]) + (" ..." if len(skipped) > 10 else "")
            parts.append(f"skipped {len(skipped)} image(s) without a matching control file: {preview}")
        if already_captioned:
            preview = ", ".join(already_captioned[:10]) + (" ..." if len(already_captioned) > 10 else "")
            parts.append(f"skipped {len(already_captioned)} pair(s) with an existing non-empty caption .txt: {preview}")
        tail = ("; " + "; ".join(parts)) if parts else ""
        print(f"[LoadImagePair_FromPath] Loaded {len(result_images)} pair(s) from {main_dir}{tail}.")

        return (control_images, result_images, result_paths)

    @classmethod
    def IS_CHANGED(cls, path, skip_existing=False):
        skip_existing = skip_existing if isinstance(skip_existing, bool) else str(skip_existing).lower() == "true"
        try:
            main_dir, control_dir = cls._resolve_dirs(path)
        except ValueError:
            return float("NaN")
        sha = hashlib.sha256()
        sha.update(f"skip_existing={skip_existing}".encode("utf-8"))
        for directory in (main_dir, control_dir):
            for name in _list_image_files(directory):
                fp = os.path.join(directory, name)
                try:
                    st = os.stat(fp)
                    sha.update(f"{fp}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8"))
                except OSError:
                    sha.update(fp.encode("utf-8"))
        # With skip_existing the loaded pairs also depend on the caption .txt
        # files next to the result images, so newly written (or emptied)
        # captions must invalidate the cache and re-run the loader.
        if skip_existing:
            for stem in sorted(_list_nonempty_txt_stems(main_dir)):
                sha.update(f"|caption_txt:{stem}".encode("utf-8"))
        return sha.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, path):
        try:
            cls._resolve_dirs(path)
        except ValueError as e:
            return str(e)
        return True


def _grid_snap(v, div):
    """Snap a dimension to the closest multiple of div (>= div when div > 1)."""
    if div and div > 1:
        return max(div, int(round(v / div)) * div)
    return max(1, int(round(v)))


def _grid_resize_cover(t, target_w, target_h):
    """LANCZOS-scale a HWC float tensor to COVER the target size (aspect ratio
    preserved, no stretching), then center-crop to the exact target dims."""
    h, w = t.shape[0], t.shape[1]
    if w == target_w and h == target_h:
        return t
    scale = max(target_w / w, target_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    x = t.permute(2, 0, 1).unsqueeze(0)
    try:
        x = F.interpolate(x, size=(new_h, new_w), mode="lanczos", antialias=True)
    except (ValueError, NotImplementedError):
        x = F.interpolate(x, size=(new_h, new_w), mode="bicubic", antialias=True)
    x = x.clamp(0.0, 1.0)[0].permute(1, 2, 0)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return x[top:top + target_h, left:left + target_w, :].contiguous()


class PowerImageGrid:
    """
    Displays a batch of images in a resizable grid (one cell per image) and
    outputs the images after optional per-image cropping and MP-normalisation.

    The frontend (web/power_image_grid) draws the grid: node size + image count
    determine rows/columns, resizing the node re-arranges cells so all images
    fit. Each cell gets a scissors button in its top-right corner that toggles
    an interactive crop box (drag to move, corner handles to resize) - each
    image's crop can be activated/deactivated independently.

    Inputs:
        images        - IMAGE batch tensor [N, H, W, C] or a LIST of IMAGE
                        tensors (comfy "Create List" etc.); every image is
                        shown as one grid cell.
        resize_to_mp  - 0.0 = inactive. Any other value: all images are first
                        cropped (where crop is active), then resized to the
                        FIRST image's aspect ratio at `resize_to_mp`
                        megapixels total area (LANCZOS cover + center-crop).
        divisible_by  - Output dimensions are snapped to the closest multiple
                        of this (crop sizes too when resize_to_mp is 0).
        crop_json     - Hidden widget, written by the frontend. JSON list of
                        per-image crops: {enabled, x, y, w, h} (normalized
                        center + size, like Power Load Video's crop).

    Output:
        images - IMAGE tensor of the processed (cropped/resized) batch.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "resize_to_mp": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 64.0, "step": 0.1}),
                "divisible_by": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1}),
                "crop_json": ("STRING", {"default": "[]"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "process"
    OUTPUT_NODE = True
    # Accept true LISTs (e.g. comfy "Create List"): without this, a list input
    # would execute this node once PER ITEM and the grid would only ever see
    # the first image. With it, ALL list items arrive in a single execution
    # (widget values arrive wrapped in 1-element lists too).
    INPUT_IS_LIST = True
    CATEGORY = "Power/Image"
    DESCRIPTION = "Resizable image grid with per-image crop boxes, MP normalisation (resize_to_mp) and divisible_by snapping."

    @staticmethod
    def _unwrap_scalar(v, default, cast):
        """Pull a scalar out of a possibly list-wrapped widget value."""
        if isinstance(v, (list, tuple)):
            v = v[0] if len(v) > 0 else default
        try:
            return cast(v)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _flatten_images(images):
        """Normalize any accepted input form into a flat list of HWC tensors.

        Handles: a [N,H,W,C] batch, a single [H,W,C] tensor, a LIST of either
        (comfy "Create List"), and mixed lists. Items may have different H/W -
        they are only stacked at the very end, after resizing."""
        flat = []
        items = images if isinstance(images, (list, tuple)) else [images]
        for im in items:
            if im is None:
                continue
            if im.dim() == 4:
                flat.extend(im[i] for i in range(im.shape[0]))
            elif im.dim() == 3:
                flat.append(im)
        return flat

    def process(self, images, resize_to_mp=0.0, divisible_by=32, crop_json="[]",
                unique_id=None, prompt=None):
        # INPUT_IS_LIST: flatten lists / batches into individual HWC images
        # WITHOUT concatenating - list items may have different sizes.
        imgs = self._flatten_images(images)
        if not imgs:
            raise ValueError("Power Image Grid: no images received on the images input.")

        # Coerce widget values (lists from INPUT_IS_LIST, or odd optionals)
        resize_to_mp = self._unwrap_scalar(resize_to_mp, 0.0, float)
        divisible_by = self._unwrap_scalar(divisible_by, 32, int)
        if divisible_by < 1:
            divisible_by = 1
        if isinstance(crop_json, (list, tuple)):
            crop_json = crop_json[0] if len(crop_json) > 0 else "[]"

        # Parse per-image crops written by the frontend
        crops = []
        if isinstance(crop_json, str) and crop_json.strip():
            try:
                parsed = json.loads(crop_json)
                if isinstance(parsed, list):
                    crops = parsed
            except (ValueError, TypeError):
                crops = []

        n = len(imgs)
        processed = []
        for i in range(n):
            img = imgs[i]  # HWC
            h, w = int(img.shape[0]), int(img.shape[1])

            c = crops[i] if i < len(crops) and isinstance(crops[i], dict) else None
            if c is not None and c.get("enabled"):
                try:
                    cx = min(1.0, max(0.0, float(c.get("x", 0.5))))
                    cy = min(1.0, max(0.0, float(c.get("y", 0.5))))
                    cw = min(1.0, max(0.05, float(c.get("w", 1.0))))
                    ch = min(1.0, max(0.05, float(c.get("h", 1.0))))
                except (TypeError, ValueError):
                    cx, cy, cw, ch = 0.5, 0.5, 1.0, 1.0

                left = max(0, int(round((cx - cw / 2) * w)))
                top = max(0, int(round((cy - ch / 2) * h)))
                right = min(w, int(round((cx + cw / 2) * w)))
                bottom = min(h, int(round((cy + ch / 2) * h)))

                if right > left and bottom > top:
                    # Snap crop dimensions to divisible_by and re-center,
                    # so outputs stay usable even with resize_to_mp = 0
                    raw_w = right - left
                    raw_h = bottom - top
                    snap_w = _grid_snap(raw_w, divisible_by)
                    snap_h = _grid_snap(raw_h, divisible_by)
                    if snap_w < raw_w or snap_h < raw_h:
                        left = left + (raw_w - snap_w) // 2
                        top = top + (raw_h - snap_h) // 2
                        left = max(0, min(left, w - snap_w))
                        top = max(0, min(top, h - snap_h))
                        right = left + snap_w
                        bottom = top + snap_h
                    img = img[top:bottom, left:right, :].contiguous()

            processed.append(img)

        if resize_to_mp > 0.0:
            # Target = FIRST image's (post-crop) aspect ratio at resize_to_mp
            # megapixels of total area, both sides snapped to divisible_by.
            h0, w0 = int(processed[0].shape[0]), int(processed[0].shape[1])
            aspect = w0 / h0
            area = resize_to_mp * 1_000_000.0
            target_h = (area / aspect) ** 0.5
            target_w = aspect * target_h
            target_w = _grid_snap(target_w, divisible_by)
            target_h = _grid_snap(target_h, divisible_by)
            # COVER: images with a different AR are scaled to cover the target
            # (aspect ratio preserved) and center-cropped to the exact target
            # dimensions.
            processed = [_grid_resize_cover(p, target_w, target_h) for p in processed]
        else:
            # Inactive: make the batch stackable by cover-fitting any image
            # whose size differs from the first image's size.
            h0, w0 = int(processed[0].shape[0]), int(processed[0].shape[1])
            if any(int(p.shape[0]) != h0 or int(p.shape[1]) != w0 for p in processed):
                processed = [_grid_resize_cover(p, w0, h0) for p in processed]

        out = torch.stack(processed, dim=0)

        # --- UI previews (UNCROPPED originals, so crop boxes stay editable) --
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        node_key = str(unique_id) if unique_id is not None else "shared"
        prefix = f"power_image_grid_{node_key}_"
        try:
            for name in os.listdir(temp_dir):
                if name.startswith(prefix):
                    try:
                        os.remove(os.path.join(temp_dir, name))
                    except OSError:
                        pass
        except OSError:
            pass

        results = []
        for i in range(n):
            arr = np.clip(imgs[i].float().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
            pil_img = Image.fromarray(arr)
            # Cap preview resolution - only needed for crop-box editing
            max_side = 1536
            if max(pil_img.size) > max_side:
                s = max_side / max(pil_img.size)
                pil_img = pil_img.resize(
                    (max(1, int(pil_img.size[0] * s)), max(1, int(pil_img.size[1] * s))),
                    Image.LANCZOS,
                )
            name = f"{prefix}{i:05d}.jpg"
            pil_img.save(os.path.join(temp_dir, name), format="JPEG", quality=92)
            results.append({"filename": name, "subfolder": "", "type": "temp"})

        # NOTE: every ui value must be a list - the server iterates over each
        # value when merging ui outputs. Custom key "grid_images" (not
        # "images") so the frontend's native output-node preview does not
        # ALSO render these images under the node.
        return {
            "ui": {"grid_images": results},
            "result": (out,),
        }


# Node registration
NODE_CLASS_MAPPINGS = {
    "WanVideoMotionToFlowmap": WanVideoMotionToFlowmap,
    "WanVideoFlowmapDistortion": WanVideoFlowmapDistortion,
    "LoadImageExtra": LoadImageExtra,
    "LoadImagePair_FromPath": LoadImagePair_FromPath,
    "PowerImageGrid": PowerImageGrid,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVideoMotionToFlowmap": "Wan Video Motion to Flowmap",
    "WanVideoFlowmapDistortion": "Wan Video Flowmap Distortion",
    "LoadImageExtra": "Load Image Extra",
    "LoadImagePair_FromPath": "Load Image Pair From Path",
    "PowerImageGrid": "Power Image Grid",
}
