import torch
import torch.nn.functional as F


class PowerImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_width": ("INT", {"default": 512, "min": 8, "max": 4096, "step": 8}),
                "mask_height": ("INT", {"default": 512, "min": 8, "max": 4096, "step": 8}),
                "keep_ar": ("BOOLEAN", {"default": True}),
                "crop_x": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_y": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_width": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 1.0, "step": 0.001}),
                "crop_height": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 1.0, "step": 0.001}),
            },
            "optional": {
                "image": ("IMAGE", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "crop_image"
    CATEGORY = "WanVideoWrapper_QQ"
    DESCRIPTION = "Crop an image with interactive canvas selection"

    def crop_image(self, mask_width, mask_height, keep_ar, crop_x, crop_y, crop_width, crop_height, image=None):
        if image is None:
            empty = torch.ones(1, mask_height, mask_width, 3, dtype=torch.float32)
            return (empty,)

        # Normalized crop values: (crop_x, crop_y) = center, (crop_width, crop_height) = full extent
        # Convert to pixel bounds
        _, H, W, _ = image.shape

        left   = int(round((crop_x - crop_width  / 2) * W))
        top    = int(round((crop_y - crop_height / 2) * H))
        right  = int(round((crop_x + crop_width  / 2) * W))
        bottom = int(round((crop_y + crop_height / 2) * H))

        # Clamp to image bounds
        left   = max(0, min(W, left))
        top    = max(0, min(H, top))
        right  = max(0, min(W, right))
        bottom = max(0, min(H, bottom))

        # Ensure at least 1px in each dimension
        if right <= left:
            right = min(left + 1, W)
        if bottom <= top:
            bottom = min(top + 1, H)

        cropped = image[:, top:bottom, left:right, :]

        # Resize to mask_width x mask_height
        out_h, out_w = mask_height, mask_width
        if cropped.shape[1] != out_h or cropped.shape[2] != out_w:
            # (B, H, W, C) -> (B, C, H, W) for F.interpolate
            cropped = cropped.permute(0, 3, 1, 2)
            cropped = F.interpolate(cropped, size=(out_h, out_w), mode="bilinear", antialias=True)
            cropped = cropped.permute(0, 2, 3, 1)

        return (cropped,)
