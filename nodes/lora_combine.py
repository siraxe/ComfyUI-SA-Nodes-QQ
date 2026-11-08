import os
import torch
import comfy.utils
import folder_paths
import logging
import numpy as np
from typing import Dict, List, Tuple, Optional

device = comfy.model_management.get_torch_device()

def combine_lora_weights(lora_sds: List[Dict], blend_weights: List[float], target_rank: int,
                        save_dtype: torch.dtype, verbose: bool = False) -> Tuple[Dict, List[int]]:
    """
    Combine multiple LoRA state dictionaries with rank extension using SVD.

    Args:
        lora_sds: List of LoRA state dictionaries
        blend_weights: List of blend weights for each LoRA
        target_rank: Target rank for the combined LoRA
        save_dtype: Data type for the combined weights
        verbose: Whether to print verbose information

    Returns:
        Combined LoRA state dictionary and list of actual ranks used
    """
    if len(lora_sds) != len(blend_weights):
        raise ValueError("Number of LoRAs must match number of blend weights")

    if len(lora_sds) == 0:
        raise ValueError("At least one LoRA must be provided")

    # Normalize blend weights
    total_weight = sum(blend_weights)
    if total_weight == 0:
        raise ValueError("Sum of blend weights cannot be zero")
    blend_weights = [w / total_weight for w in blend_weights]

    combined_sd = {}
    rank_list = []

    # Get all unique layer prefixes from all LoRAs
    all_layer_prefixes = set()
    for lora_sd in lora_sds:
        for key in lora_sd.keys():
            if key.endswith((".lora_up.weight", ".lora_down.weight", ".lora_A.weight", ".lora_B.weight")):
                prefix = key.rsplit('.', 2)[0]
                all_layer_prefixes.add(prefix)

    if verbose:
        print(f"Found {len(all_layer_prefixes)} unique layers to process")

    # Process each layer
    for layer_prefix in sorted(all_layer_prefixes):
        try:
            # Collect up and down weights from all LoRAs for this layer
            up_weights = []
            down_weights = []
            alphas = []

            for lora_idx, lora_sd in enumerate(lora_sds):
                up_key = f"{layer_prefix}.lora_up.weight"
                down_key = f"{layer_prefix}.lora_down.weight"
                alpha_key = f"{layer_prefix}.alpha"

                # Try alternative LoRA naming conventions
                if up_key not in lora_sd:
                    up_key = f"{layer_prefix}.lora_B.weight"
                if down_key not in lora_sd:
                    down_key = f"{layer_prefix}.lora_A.weight"

                if up_key in lora_sd and down_key in lora_sd:
                    up_weights.append(lora_sd[up_key].to(device) * blend_weights[lora_idx])
                    down_weights.append(lora_sd[down_key].to(device) * blend_weights[lora_idx])

                    if alpha_key in lora_sd:
                        alphas.append(lora_sd[alpha_key].item() if isinstance(lora_sd[alpha_key], torch.Tensor) else lora_sd[alpha_key])

            if not up_weights:
                if verbose:
                    print(f"Skipping layer {layer_prefix}: no compatible weights found")
                continue

            # Combine weights additively
            combined_up = torch.stack(up_weights).sum(dim=0)
            combined_down = torch.stack(down_weights).sum(dim=0)

            # Apply SVD-based rank extension
            extended_up, extended_down = extend_rank_with_svd(
                combined_up, combined_down, target_rank, verbose
            )

            # Store combined weights
            combined_sd[f"{layer_prefix}.lora_up.weight"] = extended_up.cpu().contiguous().to(save_dtype)
            combined_sd[f"{layer_prefix}.lora_down.weight"] = extended_down.cpu().contiguous().to(save_dtype)

            # Handle alpha values
            if alphas:
                # Blend alphas proportionally
                combined_alpha = sum(alpha * weight for alpha, weight in zip(alphas, blend_weights[:len(alphas)]))
                combined_sd[f"{layer_prefix}.alpha"] = torch.tensor(combined_alpha, dtype=save_dtype)

            rank_list.append(target_rank)

            if verbose:
                print(f"Combined layer {layer_prefix}: original shapes {combined_up.shape, combined_down.shape} -> extended rank {target_rank}")

        except Exception as e:
            logging.warning(f"Failed to combine layer {layer_prefix}: {e}")
            continue

    return combined_sd, rank_list

def extend_rank_with_svd(up_weight: torch.Tensor, down_weight: torch.Tensor,
                        target_rank: int, verbose: bool = False) -> Tuple[torch.Tensor, torch.Tensor]:
    """
    Extend LoRA rank using SVD decomposition.

    Args:
        up_weight: Up projection weight matrix
        down_weight: Down projection weight matrix
        target_rank: Target rank for extension
        verbose: Whether to print verbose information

    Returns:
        Extended up and down weight matrices
    """
    # Combine the LoRA matrices by multiplication
    # Original LoRA: W + up @ down
    # We'll decompose the combined effect and reconstruct with target rank
    combined_effect = up_weight @ down_weight

    # Handle different tensor shapes (conv2d vs linear)
    if combined_effect.ndim == 4:
        # Conv2D case: flatten spatial dimensions
        out_dim, in_dim, kh, kw = combined_effect.shape
        combined_flat = combined_effect.view(out_dim, -1)
        is_conv = True
        spatial_shape = (kh, kw)
    else:
        # Linear case
        out_dim, in_dim = combined_effect.shape
        combined_flat = combined_effect
        is_conv = False
        spatial_shape = None

    # SVD decomposition
    try:
        U, S, Vh = torch.linalg.svd(combined_flat.float(), full_matrices=False)
    except Exception as e:
        if verbose:
            print(f"SVD failed, using fallback method: {e}")
        # Fallback: pad with zeros if SVD fails
        return fallback_rank_extension(up_weight, down_weight, target_rank, is_conv, spatial_shape)

    # Ensure we don't exceed target dimensions
    actual_rank = min(target_rank, len(S), out_dim, in_dim)

    if actual_rank < target_rank and verbose:
        print(f"Warning: Target rank {target_rank} exceeds matrix dimensions, using {actual_rank}")

    # Reconstruct with target rank
    U_reduced = U[:, :actual_rank]
    S_reduced = S[:actual_rank]
    Vh_reduced = Vh[:actual_rank, :]

    # Split the reconstructed matrix back into up and down matrices
    # We'll distribute the singular values between up and down
    sqrt_S = torch.sqrt(S_reduced)

    if is_conv:
        # Conv2D case
        new_up = U_reduced @ torch.diag(sqrt_S)
        new_down = torch.diag(sqrt_S) @ Vh_reduced

        # Reshape back to conv2d format
        new_up = new_up.view(out_dim, actual_rank, 1, 1)
        new_down = new_down.view(actual_rank, in_dim, kh, kw)
    else:
        # Linear case
        new_up = U_reduced @ torch.diag(sqrt_S)
        new_down = torch.diag(sqrt_S) @ Vh_reduced

    if verbose:
        # Calculate preservation ratio
        original_norm = torch.norm(combined_flat).item()
        reconstructed_flat = new_up @ new_down if not is_conv else (new_up @ new_down).view(out_dim, -1)
        reconstructed_norm = torch.norm(reconstructed_flat).item()
        preservation = reconstructed_norm / original_norm if original_norm > 0 else 0
        print(f"Rank extension: {combined_flat.shape} -> rank {actual_rank}, preservation: {preservation:.2%}")

    return new_up, new_down

def fallback_rank_extension(up_weight: torch.Tensor, down_weight: torch.Tensor,
                           target_rank: int, is_conv: bool, spatial_shape: Optional[Tuple]) -> Tuple[torch.Tensor, torch.Tensor]:
    """
    Fallback method for rank extension when SVD fails.
    """
    out_dim = up_weight.shape[0]
    in_dim = down_weight.shape[-1] if is_conv else down_weight.shape[1]
    current_rank = up_weight.shape[1] if is_conv else up_weight.shape[1]

    # Can't reduce rank with fallback, only extend
    if target_rank <= current_rank:
        return up_weight, down_weight

    if is_conv:
        # Conv2D case
        kh, kw = spatial_shape
        # Pad up weight
        padding_up = torch.zeros(out_dim, target_rank - current_rank, 1, 1,
                                device=up_weight.device, dtype=up_weight.dtype)
        new_up = torch.cat([up_weight, padding_up], dim=1)

        # Pad down weight
        padding_down = torch.zeros(target_rank - current_rank, in_dim, kh, kw,
                                  device=down_weight.device, dtype=down_weight.dtype)
        new_down = torch.cat([down_weight, padding_down], dim=0)
    else:
        # Linear case
        # Pad up weight
        padding_up = torch.zeros(out_dim, target_rank - current_rank,
                                device=up_weight.device, dtype=up_weight.dtype)
        new_up = torch.cat([up_weight, padding_up], dim=1)

        # Pad down weight
        padding_down = torch.zeros(target_rank - current_rank, in_dim,
                                  device=down_weight.device, dtype=down_weight.dtype)
        new_down = torch.cat([down_weight, padding_down], dim=0)

    return new_up, new_down

class LoraSmartCombine:
    """
    Smart LoRA combination node that can merge multiple LoRAs while extending their rank.
    """
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "lora_1_name": (folder_paths.get_filename_list("loras"), {"tooltip": "First LoRA to combine"}),
                "lora_2_name": (folder_paths.get_filename_list("loras"), {"tooltip": "Second LoRA to combine"}),
                "lora_3_name": (["None"] + folder_paths.get_filename_list("loras"), {"tooltip": "Third LoRA (optional)"}),
                "lora_4_name": (["None"] + folder_paths.get_filename_list("loras"), {"tooltip": "Fourth LoRA (optional)"}),

                "target_rank": ("INT", {"default": 16, "min": 1, "max": 4096, "step": 1,
                               "tooltip": "Target rank for the combined LoRA"}),

                "blend_weight_1": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                   "tooltip": "Blend weight for first LoRA"}),
                "blend_weight_2": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                   "tooltip": "Blend weight for second LoRA"}),
                "blend_weight_3": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                   "tooltip": "Blend weight for third LoRA"}),
                "blend_weight_4": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                   "tooltip": "Blend weight for fourth LoRA"}),

                "alpha_handling": (["preserve_original", "blend_proportional", "recalculate_from_rank"],
                                 {"default": "blend_proportional",
                                  "tooltip": "How to handle alpha values when combining"}),

                "output_dtype": (["match_original", "fp16", "bf16", "fp32"],
                               {"default": "match_original", "tooltip": "Data type for output LoRA"}),

                "verbose": ("BOOLEAN", {"default": True, "tooltip": "Print detailed combination information"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "combine"
    OUTPUT_NODE = True
    CATEGORY = "QQ/lora"
    DESCRIPTION = "Smartly combine multiple LoRAs with rank extension using SVD decomposition"

    def combine(self, lora_1_name, lora_2_name, lora_3_name, lora_4_name,
               target_rank, blend_weight_1, blend_weight_2, blend_weight_3, blend_weight_4,
               alpha_handling, output_dtype, verbose):

        # Collect LoRA names and weights
        lora_names = [lora_1_name, lora_2_name]
        blend_weights = [blend_weight_1, blend_weight_2]

        if lora_3_name != "None":
            lora_names.append(lora_3_name)
            blend_weights.append(blend_weight_3)
        if lora_4_name != "None":
            lora_names.append(lora_4_name)
            blend_weights.append(blend_weight_4)

        # Validate inputs
        if len(lora_names) < 2:
            raise ValueError("At least two LoRAs must be selected")

        if verbose:
            print(f"\n{'='*60}")
            print(f"Smart LoRA Combination Started")
            print(f"LoRAs to combine: {len(lora_names)}")
            print(f"Target rank: {target_rank}")
            print(f"Blend weights: {blend_weights}")
            print(f"Alpha handling: {alpha_handling}")
            print(f"{'='*60}\n")

        # Load LoRA state dictionaries
        lora_sds = []
        original_dtype = None

        for lora_name in lora_names:
            lora_path = folder_paths.get_full_path("loras", lora_name)
            lora_sd, metadata = comfy.utils.load_torch_file(lora_path, return_metadata=True)
            lora_sds.append(lora_sd)

            # Determine original dtype from first LoRA
            if original_dtype is None and output_dtype == "match_original":
                first_weight_key = next((k for k in lora_sd if k.endswith(".weight") and isinstance(lora_sd[k], torch.Tensor)), None)
                if first_weight_key is not None:
                    original_dtype = lora_sd[first_weight_key].dtype

        # Determine output dtype
        if output_dtype == "match_original":
            save_dtype = original_dtype or torch.float16
        elif output_dtype == "fp16":
            save_dtype = torch.float16
        elif output_dtype == "bf16":
            save_dtype = torch.bfloat16
        else:  # fp32
            save_dtype = torch.float32

        if verbose:
            print(f"Using output dtype: {save_dtype}")

        # Combine LoRAs
        combined_sd, rank_list = combine_lora_weights(
            lora_sds, blend_weights, target_rank, save_dtype, verbose
        )

        if not combined_sd:
            raise ValueError("No layers were successfully combined")

        # Create metadata
        metadata = {
            "ss_training_comment": f"Smart combination of {len(lora_names)} LoRAs with rank {target_rank}",
            "ss_network_dim": str(target_rank),
            "ss_network_alpha": str(target_rank),  # Use target rank as alpha
            "combination_method": "smart_svd_extension",
            "source_loras": lora_names,
            "blend_weights": blend_weights,
            "alpha_handling": alpha_handling
        }

        # Generate output filename
        lora_base_names = [os.path.basename(name).replace('.safetensors', '') for name in lora_names]
        combination_name = "_plus_".join(lora_base_names[:2])
        if len(lora_base_names) > 2:
            combination_name += f"_plus_{len(lora_base_names)-2}_more"

        output_filename_prefix = f"loras/{combination_name}_smart_combined"
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(output_filename_prefix, self.output_dir)

        output_checkpoint = f"{filename}_rank_{target_rank}_{output_dtype}_{counter:05}_.safetensors"
        output_checkpoint = os.path.join(full_output_folder, output_checkpoint)

        # Save combined LoRA
        comfy.utils.save_torch_file(combined_sd, output_checkpoint, metadata=metadata)

        if verbose:
            print(f"\n{'='*60}")
            print(f"Smart LoRA Combination Completed")
            print(f"Output saved to: {output_checkpoint}")
            print(f"Combined {len(combined_sd)//2} layers")
            print(f"Average rank: {np.mean(rank_list):.1f}")
            print(f"{'='*60}\n")

        return {}

NODE_CLASS_MAPPINGS = {
    "LoraSmartCombine": LoraSmartCombine
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraSmartCombine": "Lora Smart Combine"
}