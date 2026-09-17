import torch
import comfy.model_management
import comfy.utils
import folder_paths
import os
import logging
from tqdm import tqdm
import numpy as np
import gc
import time

device = comfy.model_management.get_torch_device()
offload_device = comfy.model_management.unet_offload_device()

CLAMP_QUANTILE = 0.99

def extract_lora(diff, key, rank, algorithm, lora_type, lowrank_iters=7, adaptive_param=1.0, clamp_quantile=True):
    """
    Enhanced LoRA extraction with performance optimizations.
    """
    conv2d = (len(diff.shape) == 4)
    kernel_size = None if not conv2d else diff.size()[2:4]
    conv2d_3x3 = conv2d and kernel_size != (1, 1)
    out_dim, in_dim = diff.size()[0:2]

    if conv2d:
        if conv2d_3x3:
            diff = diff.flatten(start_dim=1)
        else:
            diff = diff.squeeze()

    diff_float = diff.float()
    if algorithm == "svd_lowrank":
        U, S, V = torch.svd_lowrank(diff_float, q=min(rank, in_dim, out_dim), niter=lowrank_iters)
        U = U @ torch.diag(S)
        Vh = V.t()
    else:
        U, S, Vh = torch.linalg.svd(diff_float)
        # Flexible rank selection logic like locon
        if "adaptive" in lora_type:
            if lora_type == "adaptive_ratio":
                min_s = torch.max(S) * adaptive_param
                lora_rank = torch.sum(S > min_s).item()
            elif lora_type == "adaptive_energy":
                energy = torch.cumsum(S**2, dim=0)
                total_energy = torch.sum(S**2)
                threshold = adaptive_param * total_energy
                lora_rank = torch.sum(energy < threshold).item() + 1
            elif lora_type == "adaptive_quantile":
                s_cum = torch.cumsum(S, dim=0)
                min_cum_sum = adaptive_param * torch.sum(S)
                lora_rank = torch.sum(s_cum < min_cum_sum).item()
            elif lora_type == "adaptive_fro":
                S_squared = S.pow(2)
                S_fro_sq = float(torch.sum(S_squared))
                sum_S_squared = torch.cumsum(S_squared, dim=0) / S_fro_sq
                lora_rank = int(torch.searchsorted(sum_S_squared, adaptive_param**2)) + 1
                lora_rank = max(1, min(lora_rank, len(S)))
            else:
                pass

            # Cap adaptive rank by the specified max rank
            lora_rank = min(lora_rank, rank)

            # Calculate and print actual fro percentage retained after capping
            if lora_type == "adaptive_fro":
                S_squared = S.pow(2)
                s_fro = torch.sqrt(torch.sum(S_squared))
                s_red_fro = torch.sqrt(torch.sum(S_squared[:lora_rank]))
                fro_percent = float(s_red_fro / s_fro)
                print(f"{key} Extracted LoRA rank: {lora_rank}, Frobenius retained: {fro_percent:.1%}")
            else:
                print(f"{key} Extracted LoRA rank: {lora_rank}")
        else:
            lora_rank = rank

        lora_rank = max(1, lora_rank)
        lora_rank = min(out_dim, in_dim, lora_rank)

        U = U[:, :lora_rank]
        S = S[:lora_rank]
        U = U @ torch.diag(S)
        Vh = Vh[:lora_rank, :]

    if clamp_quantile:
        dist = torch.cat([U.flatten(), Vh.flatten()])
        if dist.numel() > 100_000:
            # Sample 100,000 elements for quantile estimation
            idx = torch.randperm(dist.numel(), device=dist.device)[:100_000]
            dist_sample = dist[idx]
            hi_val = torch.quantile(dist_sample, CLAMP_QUANTILE)
        else:
            hi_val = torch.quantile(dist, CLAMP_QUANTILE)
        low_val = -hi_val

        U = U.clamp(low_val, hi_val)
        Vh = Vh.clamp(low_val, hi_val)
    if conv2d:
        U = U.reshape(out_dim, lora_rank, 1, 1)
        Vh = Vh.reshape(lora_rank, in_dim, kernel_size[0], kernel_size[1])
    return (U, Vh)

def get_vram_usage():
    """Get current VRAM usage as percentage."""
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated(device)
        cached = torch.cuda.memory_reserved(device)
        total = torch.cuda.get_device_properties(device).total_memory
        return (allocated + cached) / total
    return 0.0

def strategic_offload(model, keep_blocks_in_gpu, debug=False):
    """
    Strategically offload model blocks based on VRAM optimization settings.
    """
    if debug:
        print(f"VRAM before offload: {get_vram_usage():.1%}")

    # Get model structure and identify key blocks
    if hasattr(model, 'model') and hasattr(model.model, 'diffusion_model'):
        diffusion_model = model.model.diffusion_model

        # Common transformer block patterns in diffusion models
        block_patterns = [
            'input_blocks', 'middle_block', 'output_blocks',
            'down_blocks', 'up_blocks', 'mid_block',
            'transformer_blocks', 'attention_blocks'
        ]

        blocks_to_keep = []
        if keep_blocks_in_gpu > 0:
            # Prioritize keeping middle and output blocks in GPU for performance
            priority_blocks = ['middle_block', 'output_blocks', 'up_blocks']
            for pattern in priority_blocks:
                if hasattr(diffusion_model, pattern):
                    blocks_to_keep.append(pattern)
                    if len(blocks_to_keep) >= keep_blocks_in_gpu:
                        break

        # Selectively offload blocks
        offloaded_count = 0
        for name, module in diffusion_model.named_modules():
            should_offload = True

            # Keep priority blocks in GPU
            for keep_pattern in blocks_to_keep:
                if keep_pattern in name:
                    should_offload = False
                    break

            if should_offload and offloaded_count < (40 - keep_blocks_in_gpu):
                module.to(offload_device)
                offloaded_count += 1

        if debug:
            print(f"Strategic offload: Kept {len(blocks_to_keep)} blocks, offloaded {offloaded_count} blocks")
            print(f"VRAM after offload: {get_vram_usage():.1%}")

def process_layer_batch(layer_keys, state_dict, batch_args, device, debug=False):
    """
    Process multiple layers in a batch for improved performance.
    """
    rank, lora_type, algorithm, lowrank_iters, out_dtype = batch_args
    batch_results = {}

    if debug:
        start_time = time.time()
        print(f"Processing batch of {len(layer_keys)} layers")

    # Move all batch layers to GPU at once
    batch_tensors = {}
    for key in layer_keys:
        if key in state_dict:
            batch_tensors[key] = state_dict[key].to(device, non_blocking=True)

    # Process all layers in batch
    for key in layer_keys:
        if key not in batch_tensors:
            continue

        weight_diff = batch_tensors[key]
        if weight_diff.ndim == 5:
            if debug:
                logging.info(f"Skipping 5D tensor for key {key}")
            continue

        if weight_diff.ndim < 2:
            continue

        try:
            out = extract_lora(weight_diff, key, rank, algorithm, lora_type,
                             lowrank_iters=lowrank_iters, adaptive_param=1.0,
                             clamp_quantile=True)

            # Move results back to CPU
            batch_results[f"{key[:-7]}.lora_up.weight"] = out[0].contiguous().to(out_dtype).cpu()
            batch_results[f"{key[:-7]}.lora_down.weight"] = out[1].contiguous().to(out_dtype).cpu()

        except Exception as e:
            logging.warning(f"Could not generate lora weights for key {key}, error {e}")

    # Clear batch tensors from GPU
    for tensor in batch_tensors.values():
        del tensor
    torch.cuda.empty_cache()

    if debug:
        batch_time = time.time() - start_time
        print(f"Batch processed in {batch_time:.2f}s, VRAM: {get_vram_usage():.1%}")

    return batch_results

def calc_lora_model_enhanced(model_diff, rank, prefix_model, prefix_lora, output_sd,
                           lora_type, algorithm, lowrank_iters, out_dtype, bias_diff=False,
                           adaptive_param=1.0, clamp_quantile=True, vram_usage_mode="balanced",
                           blocks_in_gpu=10, batch_size=4, prefetch_ahead=2,
                           memory_threshold=0.85, debug=False):
    """
    Enhanced LoRA model calculation with VRAM optimization and batch processing.
    """
    if debug:
        print(f"Starting enhanced LoRA extraction with VRAM mode: {vram_usage_mode}")
        print(f"VRAM usage at start: {get_vram_usage():.1%}")

    # Load model with strategic block management
    try:
        # force_patch_weights is no longer supported in newer ComfyUI model management
        comfy.model_management.load_models_gpu([model_diff], force_patch_weights=True)
    except (AssertionError, TypeError):
        comfy.model_management.load_models_gpu([model_diff])

    # Apply strategic offloading instead of full CPU offload
    if vram_usage_mode != "conservative":
        strategic_offload(model_diff, blocks_in_gpu, debug)
    else:
        # Conservative mode: keep original behavior
        model_diff.model.diffusion_model.cpu()

    # Get state dict
    sd = model_diff.model_state_dict(filter_prefix=prefix_model)
    del model_diff

    # Smart memory management
    if vram_usage_mode == "aggressive":
        # Don't clear cache immediately in aggressive mode
        pass
    else:
        comfy.model_management.soft_empty_cache()

    # Move state dict items to CPU selectively
    for k, v in sd.items():
        if isinstance(v, torch.Tensor):
            if vram_usage_mode == "aggressive" and "weight" in k:
                # Keep weights in GPU longer for aggressive mode
                pass
            else:
                sd[k] = v.cpu()

    if debug:
        print(f"VRAM after model loading: {get_vram_usage():.1%}")

    # Collect weight keys for processing
    weight_keys = [k for k in sd if k.endswith(".weight") and sd[k].ndim < 5]
    bias_keys = [k for k in sd if k.endswith(".bias")] if bias_diff else []

    total_keys = len(weight_keys) + len(bias_keys)
    progress_bar = tqdm(total=total_keys, desc=f"Enhanced LoRA Extraction ({prefix_lora.strip('.')})")
    comfy_pbar = comfy.utils.ProgressBar(total_keys)

    # Prepare batch processing
    batch_args = (rank, lora_type, algorithm, lowrank_iters, out_dtype)

    if batch_size > 1 and vram_usage_mode != "conservative":
        # Batch processing mode
        for i in range(0, len(weight_keys), batch_size):
            batch_keys = weight_keys[i:i + batch_size]

            # Monitor VRAM and adjust if needed
            current_vram = get_vram_usage()
            if current_vram > memory_threshold:
                if debug:
                    print(f"VRAM threshold exceeded ({current_vram:.1%} > {memory_threshold:.1%}), performing strategic offload")
                torch.cuda.empty_cache()

                # Reduce batch size if needed
                if len(batch_keys) > 2:
                    batch_keys = batch_keys[:len(batch_keys)//2]

            # Process batch
            batch_results = process_layer_batch(batch_keys, sd, batch_args, device, debug)
            output_sd.update(batch_results)

            progress_bar.update(len(batch_keys))
            comfy_pbar.update(len(batch_keys))

            # Prefetch next batch if available
            if prefetch_ahead > 0 and i + batch_size < len(weight_keys):
                next_batch_keys = weight_keys[i + batch_size:i + batch_size + prefetch_ahead]
                # Pre-allocate memory for next batch
                for key in next_batch_keys:
                    if key in sd:
                        _ = sd[key].to(device, non_blocking=True)
    else:
        # Sequential processing (original behavior)
        for k in weight_keys:
            weight_diff = sd[k].to(device)

            try:
                out = extract_lora(weight_diff, k, rank, algorithm, lora_type,
                                 lowrank_iters=lowrank_iters, adaptive_param=adaptive_param,
                                 clamp_quantile=clamp_quantile)

                output_sd[f"{prefix_lora}{k[len(prefix_model):-7]}.lora_up.weight"] = out[0].contiguous().to(out_dtype).cpu()
                output_sd[f"{prefix_lora}{k[len(prefix_model):-7]}.lora_down.weight"] = out[1].contiguous().to(out_dtype).cpu()

            except Exception as e:
                logging.warning(f"Could not generate lora weights for key {k}, error {e}")

            progress_bar.update(1)
            comfy_pbar.update(1)

    # Process bias differences
    for k in bias_keys:
        output_sd[f"{prefix_lora}{k[len(prefix_model):-5]}.diff_b"] = sd[k].contiguous().to(out_dtype).cpu()
        progress_bar.update(1)
        comfy_pbar.update(1)

    progress_bar.close()

    if debug:
        print(f"LoRA extraction completed. Final VRAM: {get_vram_usage():.1%}")

    return output_sd

class LoraExtractKJv2:
    """
    Enhanced LoRA extraction with VRAM optimization and block swapping technology.
    Inspired by WanVideo's block swapping system for improved performance.
    """
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "finetuned_model": ("MODEL",),
                "original_model": ("MODEL",),
                "filename_prefix": ("STRING", {"default": "loras/ComfyUI_v2_extracted_lora"}),
                "rank": ("INT", {"default": 8, "min": 1, "max": 4096, "step": 1,
                               "tooltip": "The rank to use for standard LoRA, or maximum rank limit for adaptive methods."}),
                "lora_type": (["standard", "full", "adaptive_ratio", "adaptive_quantile", "adaptive_energy", "adaptive_fro"],),
                "algorithm": (["svd_linalg", "svd_lowrank"], {"default": "svd_linalg",
                           "tooltip": "SVD algorithm to use, svd_lowrank is faster but less accurate."}),
                "lowrank_iters": ("INT", {"default": 7, "min": 1, "max": 100, "step": 1,
                                "tooltip": "The number of subspace iterations for lowrank SVD algorithm."}),
                "output_dtype": (["fp16", "bf16", "fp32"], {"default": "fp16"}),
                "bias_diff": ("BOOLEAN", {"default": True}),
                "adaptive_param": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01,
                                  "tooltip": "For ratio mode, this is the ratio of the maximum singular value. For quantile mode, this is the quantile of the singular values. For fro mode, this is the Frobenius norm retention ratio."}),
                "clamp_quantile": ("BOOLEAN", {"default": True}),

                # VRAM Optimization Parameters
                "vram_usage_mode": (["conservative", "balanced", "aggressive"], {"default": "balanced",
                                   "tooltip": "VRAM usage mode. Conservative=50% VRAM, Balanced=75% VRAM, Aggressive=90%+ VRAM"}),
                "blocks_in_gpu": ("INT", {"default": 10, "min": 0, "max": 40, "step": 1,
                                 "tooltip": "Number of transformer blocks to keep in GPU memory (0=offload all, 40=keep all)"}),
                "batch_size": ("INT", {"default": 4, "min": 1, "max": 8, "step": 1,
                              "tooltip": "Number of layers to process simultaneously (higher=more VRAM, faster)"}),
                "prefetch_ahead": ("INT", {"default": 2, "min": 0, "max": 10, "step": 1,
                                   "tooltip": "Number of blocks to prefetch ahead (reduces I/O bottlenecks)"}),
                "memory_threshold": ("FLOAT", {"default": 0.85, "min": 0.5, "max": 0.95, "step": 0.05,
                                     "tooltip": "VRAM usage threshold before automatic offloading (0.5-0.95)"}),
                "debug_mode": ("BOOLEAN", {"default": False,
                                "tooltip": "Enable detailed performance and VRAM usage debugging"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "KJNodes/lora"

    def save(self, finetuned_model, original_model, filename_prefix, rank, lora_type, algorithm,
             lowrank_iters, output_dtype, bias_diff, adaptive_param, clamp_quantile,
             vram_usage_mode, blocks_in_gpu, batch_size, prefetch_ahead, memory_threshold, debug_mode):

        if algorithm == "svd_lowrank" and lora_type != "standard":
            raise ValueError("svd_lowrank algorithm is only supported for standard LoRA extraction.")

        if debug_mode:
            print(f"\n{'='*60}")
            print(f"LoraExtractKJ v2 - Enhanced LoRA Extraction")
            print(f"VRAM Mode: {vram_usage_mode}")
            print(f"Blocks in GPU: {blocks_in_gpu}")
            print(f"Batch Size: {batch_size}")
            print(f"Memory Threshold: {memory_threshold:.1%}")
            print(f"Initial VRAM: {get_vram_usage():.1%}")
            print(f"{'='*60}\n")

        dtype = {"fp8_e4m3fn": torch.float8_e4m3fn, "bf16": torch.bfloat16,
                "fp16": torch.float16, "fp16_fast": torch.float16, "fp32": torch.float32}[output_dtype]

        start_time = time.time()

        # Create model difference
        m = finetuned_model.clone()
        kp = original_model.get_key_patches("diffusion_model.")
        for k in kp:
            m.add_patches({k: kp[k]}, - 1.0, 1.0)
        model_diff = m

        # Generate output path
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(filename_prefix, self.output_dir)

        output_sd = {}
        if model_diff is not None:
            output_sd = calc_lora_model_enhanced(
                model_diff, rank, "diffusion_model.", "diffusion_model.", output_sd,
                lora_type, algorithm, lowrank_iters, dtype, bias_diff=bias_diff,
                adaptive_param=adaptive_param, clamp_quantile=clamp_quantile,
                vram_usage_mode=vram_usage_mode, blocks_in_gpu=blocks_in_gpu,
                batch_size=batch_size, prefetch_ahead=prefetch_ahead,
                memory_threshold=memory_threshold, debug=debug_mode
            )

        # Generate filename with optimization info
        if "adaptive" in lora_type:
            rank_str = f"{lora_type}_{adaptive_param:.2f}"
        else:
            rank_str = rank

        vram_suffix = f"_{vram_usage_mode}_b{blocks_in_gpu}_bs{batch_size}"
        output_checkpoint = f"{filename}_rank_{rank_str}_{output_dtype}{vram_suffix}_{counter:05}_.safetensors"
        output_checkpoint = os.path.join(full_output_folder, output_checkpoint)

        # Save LoRA
        comfy.utils.save_torch_file(output_sd, output_checkpoint, metadata=None)

        # Performance summary
        total_time = time.time() - start_time
        if debug_mode:
            print(f"\n{'='*60}")
            print(f"Extraction completed in {total_time:.2f} seconds")
            print(f"Final VRAM: {get_vram_usage():.1%}")
            print(f"LoRA saved to: {output_checkpoint}")
            print(f"{'='*60}\n")

        return {}

NODE_CLASS_MAPPINGS = {
    "LoraExtractKJv2": LoraExtractKJv2
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraExtractKJv2": "LoraExtractKJ_v2"
}