import torch
import torch.nn.functional as F  # Added F
import folder_paths
from PIL import Image
import numpy as np
import cv2
import os
import sys
from concurrent.futures import ThreadPoolExecutor

# Add parent directory to path for comfy imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import comfy.model_management

# Constants
MAX_RESOLUTION = 8192

class ImageRGB:
    def __init__(self, device="cpu"):
        self.device = device

    @classmethod
    def INPUT_TYPES(s):
        return {"required": { "width": ("INT", {"default": 512, "min": 1, "max": MAX_RESOLUTION, "step": 1}),
                              "height": ("INT", {"default": 512, "min": 1, "max": MAX_RESOLUTION, "step": 1}),
                              "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
                              "color_rgb": ("STRING", {"default": "128,128,128"})
                              }}
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"

    CATEGORY = "image"

    def generate(self, width, height, batch_size=1, color_rgb="255,255,255"):
        # Parse RGB string "R,G,B" into integers
        try:
            r_val, g_val, b_val = map(int, color_rgb.split(','))
        except ValueError:
            raise ValueError("color_rgb must be in format 'R,G,B' (e.g., '128,128,128')")

        dtype = comfy.model_management.intermediate_dtype()
        device = comfy.model_management.intermediate_device()
        r = torch.full([batch_size, height, width, 1], r_val / 0xFF, device=device, dtype=dtype)
        g = torch.full([batch_size, height, width, 1], g_val / 0xFF, device=device, dtype=dtype)
        b = torch.full([batch_size, height, width, 1], b_val / 0xFF, device=device, dtype=dtype)
        return (torch.cat((r, g, b), dim=-1), )

class ImageBlend_GPU:
    # Moved blend modes inside the class
    BLEND_MODES = [
        "normal", "multiply", "screen", "overlay", "add", "subtract", 
        "difference", "darken", "lighten", 
        # Add other modes supported by the original chop_image if known
    ]

    # Keep NODE_NAME if used for printing
    NODE_NAME = "Image Blend GPU (Optimized)" 

    @classmethod
    def INPUT_TYPES(self):
        # Input types remain the same structurally
        return {
            "required": {
                "background_image": ("IMAGE",), # BHWC tensor
                "layer_image": ("IMAGE",),      # BHWC tensor
                "blend_mode": (self.BLEND_MODES,), # Reference class attribute
                "opacity": ("INT", {"default": 100, "min": 0, "max": 100, "step": 1}),
            },
            "optional": {
                "layer_mask": ("MASK",),       # BHW tensor
                "invert_mask": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = 'image_blend_gpu' # Renamed function to reflect GPU implementation
    CATEGORY = 'WanVideoWrapper_QQ/image' # Keep category or update as needed

    def blend_normal(self, background, layer):
        # Standard alpha compositing is handled by the final masking stage
        return layer

    def blend_multiply(self, background, layer):
        return background * layer

    def blend_screen(self, background, layer):
        return 1.0 - (1.0 - background) * (1.0 - layer)

    def blend_overlay(self, background, layer):
        # Equivalent to:
        # low = 2.0 * background * layer
        # high = 1.0 - 2.0 * (1.0 - background) * (1.0 - layer)
        # return torch.where(background < 0.5, low, high)
        # Faster implementation:
        return torch.where(background < 0.5, 
                           2.0 * background * layer, 
                           1.0 - 2.0 * (1.0 - background) * (1.0 - layer))

    def blend_add(self, background, layer):
        return torch.clamp(background + layer, 0.0, 1.0)

    def blend_subtract(self, background, layer):
        return torch.clamp(background - layer, 0.0, 1.0)
        
    def blend_difference(self, background, layer):
        return torch.abs(background - layer)

    def blend_darken(self, background, layer):
        return torch.minimum(background, layer)

    def blend_lighten(self, background, layer):
        return torch.maximum(background, layer)

    def image_blend_gpu(self, background_image, layer_image,
                         blend_mode, opacity,
                        layer_mask=None,
                        invert_mask=False):

        device = background_image.device # Use the device of the input tensor
        
        # Ensure tensors are BHWC, float32, and on the correct device
        bg_bhwc = background_image.to(device, dtype=torch.float32)
        layer_bhwc = layer_image.to(device, dtype=torch.float32)

        b_frames = bg_bhwc.shape[0]
        l_frames = layer_bhwc.shape[0]
        max_frames = max(b_frames, l_frames) # Calculate max_frames early

        # --- Mask Handling --- If layer_mask is provided, use it. Otherwise, no mask (full opacity) ---
        mask_bhwc = None # Initialize
        if layer_mask is not None:
            # Input mask is BHW, float32
            mask_b = layer_mask.to(device, dtype=torch.float32)
            if mask_b.dim() == 2: # Single mask image for batch
                 mask_b = mask_b.unsqueeze(0).repeat(max_frames, 1, 1)
            elif mask_b.shape[0] != max_frames:
                 # Repeat last mask frame if batch size mismatches
                 if mask_b.shape[0] < max_frames:
                     mask_b = torch.cat([mask_b, mask_b[-1:].repeat(max_frames - mask_b.shape[0], 1, 1)], dim=0)
                 else: # Truncate if mask batch is longer
                     mask_b = mask_b[:max_frames]

            if invert_mask: # Apply inversion ONLY if mask was provided
                mask_b = 1.0 - mask_b
            else:
                print(f"[INFO] Not inverting provided mask.")
                
            # Unsqueeze to BHWC for broadcasting (B, H, W, 1)
            mask_bhwc = mask_b.unsqueeze(-1)

        # --- Default Mask: If no layer_mask was provided, create a full white mask ---
        else: 
            # Determine target H/W. Use layer's spatial dimensions as default target.
            target_h = layer_bhwc.shape[1] # Use layer height
            target_w = layer_bhwc.shape[2] # Use layer width
            
            # If background and layer differ, resize happens later, mask should match initial layer size here?
            # Let's create mask matching the potentially un-resized layer dimensions first.
            mask_bhwc = torch.ones((max_frames, target_h, target_w, 1), dtype=torch.float32, device=device)
            # Note: invert_mask is NOT applied here, as no mask was input by the user.


        # --- Ensure consistent Channel Counts (RGB) --- 
        # Background should be RGB (remove alpha if present)
        if bg_bhwc.shape[3] == 4:
             print("[WARNING] Background has alpha, removing it.") # Replaced log
             bg_bhwc = bg_bhwc[...,:3]
        elif bg_bhwc.shape[3] == 1: # Grayscale to RGB
             bg_bhwc = bg_bhwc.repeat(1, 1, 1, 3)

        # Layer should be RGB (remove alpha if present)
        if layer_bhwc.shape[3] == 4:
            layer_bhwc = layer_bhwc[..., :3]
        elif layer_bhwc.shape[3] == 1: # Grayscale to RGB
            layer_bhwc = layer_bhwc.repeat(1, 1, 1, 3)
        elif layer_bhwc.shape[3] != 3:
            raise ValueError(f"Layer image must have 1 (grayscale), 3 (RGB), or 4 (RGBA) channels. Got shape: {layer_bhwc.shape}")


        # --- Handle Batch Size Mismatch (using max_frames calculated earlier) ---
        if b_frames < max_frames:
            bg_bhwc = torch.cat([bg_bhwc, bg_bhwc[-1:].repeat(max_frames - b_frames, 1, 1, 1)], dim=0)
        elif b_frames > max_frames: 
             bg_bhwc = bg_bhwc[:max_frames]
             
        if l_frames < max_frames:
            layer_bhwc = torch.cat([layer_bhwc, layer_bhwc[-1:].repeat(max_frames - l_frames, 1, 1, 1)], dim=0)
        elif l_frames > max_frames: 
            layer_bhwc = layer_bhwc[:max_frames]

        # --- Ensure mask batch size matches (redundant check, should be correct) ---
        if mask_bhwc.shape[0] != max_frames:
             print(f"[WARNING] Correcting mask batch size mismatch. Mask: {mask_bhwc.shape[0]}, Target: {max_frames}") # Replaced log
             if mask_bhwc.shape[0] < max_frames:
                 mask_bhwc = torch.cat([mask_bhwc, mask_bhwc[-1:].repeat(max_frames - mask_bhwc.shape[0], 1, 1, 1)], dim=0)
             else:
                 mask_bhwc = mask_bhwc[:max_frames]


        # --- Resize layer and mask if needed (using interpolate) ---
        if bg_bhwc.shape[1:3] != layer_bhwc.shape[1:3]:
            target_h, target_w = bg_bhwc.shape[1:3]
            # Permute layer to BCHW for interpolate
            layer_bchw = layer_bhwc.permute(0, 3, 1, 2)
            layer_bchw_resized = F.interpolate(layer_bchw, size=(target_h, target_w), mode='bilinear', align_corners=False)
            layer_bhwc = layer_bchw_resized.permute(0, 2, 3, 1)

            # Also resize mask (it must exist at this point, either user-provided or default white)
            # Permute mask to BCHW (B, 1, H, W)
            mask_bchw = mask_bhwc.permute(0, 3, 1, 2)
            mask_bchw_resized = F.interpolate(mask_bchw, size=(target_h, target_w), mode='bilinear', align_corners=False)
            mask_bhwc = mask_bchw_resized.permute(0, 2, 3, 1)

        # --- Apply Blending Logic --- 
        blend_mode = blend_mode.lower() # Ensure lowercase
        
        # Default to layer if mode unknown, mimics normal blend before masking
        blended_layer = layer_bhwc 

        if blend_mode == "normal":
             blended_layer = self.blend_normal(bg_bhwc, layer_bhwc) # Essentially returns layer
        elif blend_mode == "multiply":
             blended_layer = self.blend_multiply(bg_bhwc, layer_bhwc)
        elif blend_mode == "screen":
             blended_layer = self.blend_screen(bg_bhwc, layer_bhwc)
        elif blend_mode == "overlay":
             blended_layer = self.blend_overlay(bg_bhwc, layer_bhwc)
        elif blend_mode == "add":
             blended_layer = self.blend_add(bg_bhwc, layer_bhwc)
        elif blend_mode == "subtract":
             blended_layer = self.blend_subtract(bg_bhwc, layer_bhwc)
        elif blend_mode == "difference":
             blended_layer = self.blend_difference(bg_bhwc, layer_bhwc)
        elif blend_mode == "darken":
             blended_layer = self.blend_darken(bg_bhwc, layer_bhwc)
        elif blend_mode == "lighten":
             blended_layer = self.blend_lighten(bg_bhwc, layer_bhwc)
        # --- Add elif conditions for other blend functions here ---
        else:
            print(f"[WARNING] Unsupported blend mode '{blend_mode}'. Using 'normal'.") # Replaced log
            blended_layer = self.blend_normal(bg_bhwc, layer_bhwc)

        # --- Apply Opacity and Mask ---
        opacity_factor = opacity / 100.0
        
        # Combine opacity with mask: effective_mask = mask * opacity
        # mask_bhwc here is either the (potentially inverted) user mask or the default white mask
        effective_mask = mask_bhwc * opacity_factor
        
        # Composite: background * (1 - effective_mask) + blended_layer * effective_mask
        output_bhwc = bg_bhwc * (1.0 - effective_mask) + blended_layer * effective_mask
        
        # Clamp final result
        output_bhwc = torch.clamp(output_bhwc, 0.0, 1.0)        
        # Return tensor on CPU as expected by ComfyUI
        return (output_bhwc.cpu(),)


class CreateImageList:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "export_alpha": ("BOOLEAN", {"default": True})
            },
            "optional": {
                "image1": ("IMAGE",),
                "image_ref": ("IMAGE",),
                "method": (
            [
                'mkl',
                'hm',
                'reinhard',
                'mvgd',
                'hm-mvgd-hm',
                'hm-mkl-hm',
            ], {
               "default": 'mkl'
            }),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "multithread": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "masks")
    FUNCTION = "batch"
    CATEGORY = "WanVideoWrapper_QQ/image"
    DESCRIPTION = """
Creates a batch of images from multiple dynamic image inputs.
Optionally applies color matching to all images if image_ref is provided.

Color matching uses the color-matcher library to transfer color characteristics
from a reference image to all batch images. This is useful for maintaining
consistent color grading across multiple images.

Supports alpha channel preservation with export_alpha option.
"""

    def load_image_with_alpha(self, image_path):
        """Load image from path with alpha channel preserved"""
        try:
            img = Image.open(image_path)

            # Handle RGBA images
            if img.mode == 'RGBA':
                img_np = np.array(img).astype(np.float32) / 255.0
                img_tensor = torch.from_numpy(img_np)[None,]  # [1, H, W, 4]
                return img_tensor
            else:
                # Convert to RGB and add alpha=1.0
                img = img.convert('RGB')
                img_np = np.array(img).astype(np.float32) / 255.0
                alpha = np.ones((img_np.shape[0], img_np.shape[1], 1), dtype=np.float32)
                img_rgba = np.concatenate([img_np, alpha], axis=2)
                img_tensor = torch.from_numpy(img_rgba)[None,]  # [1, H, W, 4]
                return img_tensor
        except Exception as e:
            print(f"Error loading image with alpha from {image_path}: {e}")
            return None

    def find_source_image_path(self, prompt, node_id, input_name):
        """Trace connections to find LoadImage node and get the filename"""
        try:
            # Get the current node from prompt
            if str(node_id) not in prompt:
                return None

            current_node = prompt[str(node_id)]
            inputs = current_node.get("inputs", {})

            # Check if the input is connected (array format: [source_node_id, source_output_index])
            if input_name in inputs and isinstance(inputs[input_name], list):
                source_node_id = str(inputs[input_name][0])

                # Recursively trace through connections
                return self._trace_to_load_image(prompt, source_node_id)

            return None
        except Exception as e:
            print(f"Error tracing connections: {e}")
            return None

    def _trace_to_load_image(self, prompt, node_id):
        """Recursively trace back to LoadImage node"""
        try:
            if node_id not in prompt:
                return None

            node = prompt[node_id]
            class_type = node.get("class_type", "")

            # Found LoadImage node!
            if class_type in ["LoadImage", "LoadImageMask"]:
                inputs = node.get("inputs", {})
                if "image" in inputs:
                    filename = inputs["image"]
                    # Get full path
                    input_dir = folder_paths.get_input_directory()
                    image_path = os.path.join(input_dir, filename)
                    if os.path.exists(image_path):
                        print(f"Found LoadImage source: {image_path}")
                        return image_path

            # Not a LoadImage, check its inputs
            inputs = node.get("inputs", {})
            for input_name, input_value in inputs.items():
                if isinstance(input_value, list):
                    source_node_id = str(input_value[0])
                    result = self._trace_to_load_image(prompt, source_node_id)
                    if result:
                        return result

            return None
        except Exception as e:
            print(f"Error in trace: {e}")
            return None

    def apply_color_match(self, images, image_ref, method, strength, multithread):
        """Apply color matching to a batch of images using a reference image"""
        try:
            from color_matcher import ColorMatcher
        except:
            raise Exception("Can't import color-matcher, did you install requirements.txt? Manual install: pip install color-matcher")

        images = images.cpu()
        image_ref = image_ref.cpu()
        batch_size = images.size(0)

        # Handle alpha channel: extract RGB for color matching
        has_alpha = images.shape[-1] == 4
        if has_alpha:
            rgb_images = images[:, :, :, :3]
            alpha_channel = images[:, :, :, 3]
        else:
            rgb_images = images

        # Extract RGB from reference if it has alpha
        if image_ref.shape[-1] == 4:
            image_ref_rgb = image_ref[:, :, :, :3]
        else:
            image_ref_rgb = image_ref

        images_rgb = rgb_images.squeeze()
        images_ref = image_ref_rgb.squeeze()

        image_ref_np = images_ref.numpy()
        images_rgb_np = images_rgb.numpy()

        def process(i):
            cm = ColorMatcher()
            image_rgb_np_i = images_rgb_np if batch_size == 1 else images_rgb[i].numpy()
            image_ref_np_i = image_ref_np if image_ref_rgb.size(0) == 1 else images_ref[i].numpy()
            try:
                image_result = cm.transfer(src=image_rgb_np_i, ref=image_ref_np_i, method=method)
                image_result = image_rgb_np_i + strength * (image_result - image_rgb_np_i)
                return torch.from_numpy(image_result)
            except Exception as e:
                print(f"Color matching thread {i} error: {e}")
                return torch.from_numpy(image_rgb_np_i)  # fallback

        if multithread and batch_size > 1:
            max_threads = min(os.cpu_count() or 1, batch_size)
            with ThreadPoolExecutor(max_workers=max_threads) as executor:
                out = list(executor.map(process, range(batch_size)))
        else:
            out = [process(i) for i in range(batch_size)]

        out = torch.stack(out, dim=0).to(torch.float32)
        out.clamp_(0, 1)

        # Reattach alpha channel if it was present
        if has_alpha:
            out = torch.cat([out, alpha_channel.unsqueeze(-1)], dim=-1)

        return out

    def batch(self, export_alpha, unique_id=None, prompt=None, image_ref=None, method='mkl', strength=1.0, multithread=True, **kwargs):
        # Collect all image inputs from kwargs (dynamic inputs)
        images = []

        # Sort by key to maintain order (image1, image2, image3, etc.)
        sorted_inputs = sorted(kwargs.items(), key=lambda x: x[0])

        for input_name, img in sorted_inputs:
            if img is not None:
                # Try to reload with alpha if tracing is available
                if prompt and unique_id:
                    path = self.find_source_image_path(prompt, unique_id, input_name)
                    if path:
                        reloaded = self.load_image_with_alpha(path)
                        if reloaded is not None:
                            print(f"Reloaded {input_name} with alpha: {path}")
                            img = reloaded

                images.append(img)

        # If no images provided, return empty tensors
        if len(images) == 0:
            empty_image = torch.zeros((1, 64, 64, 3 if not export_alpha else 4))
            empty_mask = torch.zeros((1, 64, 64))
            return (empty_image, empty_mask)

        # If only one image, just process it
        if len(images) == 1:
            img = images[0]
            # Ensure alpha channel exists
            if img.shape[-1] == 3:
                img = torch.nn.functional.pad(img, (0, 1), mode='constant', value=1.0)

            # Apply color matching if image_ref is provided
            if image_ref is not None:
                img = self.apply_color_match(img, image_ref, method, strength, multithread)

            # Extract masks
            masks = img[:, :, :, 3]

            # Conditionally strip alpha
            if export_alpha:
                output_images = img
            else:
                output_images = img[:, :, :, :3]

            return (output_images, masks)

        # Multiple images: pad channels and find max dimension
        processed_images = []
        for img in images:
            # Pad channels if needed - always ensure we have alpha channel
            if img.shape[-1] == 3:
                img = torch.nn.functional.pad(img, (0, 1), mode='constant', value=1.0)
            processed_images.append(img)

        # Find the largest dimension across all images to create square canvas
        max_dim = max(img.shape[1] for img in processed_images)
        max_dim = max(max_dim, max(img.shape[2] for img in processed_images))

        # Process each image to fit in square canvas
        def fit_to_square(img, canvas_size):
            h, w, c = img.shape[1], img.shape[2], img.shape[3]

            # If already square and correct size, return as-is
            if h == canvas_size and w == canvas_size:
                return img

            # Scale to fit (preserve aspect ratio)
            scale = canvas_size / max(h, w)
            new_h = int(h * scale)
            new_w = int(w * scale)

            # Resize (this will scale both RGB and alpha channels)
            img_bchw = img.permute(0, 3, 1, 2)
            scaled = F.interpolate(img_bchw, size=(new_h, new_w), mode='bilinear', align_corners=False)
            scaled = scaled.permute(0, 2, 3, 1)

            # Create square canvas and center the image
            canvas = torch.zeros((img.shape[0], canvas_size, canvas_size, c), dtype=img.dtype, device=img.device)
            y_offset = (canvas_size - new_h) // 2
            x_offset = (canvas_size - new_w) // 2

            # Copy entire scaled image (including its alpha) to canvas
            canvas[:, y_offset:y_offset+new_h, x_offset:x_offset+new_w, :] = scaled

            return canvas

        fitted_images = [fit_to_square(img, max_dim) for img in processed_images]

        # Concatenate all images
        s = torch.cat(fitted_images, dim=0)

        # Apply color matching if image_ref is provided
        if image_ref is not None:
            s = self.apply_color_match(s, image_ref, method, strength, multithread)

        # Extract alpha channel as masks (MASK format is BHW, not BHWC)
        masks = s[:, :, :, 3]  # Shape: [B, H, W]

        # Conditionally strip alpha channel from image output
        if export_alpha:
            output_images = s  # Keep RGBA (4 channels)
        else:
            output_images = s[:, :, :, :3]  # Strip alpha, output RGB (3 channels)

        return (output_images, masks)
class ImageBlur_GPU:
    # Strength dampening factors
    RADIAL_DIRECTIONAL_DAMPENING = 5.0  # Divide by 5 for radial and directional modes
    GAUSSIAN_DAMPENING = 1.0  # No dampening for Gaussian mode

    # Gaussian blur parameters (main blur)
    GAUSSIAN_KERNEL_MIN = 3
    GAUSSIAN_KERNEL_MAX = 101
    GAUSSIAN_SIGMA_MIN = 0.1
    GAUSSIAN_SIGMA_MAX = 30.0
    GAUSSIAN_STRENGTH_MAX = 100.0

    # Mask blur parameters (preprocessing)
    MASK_BLUR_FACTOR = 4.0  # Multiply mask blur strength by this factor
    MASK_BLUR_KERNEL_MIN = 3
    MASK_BLUR_KERNEL_MAX = 51
    MASK_BLUR_SIGMA_MIN = 0.1
    MASK_BLUR_SIGMA_MAX = 5.0
    MASK_BLUR_STRENGTH_MAX = 50.0

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",), # ComfyUI tensor [B, H, W, C], float [0, 1]
                "mode": (["radial", "directional", "gaussian"], {"default": "radial"}),
                "strength": ("FLOAT", {
                    "default": 50.0,
                    "min": 0.0,
                    "max": 100.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "directional_angle": ("FLOAT", {
                    "default": 180.0,
                    "min": 0.0,
                    "max": 360.0,
                    "step": 1.0,
                    "display": "slider"
                }),
                "center_x": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "center_y": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "num_samples": ("INT", {
                    "default": 30,
                    "min": 1,
                    "max": 256, # Keep max reasonable, but higher is possible with more VRAM
                    "step": 1,
                    "display": "number"
                }),
                "mask_grow": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 30.0,
                    "step": 0.5,
                    "display": "slider"
                }),
            },
            "optional": {
                "mask": ("MASK",),
                "mask_blur": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 50.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "char_str_mult": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 3.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "char_blur": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "bg_blur": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider"
                }),
                "duplicate_char": ("INT", {
                    "default": 32,
                    "min": 1,
                    "max": 32,
                    "step": 1,
                    "display": "number"
                }),
                "fill_cutout": ("BOOLEAN", {
                    "default": True
                }),
            }
        }
        # 3-layer compositing:
        # 1. Base layer (original image)
        # 2. bg_blur: blur whole image, mask OUT white areas (background blur)
        # 3. char_blur: blur masked pixels, extends beyond mask, composite on top (foreground blur)
        #    - char_str_mult: multiplier for blur strength on character layer (0.0-3.0, 1.0 = same)
        #    - duplicate_char: controls how many times to composite blurred layer (builds intensity)
        #    - fill_cutout: when true, fills white mask areas with border pixels before background blur

    RETURN_TYPES = ("IMAGE", "IMAGE",)
    RETURN_NAMES = ("image", "bg_image",)
    FUNCTION = "apply_radial_zoom_blur_gpu"
    CATEGORY = "WanVideoWrapper_QQ/image" # Categorize the node

    def apply_radial_zoom_blur_gpu(self, image, mode="radial", strength=50.0, directional_angle=90.0, center_x=0.5, center_y=0.5, num_samples=30, mask=None, mask_blur=0.0, char_str_mult=1.0, char_blur=1.0, bg_blur=0.0, duplicate_char=1, mask_grow=0.0, fill_cutout=True):
        # Process each image in the batch
        processed_images = []
        bg_images = []
        for i, single_image in enumerate(image):
            single_mask = mask[i:i+1] if mask is not None else None
            result, bg = self._apply_single_image(single_image.unsqueeze(0), mode, strength, directional_angle, center_x, center_y, num_samples, single_mask, mask_blur, char_str_mult, char_blur, bg_blur, duplicate_char, mask_grow, fill_cutout)
            processed_images.append(result)
            bg_images.append(bg)
        return (torch.cat(processed_images, dim=0), torch.cat(bg_images, dim=0))


    def _apply_single_image(self, image_bhwc, mode="radial", strength=50.0, directional_angle=90.0, center_x=0.5, center_y=0.5, num_samples=30, mask=None, mask_blur=0.0, char_str_mult=1.0, char_blur=1.0, bg_blur=0.0, duplicate_char=1, mask_grow=0.0, fill_cutout=True):
        """
        Applies the radial zoom blur with 3-layer compositing:
        1. Base layer (original image)
        2. bg_blur: blur whole image, mask OUT white areas (background blur)
        3. char_blur: blur masked pixels, extends beyond mask, composite on top (foreground blur)
           - char_str_mult: multiplier for blur strength on character layer (0.0-3.0, 1.0 = same)
           - duplicate_char: controls how many times to composite blurred layer (builds intensity)
           - mask_grow: expands mask outward before blur (morphological dilation)
           - fill_cutout: fills white mask areas with border pixels before background blur

        Returns:
            result: final composited image with all blur layers
            bg_image: background image without character (filled and blurred)
        """
        # ComfyUI image tensor is [B, H, W, C], float [0, 1]
        # Move to CUDA device if available
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        img_tensor = image_bhwc.to(device)
        base_layer = img_tensor.clone()  # Layer 1: Base (original image)

        # Early exit if no blur needed
        if strength <= 0 or num_samples <= 1:
            return image_bhwc.to(image_bhwc.device)

        # Get image dimensions first (needed for creating full mask)
        b, h, w, c = base_layer.shape

        # Prepare mask if provided
        if mask is not None:
            mask_tensor = mask.to(device)
            if mask_tensor.dim() == 2:  # [H, W]
                mask_tensor = mask_tensor.unsqueeze(0)  # [1, H, W]
            elif mask_tensor.dim() == 3:  # [B, H, W]
                pass  # Already [1, H, W]

            # Clamp mask values to [0, 1] range to ensure proper alpha
            mask_tensor = torch.clamp(mask_tensor, 0.0, 1.0)

            # Apply mask grow preprocessing (morphological dilation)
            # This expands the mask outward before blur
            if mask_grow > 0.0:
                mask_tensor = self._grow_mask(mask_tensor, mask_grow)

            # Apply mask blur preprocessing (Gaussian blur with replicate padding)
            # This creates smooth edges for the masked region
            if mask_blur > 0.0:
                mask_tensor = self._blur_mask(mask_tensor, mask_blur)

            has_mask = True
        else:
            # No mask provided: assume full white mask (blur entire image)
            # Create a full white mask [1, H, W] filled with 1.0
            mask_tensor = torch.ones((1, h, w), device=device, dtype=base_layer.dtype)
            has_mask = True

        # Start with base layer
        result = base_layer

        # Initialize bg_image (will be set in bg_blur section or defaults to base_layer)
        bg_image = base_layer.clone()

        # --- Layer 2: Background Blur (bg_blur) ---
        # Blur whole image, then mask OUT white areas (show blur in black areas)
        if has_mask and bg_blur > 0.0:
            # If fill_cutout is enabled, fill white mask areas with border pixels first
            if fill_cutout:
                # Create filled version of base layer (white areas filled with background)
                base_layer_filled = self._inpaint_masked_areas(base_layer, mask_tensor)
            else:
                base_layer_filled = base_layer

            # Blur the entire (possibly filled) base layer with border padding (no extension)
            blurred_out = self._apply_blur_to_image(base_layer_filled, mode, strength, directional_angle, center_x, center_y, num_samples, padding_mode='border')

            # Store the background image (filled and blurred, without character)
            bg_image = blurred_out.clone()

            # Composite using inverted mask (white areas keep original, black areas show blur)
            # alpha_out = (1 - mask) * bg_blur
            alpha_out = (1.0 - mask_tensor) * bg_blur  # [1, H, W]
            alpha_out = alpha_out.unsqueeze(-1)  # [1, H, W, 1]

            # Blend: result = base * (1 - alpha_out) + blurred * alpha_out
            result = base_layer * (1.0 - alpha_out) + blurred_out * alpha_out
            result = torch.clamp(result, 0.0, 1.0)
        elif has_mask and fill_cutout:
            # Even if bg_blur is 0, if fill_cutout is enabled, provide filled background
            base_layer_filled = self._inpaint_masked_areas(base_layer, mask_tensor)
            bg_image = base_layer_filled.clone()

        # --- Layer 3: Character Blur (char_blur) ---
        # Blur masked region with proper alpha handling to avoid black outlines
        if has_mask and char_blur > 0.0:
            # Apply strength multiplier for character layer
            char_strength = strength * char_str_mult

            # For directional blur, extend image borders where mask touches to prevent gaps
            if mode == "directional":
                # Calculate padding amount based on blur strength and direction
                # More strength = more extension needed
                max_dist = torch.sqrt(torch.tensor((w - 1.0)**2 + (h - 1.0)**2, device=device, dtype=base_layer.dtype))
                blur_extent = max_dist * (char_strength / 100.0) / self.RADIAL_DIRECTIONAL_DAMPENING
                pad_size = int(blur_extent.item()) + 10  # Add buffer

                # Extend image and mask where mask touches borders
                base_layer_extended, mask_tensor_extended = self._extend_borders_for_mask(
                    base_layer, mask_tensor, pad_size, mode, directional_angle
                )

                # Blur the extended image with border padding
                blurred_full_extended = self._apply_blur_to_image(
                    base_layer_extended, mode, char_strength, directional_angle,
                    center_x, center_y, num_samples, padding_mode='border'
                )

                # Blur the extended alpha channel
                blurred_alpha_extended = self._apply_blur_to_alpha_with_padding(
                    mask_tensor_extended, mode, char_strength, directional_angle,
                    center_x, center_y, num_samples, padding_mode='border'
                )

                # Crop back to original size
                blurred_full = blurred_full_extended[:, pad_size:pad_size+h, pad_size:pad_size+w, :]
                blurred_alpha = blurred_alpha_extended[pad_size:pad_size+h, pad_size:pad_size+w]
            else:
                # For radial and gaussian blur, use standard approach
                blurred_full = self._apply_blur_to_image(base_layer, mode, char_strength, directional_angle, center_x, center_y, num_samples, padding_mode='border')

                # Blur the alpha channel with border padding for smooth edges
                blurred_alpha = self._apply_blur_to_alpha_with_padding(mask_tensor, mode, char_strength, directional_angle, center_x, center_y, num_samples, padding_mode='border')

            # Composite using blurred alpha for smooth blending
            # The blurred alpha allows the blur to extend beyond the original mask boundaries
            alpha_in = blurred_alpha * char_blur  # [H, W] or [1, H, W]

            # Ensure proper shape for broadcasting
            if alpha_in.dim() == 2:  # [H, W]
                alpha_in = alpha_in.unsqueeze(0).unsqueeze(-1)  # [1, H, W, 1]
            elif alpha_in.dim() == 3:  # [1, H, W]
                alpha_in = alpha_in.unsqueeze(-1)  # [1, H, W, 1]

            # Apply the blur multiple times if duplicate_char > 1
            # This builds up intensity when blurred pixels have low opacity
            # Use blurred alpha directly to allow blur to extend beyond mask boundaries
            if duplicate_char > 1:
                for dup_iteration in range(duplicate_char):
                    # In-place operations to save memory
                    # result = result * (1 - alpha) + blurred * alpha
                    inv_blend = 1.0 - alpha_in
                    result.mul_(inv_blend).add_(blurred_full * alpha_in)
                    result.clamp_(0.0, 1.0)
            else:
                # Single iteration - normal operations
                result = result * (1.0 - alpha_in) + blurred_full * alpha_in
                result = torch.clamp(result, 0.0, 1.0)

        return result.cpu(), bg_image.cpu()

    def _extend_borders_for_mask(self, image_bhwc, mask_tensor, pad_size, mode, directional_angle):
        """
        Extend image borders where mask touches, using edge pixel colors.
        This prevents visible gaps when directional blur samples beyond image boundaries.

        Args:
            image_bhwc: [1, H, W, C] image tensor
            mask_tensor: [1, H, W] mask tensor
            pad_size: number of pixels to extend on each side
            mode: blur mode (for directional-aware extension)
            directional_angle: angle for directional blur

        Returns:
            extended_image: [1, H+2*pad_size, W+2*pad_size, C]
            extended_mask: [1, H+2*pad_size, W+2*pad_size]
        """
        device = image_bhwc.device
        b, h, w, c = image_bhwc.shape

        # Convert to BCHW for padding operations
        img_bchw = image_bhwc.permute(0, 3, 1, 2)  # [1, C, H, W]
        mask_b = mask_tensor  # [1, H, W]

        # Detect which borders have mask content
        # Check each border for non-zero mask pixels
        mask_hw = mask_tensor.squeeze(0)  # [H, W]

        # Top border: first row
        has_top = mask_hw[0, :].max() > 0.01
        # Bottom border: last row
        has_bottom = mask_hw[-1, :].max() > 0.01
        # Left border: first column
        has_left = mask_hw[:, 0].max() > 0.01
        # Right border: last column
        has_right = mask_hw[:, -1].max() > 0.01

        # For directional blur, prioritize extending in the blur direction
        if mode == "directional":
            angle_rad = (directional_angle - 180.0) * 3.14159 / 180.0
            dir_x = torch.cos(torch.tensor(angle_rad))
            dir_y = torch.sin(torch.tensor(angle_rad))

            # Extend more in the direction opposite to blur (where we'll sample from)
            # If blurring right (positive X), extend left border more
            if dir_x > 0.3:  # Blurring right
                has_left = True
            elif dir_x < -0.3:  # Blurring left
                has_right = True

            if dir_y > 0.3:  # Blurring down
                has_top = True
            elif dir_y < -0.3:  # Blurring up
                has_bottom = True

        # Create extended mask (zero padding by default)
        extended_mask = F.pad(mask_b, (pad_size, pad_size, pad_size, pad_size), mode='constant', value=0.0)

        # Create extended image with smart padding
        # Default to zeros, then extend borders where mask exists
        extended_img = F.pad(img_bchw, (pad_size, pad_size, pad_size, pad_size), mode='constant', value=0.0)

        # Extend borders where mask touches
        if has_top:
            # Extend top border: replicate top row upward (including corner extensions)
            # Get the top row and extend it to full extended width
            top_row = img_bchw[:, :, 0:1, :]  # [1, C, 1, W]
            # Extend top row horizontally to match extended width
            top_row_extended = F.pad(top_row, (pad_size, pad_size, 0, 0), mode='replicate')  # [1, C, 1, W+2*pad_size]
            for i in range(pad_size):
                # Fade out slightly as we extend further
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_img[:, :, pad_size-1-i:pad_size-i, :] = top_row_extended * alpha

        if has_bottom:
            # Extend bottom border: replicate bottom row downward (including corner extensions)
            bottom_row = img_bchw[:, :, -1:, :]  # [1, C, 1, W]
            # Extend bottom row horizontally to match extended width
            bottom_row_extended = F.pad(bottom_row, (pad_size, pad_size, 0, 0), mode='replicate')  # [1, C, 1, W+2*pad_size]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_img[:, :, h+pad_size+i:h+pad_size+i+1, :] = bottom_row_extended * alpha

        if has_left:
            # Extend left border: replicate left column leftward (including corner extensions)
            left_col = img_bchw[:, :, :, 0:1]  # [1, C, H, 1]
            # Extend left column vertically to match extended height
            left_col_extended = F.pad(left_col, (0, 0, pad_size, pad_size), mode='replicate')  # [1, C, H+2*pad_size, 1]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_img[:, :, :, pad_size-1-i:pad_size-i] = left_col_extended * alpha

        if has_right:
            # Extend right border: replicate right column rightward (including corner extensions)
            right_col = img_bchw[:, :, :, -1:]  # [1, C, H, 1]
            # Extend right column vertically to match extended height
            right_col_extended = F.pad(right_col, (0, 0, pad_size, pad_size), mode='replicate')  # [1, C, H+2*pad_size, 1]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_img[:, :, :, w+pad_size+i:w+pad_size+i+1] = right_col_extended * alpha

        # Also extend the mask in the same way
        if has_top:
            top_mask_row = mask_b[:, 0:1, :]  # [1, 1, W]
            # Extend top mask row horizontally to match extended width
            top_mask_row_extended = F.pad(top_mask_row, (pad_size, pad_size, 0, 0), mode='replicate')  # [1, 1, W+2*pad_size]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_mask[:, pad_size-1-i:pad_size-i, :] = top_mask_row_extended * alpha

        if has_bottom:
            bottom_mask_row = mask_b[:, -1:, :]  # [1, 1, W]
            # Extend bottom mask row horizontally to match extended width
            bottom_mask_row_extended = F.pad(bottom_mask_row, (pad_size, pad_size, 0, 0), mode='replicate')  # [1, 1, W+2*pad_size]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_mask[:, h+pad_size+i:h+pad_size+i+1, :] = bottom_mask_row_extended * alpha

        if has_left:
            left_mask_col = mask_b[:, :, 0:1]  # [1, H, 1]
            # Extend left mask column vertically to match extended height
            left_mask_col_extended = F.pad(left_mask_col, (0, 0, pad_size, pad_size), mode='replicate')  # [1, H+2*pad_size, 1]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_mask[:, :, pad_size-1-i:pad_size-i] = left_mask_col_extended * alpha

        if has_right:
            right_mask_col = mask_b[:, :, -1:]  # [1, H, 1]
            # Extend right mask column vertically to match extended height
            right_mask_col_extended = F.pad(right_mask_col, (0, 0, pad_size, pad_size), mode='replicate')  # [1, H+2*pad_size, 1]
            for i in range(pad_size):
                alpha = 1.0 - (i / pad_size) * 0.3
                extended_mask[:, :, w+pad_size+i:w+pad_size+i+1] = right_mask_col_extended * alpha

        # Convert back to BHWC
        extended_image_bhwc = extended_img.permute(0, 2, 3, 1)  # [1, H+2*pad, W+2*pad, C]

        return extended_image_bhwc, extended_mask

    def _apply_blur_to_image(self, image_bhwc, mode, strength, directional_angle, center_x, center_y, num_samples, padding_mode='border'):
        """Apply radial zoom or directional motion blur to an image tensor."""
        device = image_bhwc.device
        img_bchw = image_bhwc.permute(0, 3, 1, 2)
        b, c, h, w = img_bchw.shape

        # Early exit if no blur needed
        if strength <= 0 or num_samples <= 1:
            return image_bhwc

        # Dampen strength for radial and directional modes (Gaussian uses full strength)
        if mode in ["radial", "directional"]:
            strength = strength / self.RADIAL_DIRECTIONAL_DAMPENING

        if mode == "gaussian":
            # Gaussian blur: controlled only by strength
            # Import torchvision for Gaussian blur
            try:
                from torchvision.transforms import GaussianBlur

                # Calculate kernel size and sigma based on strength
                # Map strength (0-100) to kernel size (3-101) and sigma (0.1-30)
                kernel_size = int(self.GAUSSIAN_KERNEL_MIN + (strength / self.GAUSSIAN_STRENGTH_MAX) * (self.GAUSSIAN_KERNEL_MAX - self.GAUSSIAN_KERNEL_MIN))
                kernel_size = kernel_size if kernel_size % 2 == 1 else kernel_size + 1  # Ensure odd number
                sigma = self.GAUSSIAN_SIGMA_MIN + (strength / self.GAUSSIAN_STRENGTH_MAX) * (self.GAUSSIAN_SIGMA_MAX - self.GAUSSIAN_SIGMA_MIN)

                # Apply Gaussian blur
                gaussian_blur = GaussianBlur(kernel_size=(kernel_size, kernel_size), sigma=(sigma, sigma))

                # Apply to each image in batch
                blurred_images = []
                for i in range(img_bchw.shape[0]):
                    img_single = img_bchw[i:i+1]  # [1, C, H, W]
                    img_blurred = gaussian_blur(img_single)
                    blurred_images.append(img_blurred)

                # Concatenate back
                img_bchw_blurred = torch.cat(blurred_images, dim=0)  # [B, C, H, W]

                # Reshape back to [B, H, W, C]
                output_bhwc = img_bchw_blurred.permute(0, 2, 3, 1)  # [B, H, W, C]
                output_bhwc = torch.clamp(output_bhwc, 0.0, 1.0)
                return output_bhwc

            except ImportError:
                # Fallback: simple box blur if torchvision not available
                print("Warning: torchvision not available, using simple box blur instead")
                # For now, just return original
                return image_bhwc

        elif mode == "directional":
            # Directional blur: use angle instead of center point
            # Convert angle to radians (180 degrees = horizontal left to right)
            # Adjust by -180 degrees so 180° = horizontal (1, 0)
            angle_rad = torch.tensor((directional_angle - 180.0) * 3.14159 / 180.0, device=device, dtype=img_bchw.dtype)

            # Direction vector based on angle
            # 180° = horizontal (1, 0), 90° = vertical (0, 1), 270° = vertical (0, -1)
            dir_x = torch.cos(angle_rad)
            dir_y = torch.sin(angle_rad)
            direction = torch.tensor([dir_x, dir_y], device=device, dtype=img_bchw.dtype)

            # For directional blur, center is not used - blur is uniform across image
            center_pos = None
        else:
            # Radial blur: use center point
            # Calculate center in pixel coordinates (0-indexed)
            cx = center_x * (w - 1.0)
            cy = center_y * (h - 1.0)
            center_pos = torch.tensor([cx, cy], device=device, dtype=img_bchw.dtype)
            direction = None

        # --- Generate Sampling Grid ---
        y_coords = torch.arange(h, device=device, dtype=img_bchw.dtype)
        x_coords = torch.arange(w, device=device, dtype=img_bchw.dtype)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')
        out_coords = torch.stack([grid_x, grid_y], dim=-1)

        if mode == "directional":
            # Directional blur: all pixels blur in the same direction
            # Calculate blur length based on image diagonal (uniform across image)
            max_dist = torch.sqrt(torch.tensor((w - 1.0)**2 + (h - 1.0)**2, device=device, dtype=img_bchw.dtype))
            sample_line_length = max_dist * (strength / 100.0)  # Scalar

            # Direction vector for all pixels
            unit_direction = direction / torch.linalg.norm(direction)  # Normalize to unit vector

            # Steps for sampling
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=img_bchw.dtype)

            # Offset vectors: all pixels blur in same direction
            # Shape: [num_samples, 1, 1, 2] - broadcast across all pixels
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_length * unit_direction.view(1, 1, 1, 2)

            # Sample points
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors  # [num_samples, H, W, 2]
        else:
            # Radial blur: calculate vectors from center for each pixel
            vecs_to_pixel = out_coords - center_pos
            dists_to_center = torch.linalg.norm(vecs_to_pixel, dim=-1, keepdim=True)
            epsilon = 1e-6
            unit_vecs_to_pixel = torch.where(
                dists_to_center < epsilon,
                torch.zeros_like(vecs_to_pixel),
                vecs_to_pixel / dists_to_center
            )

            # Calculate sample line lengths (scales with distance from center)
            sample_line_lengths = dists_to_center * (strength / 100.0)
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=img_bchw.dtype)
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_lengths.view(1, h, w, 1) * unit_vecs_to_pixel.view(1, h, w, 2)
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors

        # Prepare for grid_sample
        img_input_for_grid = img_bchw.repeat(num_samples, 1, 1, 1)
        grid_pixel_coords = sample_points_pixel

        # Normalize pixel coordinates
        norm_x_factor = 2.0 / max(w - 1.0, 1e-6)
        norm_y_factor = 2.0 / max(h - 1.0, 1e-6)
        grid_x_norm = (grid_pixel_coords[..., 0] * norm_x_factor) - 1.0
        grid_y_norm = (grid_pixel_coords[..., 1] * norm_y_factor) - 1.0
        grid_normalized = torch.stack([grid_x_norm, grid_y_norm], dim=-1)

        # Perform grid sampling
        sampled_values = F.grid_sample(
            img_input_for_grid,
            grid_normalized,
            mode='bilinear',
            padding_mode=padding_mode,
            align_corners=True
        )

        # Average and reshape
        output_chw = torch.mean(sampled_values, dim=0)
        output_hwc = output_chw.permute(1, 2, 0)
        output_bhwc = output_hwc.unsqueeze(0)
        output_bhwc = torch.clamp(output_bhwc, 0.0, 1.0)

        return output_bhwc

    def _apply_blur_to_alpha_with_padding(self, alpha, mode, strength, directional_angle, center_x, center_y, num_samples, padding_mode='border'):
        """Apply radial zoom or directional motion blur to an alpha channel with configurable padding."""
        device = alpha.device

        # Handle different input shapes: [H, W] or [1, H, W]
        if alpha.dim() == 2:  # [H, W]
            h, w = alpha.shape
            alpha_b = alpha.unsqueeze(0).unsqueeze(1)  # [1, 1, H, W]
        elif alpha.dim() == 3:  # [1, H, W]
            b, h, w = alpha.shape
            alpha_b = alpha.unsqueeze(1)  # [1, 1, H, W]
        else:
            raise ValueError(f"Unexpected alpha shape: {alpha.shape}")

        # Early exit if no blur needed
        if strength <= 0 or num_samples <= 1:
            return alpha.squeeze(0) if alpha.dim() == 3 else alpha

        # Dampen strength for radial and directional modes (Gaussian uses full strength)
        if mode in ["radial", "directional"]:
            strength = strength / self.RADIAL_DIRECTIONAL_DAMPENING

        if mode == "gaussian":
            # Gaussian blur: controlled only by strength
            try:
                from torchvision.transforms import GaussianBlur

                # Calculate kernel size and sigma based on strength
                kernel_size = int(3 + (strength / 100.0) * 98)  # 3 to 101
                kernel_size = kernel_size if kernel_size % 2 == 1 else kernel_size + 1
                sigma = 0.1 + (strength / 100.0) * 29.9  # 0.1 to 30.0

                # Apply Gaussian blur with manual padding to support padding_mode
                # For Gaussian blur, we need to manually pad if we want border/replicate padding
                if padding_mode == 'border':
                    pad_size = kernel_size // 2
                    alpha_b_padded = F.pad(alpha_b, (pad_size, pad_size, pad_size, pad_size), mode='replicate')
                    gaussian_blur = GaussianBlur(kernel_size=(kernel_size, kernel_size), sigma=(sigma, sigma))
                    alpha_b_blurred_padded = gaussian_blur(alpha_b_padded)
                    alpha_b_blurred = alpha_b_blurred_padded[:, :, pad_size:pad_size+h, pad_size:pad_size+w]
                else:
                    gaussian_blur = GaussianBlur(kernel_size=(kernel_size, kernel_size), sigma=(sigma, sigma))
                    alpha_b_blurred = gaussian_blur(alpha_b)

                # Return [H, W]
                return alpha_b_blurred.squeeze(0).squeeze(0)

            except ImportError:
                # Fallback: return original
                return alpha.squeeze(0) if alpha.dim() == 3 else alpha

        elif mode == "directional":
            # Directional blur: use angle (180° = horizontal left to right)
            angle_rad = torch.tensor((directional_angle - 180.0) * 3.14159 / 180.0, device=device, dtype=alpha.dtype)
            dir_x = torch.cos(angle_rad)
            dir_y = torch.sin(angle_rad)
            direction = torch.tensor([dir_x, dir_y], device=device, dtype=alpha.dtype)
            center_pos = None
        else:
            # Radial blur: use center point
            cx = center_x * (w - 1.0)
            cy = center_y * (h - 1.0)
            center_pos = torch.tensor([cx, cy], device=device, dtype=alpha.dtype)
            direction = None

        # Generate sampling grid
        y_coords = torch.arange(h, device=device, dtype=alpha.dtype)
        x_coords = torch.arange(w, device=device, dtype=alpha.dtype)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')
        out_coords = torch.stack([grid_x, grid_y], dim=-1)

        if mode == "directional":
            # Directional blur: all pixels blur in the same direction
            max_dist = torch.sqrt(torch.tensor((w - 1.0)**2 + (h - 1.0)**2, device=device, dtype=alpha.dtype))
            sample_line_length = max_dist * (strength / 100.0)
            unit_direction = direction / torch.linalg.norm(direction)
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=alpha.dtype)
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_length * unit_direction.view(1, 1, 1, 2)
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors
        else:
            # Radial blur: calculate vectors from center for each pixel
            vecs_to_pixel = out_coords - center_pos
            dists_to_center = torch.linalg.norm(vecs_to_pixel, dim=-1, keepdim=True)
            epsilon = 1e-6
            unit_vecs_to_pixel = torch.where(
                dists_to_center < epsilon,
                torch.zeros_like(vecs_to_pixel),
                vecs_to_pixel / dists_to_center
            )
            sample_line_lengths = dists_to_center * (strength / 100.0)
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=alpha.dtype)
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_lengths.view(1, h, w, 1) * unit_vecs_to_pixel.view(1, h, w, 2)
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors

        # Prepare for grid_sample
        alpha_input = alpha_b.repeat(num_samples, 1, 1, 1)
        grid_pixel_coords = sample_points_pixel

        # Normalize pixel coordinates
        norm_x_factor = 2.0 / max(w - 1.0, 1e-6)
        norm_y_factor = 2.0 / max(h - 1.0, 1e-6)
        grid_x_norm = (grid_pixel_coords[..., 0] * norm_x_factor) - 1.0
        grid_y_norm = (grid_pixel_coords[..., 1] * norm_y_factor) - 1.0
        grid_normalized = torch.stack([grid_x_norm, grid_y_norm], dim=-1)

        # Perform grid sampling with specified padding mode
        sampled_alpha = F.grid_sample(
            alpha_input,
            grid_normalized,
            mode='bilinear',
            padding_mode=padding_mode,
            align_corners=True
        )

        # Average and return [H, W]
        blurred_alpha = torch.mean(sampled_alpha, dim=0).squeeze(0).squeeze(0)
        return blurred_alpha

    def _apply_blur_to_alpha(self, alpha, mode, strength, directional_angle, center_x, center_y, num_samples):
        """Apply radial zoom or directional motion blur to an alpha channel."""
        device = alpha.device

        # Handle different input shapes: [H, W] or [1, H, W]
        if alpha.dim() == 2:  # [H, W]
            h, w = alpha.shape
            alpha_b = alpha.unsqueeze(0).unsqueeze(1)  # [1, 1, H, W]
        elif alpha.dim() == 3:  # [1, H, W]
            b, h, w = alpha.shape
            alpha_b = alpha.unsqueeze(1)  # [1, 1, H, W]
        else:
            raise ValueError(f"Unexpected alpha shape: {alpha.shape}")

        # Early exit if no blur needed
        if strength <= 0 or num_samples <= 1:
            return alpha.squeeze(0) if alpha.dim() == 3 else alpha

        # Dampen strength for radial and directional modes (Gaussian uses full strength)
        if mode in ["radial", "directional"]:
            strength = strength / self.RADIAL_DIRECTIONAL_DAMPENING

        if mode == "gaussian":
            # Gaussian blur: controlled only by strength
            try:
                from torchvision.transforms import GaussianBlur

                # Calculate kernel size and sigma based on strength
                kernel_size = int(3 + (strength / 100.0) * 98)  # 3 to 101
                kernel_size = kernel_size if kernel_size % 2 == 1 else kernel_size + 1
                sigma = 0.1 + (strength / 100.0) * 29.9  # 0.1 to 30.0

                # Apply Gaussian blur
                gaussian_blur = GaussianBlur(kernel_size=(kernel_size, kernel_size), sigma=(sigma, sigma))
                alpha_b_blurred = gaussian_blur(alpha_b)  # [1, 1, H, W]

                # Return [H, W]
                return alpha_b_blurred.squeeze(0).squeeze(0)

            except ImportError:
                # Fallback: return original
                return alpha.squeeze(0) if alpha.dim() == 3 else alpha

        elif mode == "directional":
            # Directional blur: use angle (180° = horizontal left to right)
            angle_rad = torch.tensor((directional_angle - 180.0) * 3.14159 / 180.0, device=device, dtype=alpha.dtype)
            dir_x = torch.cos(angle_rad)
            dir_y = torch.sin(angle_rad)
            direction = torch.tensor([dir_x, dir_y], device=device, dtype=alpha.dtype)
            center_pos = None
        else:
            # Radial blur: use center point
            cx = center_x * (w - 1.0)
            cy = center_y * (h - 1.0)
            center_pos = torch.tensor([cx, cy], device=device, dtype=alpha.dtype)
            direction = None

        # Generate sampling grid
        y_coords = torch.arange(h, device=device, dtype=alpha.dtype)
        x_coords = torch.arange(w, device=device, dtype=alpha.dtype)
        grid_y, grid_x = torch.meshgrid(y_coords, x_coords, indexing='ij')
        out_coords = torch.stack([grid_x, grid_y], dim=-1)

        if mode == "directional":
            # Directional blur: all pixels blur in the same direction
            max_dist = torch.sqrt(torch.tensor((w - 1.0)**2 + (h - 1.0)**2, device=device, dtype=alpha.dtype))
            sample_line_length = max_dist * (strength / 100.0)
            unit_direction = direction / torch.linalg.norm(direction)
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=alpha.dtype)
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_length * unit_direction.view(1, 1, 1, 2)
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors
        else:
            # Radial blur: calculate vectors from center for each pixel
            vecs_to_pixel = out_coords - center_pos
            dists_to_center = torch.linalg.norm(vecs_to_pixel, dim=-1, keepdim=True)
            epsilon = 1e-6
            unit_vecs_to_pixel = torch.where(
                dists_to_center < epsilon,
                torch.zeros_like(vecs_to_pixel),
                vecs_to_pixel / dists_to_center
            )
            sample_line_lengths = dists_to_center * (strength / 100.0)
            steps = torch.linspace(0, 1, num_samples, device=device, dtype=alpha.dtype)
            offset_vectors = steps.view(num_samples, 1, 1, 1) * sample_line_lengths.view(1, h, w, 1) * unit_vecs_to_pixel.view(1, h, w, 2)
            sample_points_pixel = out_coords.unsqueeze(0) - offset_vectors

        # Prepare for grid_sample
        alpha_input = alpha_b.repeat(num_samples, 1, 1, 1)
        grid_pixel_coords = sample_points_pixel

        # Normalize pixel coordinates
        norm_x_factor = 2.0 / max(w - 1.0, 1e-6)
        norm_y_factor = 2.0 / max(h - 1.0, 1e-6)
        grid_x_norm = (grid_pixel_coords[..., 0] * norm_x_factor) - 1.0
        grid_y_norm = (grid_pixel_coords[..., 1] * norm_y_factor) - 1.0
        grid_normalized = torch.stack([grid_x_norm, grid_y_norm], dim=-1)

        # Perform grid sampling with zeros padding
        sampled_alpha = F.grid_sample(
            alpha_input,
            grid_normalized,
            mode='bilinear',
            padding_mode='zeros',
            align_corners=True
        )

        # Average and return [H, W]
        blurred_alpha = torch.mean(sampled_alpha, dim=0).squeeze(0).squeeze(0)
        return blurred_alpha

    def _grow_mask(self, mask_tensor, grow_amount):
        """
        Apply morphological dilation to grow/expand the mask outward.
        mask_tensor: [1, H, W] or [H, W]
        grow_amount: float, controls how many pixels to grow (0-30)
        """
        device = mask_tensor.device

        # Ensure mask is [1, 1, H, W] for processing
        if mask_tensor.dim() == 2:  # [H, W]
            mask_4d = mask_tensor.unsqueeze(0).unsqueeze(0)  # [1, 1, H, W]
            original_shape = "2d"
        elif mask_tensor.dim() == 3:  # [1, H, W]
            mask_4d = mask_tensor.unsqueeze(1)  # [1, 1, H, W]
            original_shape = "3d"
        else:
            mask_4d = mask_tensor
            original_shape = "4d"

        h, w = mask_4d.shape[-2:]

        # Convert grow_amount to integer iterations
        # Each iteration grows by 1 pixel
        num_iterations = int(grow_amount)

        if num_iterations <= 0:
            return mask_tensor

        # Create a circular structuring element (kernel)
        # For each iteration, we dilate the mask
        grown_mask = mask_4d.clone()

        for _ in range(num_iterations):
            # Use max pooling with a 3x3 kernel for dilation
            # This grows white regions outward
            kernel_size = 3
            padding = 1

            # Pad the mask to handle edges
            padded = F.pad(grown_mask, (padding, padding, padding, padding), mode='replicate')

            # Apply max pooling (dilation)
            # Reshape for max_pool2d: [1, 1, H, W]
            dilated = F.max_pool2d(padded, kernel_size=kernel_size, stride=1, padding=0)

            grown_mask = dilated

        # Return in original format
        if original_shape == "2d":
            return grown_mask.squeeze(0).squeeze(0)  # [H, W]
        elif original_shape == "3d":
            return grown_mask.squeeze(1)  # [1, H, W]
        else:
            return grown_mask  # [1, 1, H, W]

    def _inpaint_masked_areas(self, image_bhwc, mask_tensor):
        """
        Fill masked (white) areas of the image using inpainting from border pixels.
        Similar to VideoInpaint approach - uses OpenCV inpainting to fill white areas.

        Args:
            image_bhwc: [1, H, W, C] image tensor
            mask_tensor: [1, H, W] mask tensor (white = areas to fill)

        Returns:
            filled_image: [1, H, W, C] image tensor with white areas filled
        """
        try:
            # Convert to numpy for OpenCV
            image_np = image_bhwc[0].mul(255).byte().cpu().numpy()  # [H, W, C] uint8
            mask_np = mask_tensor[0].cpu().numpy()  # [H, W]

            # Ensure RGB format
            if image_np.shape[-1] != 3:
                # If not RGB, use first 3 channels
                if image_np.shape[-1] >= 3:
                    image_np = image_np[..., :3]
                else:
                    # Grayscale, convert to RGB
                    image_np = cv2.cvtColor(image_np, cv2.COLOR_GRAY2RGB)

            # Prepare mask (white areas = areas to inpaint)
            # Mask threshold: consider pixels > 0.01 as "to be filled"
            mask_binary = (mask_np > 0.01).astype(np.uint8) * 255

            # Check if mask has any active areas
            if not np.any(mask_binary > 0):
                return image_bhwc

            # Convert to BGR for OpenCV
            image_bgr = cv2.cvtColor(image_np, cv2.COLOR_RGB2BGR)

            # Apply inpainting using Telea algorithm
            # inpaintRadius = 3 (same as VideoInpaint)
            inpainted_bgr = cv2.inpaint(image_bgr, mask_binary, 3, cv2.INPAINT_TELEA)

            # Convert back to RGB
            inpainted_rgb = cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2RGB)

            # Convert back to tensor
            inpainted_tensor = torch.from_numpy(inpainted_rgb).float().div(255.0).to(image_bhwc.device)
            inpainted_tensor = inpainted_tensor.unsqueeze(0)  # [1, H, W, C]

            return inpainted_tensor

        except Exception as e:
            print(f"[ImageBlur_GPU WARNING] inpaint_masked_areas failed: {e}")
            # Fallback: return original image
            return image_bhwc

    def _blur_mask(self, mask_tensor, blur_strength):
        """
        Apply Gaussian blur to mask with replicate padding to avoid edge bleeding.
        mask_tensor: [1, H, W] or [H, W]
        blur_strength: float, controls blur amount
        """
        try:
            from torchvision.transforms import GaussianBlur

            # Ensure mask is [1, 1, H, W] for GaussianBlur
            if mask_tensor.dim() == 2:  # [H, W]
                mask_4d = mask_tensor.unsqueeze(0).unsqueeze(0)  # [1, 1, H, W]
            elif mask_tensor.dim() == 3:  # [1, H, W]
                mask_4d = mask_tensor.unsqueeze(1)  # [1, 1, H, W]
            else:
                mask_4d = mask_tensor

            h, w = mask_4d.shape[-2:]

            # Apply mask blur strength factor
            effective_strength = blur_strength * self.MASK_BLUR_FACTOR

            # Calculate kernel size and sigma based on blur_strength
            # Use smaller range for mask blur (0-50) vs main blur (0-100)
            kernel_size = int(self.MASK_BLUR_KERNEL_MIN + (effective_strength / self.MASK_BLUR_STRENGTH_MAX) * (self.MASK_BLUR_KERNEL_MAX - self.MASK_BLUR_KERNEL_MIN))
            kernel_size = kernel_size if kernel_size % 2 == 1 else kernel_size + 1
            sigma = self.MASK_BLUR_SIGMA_MIN + (effective_strength / self.MASK_BLUR_STRENGTH_MAX) * (self.MASK_BLUR_SIGMA_MAX - self.MASK_BLUR_SIGMA_MIN)

            # Apply Gaussian blur
            # Note: GaussianBlur uses 'zeros' padding by default, which we don't want
            # We'll manually apply replicate padding first
            pad_size = kernel_size // 2

            # Pad with replicate (edge) padding to avoid edge bleeding
            mask_padded = F.pad(mask_4d, (pad_size, pad_size, pad_size, pad_size), mode='replicate')

            # Apply blur to padded mask
            gaussian_blur = GaussianBlur(kernel_size=(kernel_size, kernel_size), sigma=(sigma, sigma))
            mask_blurred_padded = gaussian_blur(mask_padded)

            # Crop back to original size
            mask_blurred = mask_blurred_padded[:, :, pad_size:pad_size+h, pad_size:pad_size+w]

            # Return in original format
            if mask_tensor.dim() == 2:  # Was [H, W]
                return mask_blurred.squeeze(0).squeeze(0)  # [H, W]
            else:  # Was [1, H, W]
                return mask_blurred.squeeze(1)  # [1, H, W]

        except ImportError:
            # Fallback: return original mask
            return mask_tensor

class WanScaleAB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "A2size": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 16}),
                "A1scale": ("FLOAT", {"default": 0.5, "min": 0.1, "max": 2.0, "step": 0.1}),
                "scaling_method": (["area","lanczos","bilinear", "bicubic" ,"nearest" ], {"default": "area"}),
                "match_to": (["A_crop", "A_stretch", "B_crop", "B_stretch",], {"default": "A_crop"}),
                "divisible_by": ("INT", {"default": 16, "min": 0, "max": 128, "step": 16}),
                "direct_scale": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image_B": ("IMAGE",),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image_A1", "image_A2", "image_B1", "image_B2")
    FUNCTION = "scale_images"
    CATEGORY = "WanVideoWrapper_QQ/image"
    
    def scale_images(self, image_A, A2size, A1scale, scaling_method, match_to, divisible_by, direct_scale, image_B=None):
        # If B_stretch is selected and image_B is present, use modular approach
        if image_B is not None and match_to == "B_stretch":
            # Step 1: Calculate image_B2 and image_B1 dimensions using image_A's methods
            b_s1, b_s2 = self._calculate_s1_s2(image_B, A2size, divisible_by)

            # Get image_B dimensions for aspect ratio
            _, b_h, b_w, _ = image_B.shape

            # Calculate image_B1 dimensions as scaled version of B2
            # Special case: when A1scale=1.0, B1 should match B2 dimensions exactly
            if abs(A1scale - 1.0) < 1e-6:
                b_target_h = b_s1
                b_target_w = b_s2
            else:
                if direct_scale:
                    # When direct_scale is True, just multiply by A1scale without ensuring divisibility
                    b_target_h = int(b_s1 * A1scale)
                    b_target_w = int(b_s2 * A1scale)
                else:
                    # When direct_scale is False, ensure divisibility by divisible_by
                    b_target_h = self._round_up_to_multiple(b_s1 * A1scale, divisible_by)
                    b_target_w = self._round_up_to_multiple(b_s2 * A1scale, divisible_by)
            
            # Step 2: Now reverse the process - use these dimensions for image_A
            # Calculate image_A2 and image_A1 using image_B's calculated dimensions
            image_A2 = self._scale_image(image_A, b_s1, b_s2, scaling_method)
            image_A1 = self._scale_image(image_A, int(b_target_h), int(b_target_w), scaling_method)
            
            # Step 3: Create image_B outputs using the calculated dimensions
            image_B2 = self._scale_image(image_B, b_s1, b_s2, scaling_method)
            image_B1 = self._scale_image(image_B, int(b_target_h), int(b_target_w), scaling_method)
        elif image_B is not None and match_to == "B_crop":
            # B_crop should work like B_stretch for dimension calculations but use cropping
            # Step 1: Calculate image_B2 and image_B1 dimensions using image_B's methods (like B_stretch)
            b_s1, b_s2 = self._calculate_s1_s2(image_B, A2size, divisible_by)

            # Step 2: Scale and crop image_A to match image_B2's dimensions (reversed from A_crop)
            image_A2 = self._scale_and_crop_to_match(image_A, b_s1, b_s2, scaling_method)

            # Step 3: Calculate image_B1 dimensions as scaled version of B2
            if abs(A1scale - 1.0) < 1e-6:
                b_target_h = b_s1
                b_target_w = b_s2
            else:
                if direct_scale:
                    # When direct_scale is True, just multiply by A1scale without ensuring divisibility
                    b_target_h = int(b_s1 * A1scale)
                    b_target_w = int(b_s2 * A1scale)
                else:
                    # When direct_scale is False, ensure divisibility by divisible_by
                    b_target_h = self._round_up_to_multiple(b_s1 * A1scale, divisible_by)
                    b_target_w = self._round_up_to_multiple(b_s2 * A1scale, divisible_by)

            # Step 4: Scale image_B to preserve aspect ratio while fitting within target dimensions
            image_B1 = self._scale_and_crop_to_match(image_B, int(b_target_h), int(b_target_w), scaling_method)
            image_B2 = self._scale_image(image_B, b_s1, b_s2, scaling_method)

            # Step 5: Scale image_A1 to preserve aspect ratio while fitting within B1 dimensions
            # This ensures image_A is cropped to match image_B's calculated dimensions
            image_A1 = self._scale_and_crop_to_match(image_A, int(b_target_h), int(b_target_w), scaling_method)
        else:
            # Original logic for other match_to options (A_crop, A_stretch, etc.)
            # Calculate s1 and s2 for image_A2
            s1, s2 = self._calculate_s1_s2(image_A, A2size, divisible_by)

            # Get original dimensions of image_A
            _, h, w, _ = image_A.shape

            # Process image_A1 as a direct scaled version of A2 (s1, s2)
            # Special case: when A1scale=1.0, A1 should match A2 dimensions exactly
            if abs(A1scale - 1.0) < 1e-6:
                target_height = s1
                target_width = s2
            else:
                if direct_scale:
                    # When direct_scale is True, just multiply by A1scale without ensuring divisibility
                    target_height = int(s1 * A1scale)
                    target_width = int(s2 * A1scale)
                else:
                    # When direct_scale is False, ensure divisibility by divisible_by
                    target_height = self._round_up_to_multiple(s1 * A1scale, divisible_by)
                    target_width = self._round_up_to_multiple(s2 * A1scale, divisible_by)

            # Scale image_A1 and image_A2
            image_A1 = self._scale_image(image_A, int(target_height), int(target_width), scaling_method)
            image_A2 = self._scale_image(image_A, s1, s2, scaling_method)

            # Process image_B based on match_to option
            if image_B is not None:
                if match_to == "A_stretch":
                    # Scale image_B to match image_A2 and image_A1 sizes
                    image_B1 = self._scale_image(image_B, int(target_height), int(target_width), scaling_method)
                    image_B2 = self._scale_image(image_B, s1, s2, scaling_method)
                elif match_to == "A_crop":
                    # Scale and crop image_B to match image_A2 dimensions
                    image_B2 = self._scale_and_crop_to_match(image_B, s1, s2, scaling_method)
                    # Scale image_B1 to preserve aspect ratio while fitting within A1 dimensions
                    # This prevents stretching when image_A and image_B have different aspect ratios
                    image_B1 = self._scale_and_crop_to_match(image_B, int(target_height), int(target_width), scaling_method)
                else:
                    # Default behavior for other match_to options
                    # Get original dimensions
                    _, h, w, _ = image_B.shape
                    # Calculate new dimensions based on scale
                    new_h = int(h * A1scale)
                    new_w = int(w * A1scale)
                    image_B1 = self._scale_image(image_B, new_h, new_w, scaling_method)
                    image_B2 = self._scale_image(image_B, new_h, new_w, scaling_method)
            else:
                # Return empty tensors if image_B is not provided
                image_B1 = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
                image_B2 = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        
        return (image_A1, image_A2, image_B1, image_B2)
    
    def _calculate_s1_s2(self, image_A, A2size, divisible_by):
        """
        Calculate s1 and s2 based on the special scaling rules.

        s1: Target the largest side to be approximately A2size (rounded up to a multiple of divisible_by),
            regardless of how many times A2size fits into the original largest side. This ensures
            A2size is respected as the intended output size for the larger dimension.
        s2: Proportionally scale the smallest side to match s1, then adjust to be divisible by divisible_by (rounding up)
        """
        # Get original dimensions
        _, h, w, _ = image_A.shape

        # Determine which is the largest and smallest side
        if h >= w:
            largest_side = h
            smallest_side = w
        else:
            largest_side = w
            smallest_side = h

        # Step 1: Compute s1 so that the output's largest side is ~A2size
        # Round A2size up to the nearest multiple of divisible_by to satisfy model constraints
        s1 = self._round_up_to_multiple(A2size, divisible_by)

        # Step 2: Find s2
        # Calculate the proportional scaling factor
        scale_factor = s1 / largest_side

        # Apply this scaling to the smallest side
        scaled_smallest = smallest_side * scale_factor

        # Find s2 as the closest multiple of divisible_by (rounding up)
        s2 = self._round_up_to_multiple(scaled_smallest, divisible_by)

        # Determine the final dimensions based on original orientation
        if h >= w:
            # Height was the largest side
            return s1, s2
        else:
            # Width was the largest side
            return s2, s1
    
    def _round_up_to_multiple(self, value, multiple):
        """Round up value to the nearest multiple of 'multiple'."""
        import math
        return int(math.ceil(value / multiple) * multiple)
    
    
    def _scale_and_crop_to_match(self, image, target_h, target_w, method):
        """
        Scale image proportionally to match the largest side of target dimensions,
        then crop from center to exactly match target dimensions.
        """
        # Get original dimensions
        _, h, w, _ = image.shape
        
        # Determine which dimension to match
        if target_h >= target_w:
            # Target height is larger, match height
            scale_factor = target_h / h
            scaled_h = target_h
            scaled_w = int(w * scale_factor)
        else:
            # Target width is larger, match width
            scale_factor = target_w / w
            scaled_h = int(h * scale_factor)
            scaled_w = target_w
        
        # Scale the image
        scaled_image = self._scale_image(image, scaled_h, scaled_w, method)
        
        # Calculate crop amounts to center the image
        if scaled_h > target_h:
            # Need to crop height
            crop_h = (scaled_h - target_h) // 2
            cropped_image = scaled_image[:, crop_h:crop_h+target_h, :, :]
        else:
            # No height cropping needed
            cropped_image = scaled_image
        
        if scaled_w > target_w:
            # Need to crop width
            crop_w = (scaled_w - target_w) // 2
            cropped_image = cropped_image[:, :, crop_w:crop_w+target_w, :]
        
        # Ensure the final dimensions match exactly
        final_h, final_w = cropped_image.shape[1], cropped_image.shape[2]
        if final_h != target_h or final_w != target_w:
            # If dimensions still don't match, force resize
            cropped_image = self._scale_image(cropped_image, target_h, target_w, method)
        
        return cropped_image
    
    def _scale_image(self, image, height, width, method):
        """Helper function to scale an image to the specified dimensions."""
        # Convert from BHWC to BCHW for F.interpolate
        image_bchw = image.permute(0, 3, 1, 2)
        
        # Determine interpolation mode based on method string
        if method == "bilinear":
            mode = 'bilinear'
            align_corners = False
        elif method == "nearest":
            mode = 'nearest'
            align_corners = None
        elif method == "bicubic":
            mode = 'bicubic'
            align_corners = False
        elif method == "area":
            mode = 'area'
            align_corners = None
        elif method == "lanczos":
            # PyTorch doesn't have lanczos, use bicubic as approximation
            mode = 'bicubic'
            align_corners = False
        else:
            # Default to bilinear
            mode = 'bilinear'
            align_corners = False
        
        # Perform interpolation
        if align_corners is not None:
            resized = F.interpolate(image_bchw, size=(height, width), mode=mode, align_corners=align_corners)
        else:
            resized = F.interpolate(image_bchw, size=(height, width), mode=mode)
        
        # Convert back to BHWC
        return resized.permute(0, 2, 3, 1)

NODE_CLASS_MAPPINGS = {
    "CreateImageList": CreateImageList,
    "ImageBlur_GPU": ImageBlur_GPU,
    "ImageBlend_GPU": ImageBlend_GPU,
    "WanScaleAB": WanScaleAB
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CreateImageList": "Create Image List",
    "ImageBlur_GPU": "Image Blur (GPU)",
    "ImageBlend_GPU": "Image Blend (GPU)",
    "WanScaleAB": "Wan Scale AB"
}
