import torch
from torchvision.models.optical_flow import Raft_Small_Weights, raft_small
import torch.nn.functional as F

from comfy import model_management as mm
from comfy.utils import ProgressBar, common_upscale
import folder_paths

device = mm.get_torch_device()
offload_device = mm.unet_offload_device()

class TemporalSmoothingNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "kernel_size": ("INT", {"default": 5, "min": 1, "max": 21, "step": 2}),
                "sigma": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 5.0}),
            },
            "optional": {
                "mode": (["gaussian", "gaussian_past", "optical_flow"], {"default": "gaussian"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "smooth_frames"
    CATEGORY = "image/postprocessing"

    @staticmethod
    def gaussian_kernel(kernel_size, sigma, device):
        if sigma <= 0:
            sigma = 1.0
        size = kernel_size // 2
        offsets = torch.arange(-size, size + 1, dtype=torch.float32, device=device)
        weights = torch.exp(-offsets ** 2 / (2 * sigma ** 2))
        weights /= weights.sum()
        return weights

    @staticmethod
    def to_chw(img):
        return img.permute(0, 3, 1, 2)

    @staticmethod
    def to_hwc(img):
        return img.permute(0, 2, 3, 1)

    def smooth_frames(self, images, kernel_size, sigma, mode="gaussian"):
        if len(images.shape) != 4:
            raise ValueError("Input images must be a batch of frames (B, H, W, C)")
        
        B, H, W, C = images.shape
        device = images.device
        dtype = images.dtype
        
        # Clone to avoid modifying input and ensure it's on the correct device
        processed = images.clone().to(device=device, dtype=torch.float32)
        
        if mode in ("gaussian", "gaussian_past"):
            past_only = (mode == "gaussian_past")
            size = kernel_size // 2

            if past_only:
                # Causal kernel: current frame + past frames only (offsets 0 .. -size)
                offsets = torch.arange(-size, 1, dtype=torch.float32, device=device)
                weights = torch.exp(-offsets ** 2 / (2 * sigma ** 2))
                weights /= weights.sum()
            else:
                # Symmetric kernel: past + current + future frames
                weights = self.gaussian_kernel(kernel_size, sigma, device)

            # Vectorized temporal convolution over all frames at once
            chw = processed.permute(0, 3, 1, 2)  # (B, C, H, W)
            left = kernel_size // 2
            # Replicate-pad along the frame axis (F.pad can't pad dim 0)
            padded = torch.cat([chw[:1].expand(left, -1, -1, -1), chw, chw[-1:].expand(left, -1, -1, -1)], dim=0)

            if past_only:
                # offsets[i] = i - size, so source frame index = b + i - size; after padding source starts at i
                acc = torch.zeros_like(chw)
                for i in range(size + 1):
                    acc += weights[i] * padded[i:i + B]
                processed = acc.permute(0, 2, 3, 1).contiguous()
            else:
                acc = torch.zeros_like(chw)
                for i in range(kernel_size):
                    acc += weights[i] * padded[i:i + B]
                processed = acc.permute(0, 2, 3, 1).contiguous()
        elif mode == "optical_flow":
            # Load RAFT model
            weights = Raft_Small_Weights.DEFAULT
            model = raft_small(weights=weights).to(device, dtype=torch.float32)
            model.eval()

            # Pre-warm the model on GPU
            if device.type == 'cuda':
                dummy_input = torch.randn(1, 3, 64, 64, device=device, dtype=torch.float32)
                with torch.no_grad():
                    _ = model(dummy_input, dummy_input)
                torch.cuda.synchronize()

            alpha = 0.5  # Fixed blend strength; can be adjusted or based on sigma

            # Use autocast for better GPU performance
            autocast_context = torch.amp.autocast('cuda', dtype=torch.float16) if device.type == 'cuda' else torch.no_grad()

            with torch.no_grad(), autocast_context:
                for b in range(1, B):
                    prev = self.to_chw(processed[b-1:b]).to(device)
                    curr = self.to_chw(processed[b:b+1]).to(device)

                    # Compute backward flow: model(curr, prev) gives flow from curr to prev
                    list_of_flows = model(curr, prev)
                    backward_flow = list_of_flows[-1].to(device)  # (1, 2, H, W)

                    # Create normalized grid on GPU
                    xx = torch.linspace(-1, 1, W, device=device).view(1, -1).repeat(H, 1)
                    yy = torch.linspace(-1, 1, H, device=device).view(H, 1).repeat(1, W)
                    grid = torch.stack((xx, yy), dim=-1).unsqueeze(0)  # (1, H, W, 2)

                    # Normalize flow on GPU
                    flow_norm = backward_flow.clone()
                    flow_norm[0, 0] *= 2.0 / (W - 1)
                    flow_norm[0, 1] *= 2.0 / (H - 1)

                    # Add to grid - need to permute flow to match grid format
                    flow_norm = flow_norm.permute(0, 2, 3, 1)  # (1, 2, H, W) -> (1, H, W, 2)
                    grid = grid + flow_norm

                    # Warp prev to curr space
                    warped_chw = F.grid_sample(prev, grid, mode='bilinear', padding_mode='border', align_corners=True)
                    warped = self.to_hwc(warped_chw)[0].to(device)  # (H, W, C)

                    # Blend - ensure all tensors are on the same device
                    processed[b] = (processed[b] * (1.0 - alpha) + warped * alpha).to(device)

        # Convert back to original dtype and ensure device consistency
        processed = processed.to(dtype=images.dtype, device=images.device)
        return (processed,)

class WanDecodeOverlapLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "vae": ("WANVAE",),
                    "samples": ("LATENT",),
                    "enable_vae_tiling": ("BOOLEAN", {"default": False, "tooltip": (
                        "Drastically reduces memory use but will introduce seams at tile stride boundaries. "
                        "The location and number of seams is dictated by the tile stride size. "
                        "The visibility of seams can be controlled by increasing the tile size. "
                        "Seams become less obvious at 1.5x stride and are barely noticeable at 2x stride size. "
                        "Which is to say if you use a stride width of 160, the seams are barely noticeable with a tile width of 320."
                    )}),
                    "tile_x": ("INT", {"default": 272, "min": 40, "max": 2048, "step": 8, "tooltip": "Tile width in pixels. Smaller values use less VRAM but will make seams more obvious."}),
                    "tile_y": ("INT", {"default": 272, "min": 40, "max": 2048, "step": 8, "tooltip": "Tile height in pixels. Smaller values use less VRAM but will make seams more obvious."}),
                    "tile_stride_x": ("INT", {"default": 144, "min": 32, "max": 2040, "step": 8, "tooltip": "Tile stride width in pixels. Smaller values use less VRAM but will introduce more seams."}),
                    "tile_stride_y": ("INT", {"default": 128, "min": 32, "max": 2040, "step": 8, "tooltip": "Tile stride height in pixels. Smaller values use less VRAM but will introduce more seams."}),
                    "overlap_sigma": ("FLOAT", {"default": 0.7, "min": 0.1, "max": 5.0, "step": 0.1, "tooltip": "Gaussian overlap sigma for temporal blending. Higher values create smoother transitions between frames."}),
                    "overlap_kernel_size": ("INT", {"default": 23, "min": 3, "max": 41, "step": 2, "tooltip": "Kernel size for temporal overlap blending. Must be odd number."}),
                    },
                    "optional": {
                        "normalization": (["default", "minmax"], {"advanced": True}),
                    }
                }

    @classmethod
    def VALIDATE_INPUTS(s, tile_x, tile_y, tile_stride_x, tile_stride_y, overlap_kernel_size):
        if tile_x <= tile_stride_x:
            return "Tile width must be larger than the tile stride width."
        if tile_y <= tile_stride_y:
            return "Tile height must be larger than the tile stride height."
        if overlap_kernel_size % 2 == 0:
            return "Overlap kernel size must be an odd number."
        return True

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "decode"
    CATEGORY = "WanVideoWrapper"

    @staticmethod
    def gaussian_kernel(kernel_size, sigma, device):
        """Create 1D Gaussian kernel for temporal blending"""
        if sigma <= 0:
            sigma = 1.0
        size = kernel_size // 2
        offsets = torch.arange(-size, size + 1, dtype=torch.float32, device=device)
        weights = torch.exp(-offsets ** 2 / (2 * sigma ** 2))
        weights /= weights.sum()
        return weights

    def apply_latent_overlap(self, latents, kernel_size, sigma):
        """Apply Gaussian temporal overlap blending to latents BEFORE decoding"""
        if len(latents.shape) != 5:
            raise ValueError("Input latents must have shape (B, C, T, H, W)")

        B, C, T, H, W = latents.shape
        device = latents.device

        if T <= 1 or kernel_size <= 1:
            return latents

        # Create Gaussian weights
        weights = self.gaussian_kernel(kernel_size, sigma, device)
        left = kernel_size // 2

        # Apply temporal convolution with Gaussian weights to latents
        blended_latents = latents.clone()

        for b in range(B):
            for t in range(T):
                blended_frame = torch.zeros((C, H, W), dtype=latents.dtype, device=device)
                total_weight = 0.0

                for i in range(kernel_size):
                    time_offset = t - left + i
                    weight = weights[i]

                    if time_offset < 0:
                        # Boundary handling: use first frame
                        blended_frame += weight * latents[b, :, 0, :, :]
                        total_weight += weight
                    elif time_offset >= T:
                        # Boundary handling: use last frame
                        blended_frame += weight * latents[b, :, -1, :, :]
                        total_weight += weight
                    else:
                        blended_frame += weight * latents[b, :, time_offset, :, :]
                        total_weight += weight

                if total_weight > 0:
                    blended_frame /= total_weight

                blended_latents[b, :, t, :, :] = blended_frame

        return blended_latents

    def decode(self, vae, samples, enable_vae_tiling, tile_x, tile_y, tile_stride_x, tile_stride_y, overlap_sigma, overlap_kernel_size, normalization="default"):
        mm.soft_empty_cache()

        video = samples.get("video", None)
        if video is not None:
            video.clamp_(-1.0, 1.0)
            video.add_(1.0).div_(2.0)
            # For pre-decoded video, we can't apply latent overlap
            return video.cpu().float(),

        latents = samples["samples"]
        end_image = samples.get("end_image", None)
        has_ref = samples.get("has_ref", False)
        drop_last = samples.get("drop_last", False)
        is_looped = samples.get("looped", False)
        flashvsr_LQ_images = samples.get("flashvsr_LQ_images", None)

        vae.to(device)
        latents = latents.to(device=device, dtype=vae.dtype)
        mm.soft_empty_cache()

        # Apply latent overlap BEFORE any frame manipulation
        if overlap_kernel_size > 1 and overlap_sigma > 0:
            # Add batch dimension if needed for latent overlap
            if len(latents.shape) == 4:  # [C, T, H, W]
                latents = latents.unsqueeze(0)  # [B, C, T, H, W]
                latents = self.apply_latent_overlap(latents, overlap_kernel_size, overlap_sigma)
                latents = latents.squeeze(0)  # [C, T, H, W]
            elif len(latents.shape) == 5:  # [B, C, T, H, W]
                latents = self.apply_latent_overlap(latents, overlap_kernel_size, overlap_sigma)

        if has_ref:
            latents = latents[:, :, 1:]
        if drop_last:
            latents = latents[:, :, :-1]

        if type(vae).__name__ == "TAEHV":
            images = vae.decode_video(latents.permute(0, 2, 1, 3, 4), cond=flashvsr_LQ_images.to(vae.dtype) if flashvsr_LQ_images is not None else None)[0].permute(1, 0, 2, 3)
            images = torch.clamp(images, 0.0, 1.0)
            images = images.permute(1, 2, 3, 0).cpu().float()
            return (images,)
        else:
            if end_image is not None:
                enable_vae_tiling = False
            images = vae.decode(latents, device=device, end_=(end_image is not None), tiled=enable_vae_tiling, tile_size=(tile_x//8, tile_y//8), tile_stride=(tile_stride_x//8, tile_stride_y//8))[0]

        images = images.cpu().float()

        if normalization == "minmax":
            images.sub_(images.min()).div_(images.max() - images.min())
        else:
            images.clamp_(-1.0, 1.0)
            images.add_(1.0).div_(2.0)

        if is_looped:
            temp_latents = torch.cat([latents[:, :, -3:]] + [latents[:, :, :2]], dim=2)
            temp_images = vae.decode(temp_latents, device=device, end_=(end_image is not None), tiled=enable_vae_tiling, tile_size=(tile_x//vae.upsampling_factor, tile_y//vae.upsampling_factor), tile_stride=(tile_stride_x//vae.upsampling_factor, tile_stride_y//vae.upsampling_factor))[0]
            temp_images = temp_images.cpu().float()
            temp_images = (temp_images - temp_images.min()) / (temp_images.max() - temp_images.min())
            images = torch.cat([temp_images[:, 9:].to(images), images[:, 5:]], dim=1)

        if end_image is not None:
            images = images[:, 0:-1]

        vae.to(offload_device)
        mm.soft_empty_cache()

        images.clamp_(0.0, 1.0)
        return (images.permute(1, 2, 3, 0),)