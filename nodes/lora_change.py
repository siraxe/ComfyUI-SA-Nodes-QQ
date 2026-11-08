import os
import torch
import comfy.utils
import folder_paths


class LoraReduceRank:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                {
                    "lora_name": (folder_paths.get_filename_list("loras"), {"tooltip": "The name of the LoRA."}),
                    "new_rank": ("INT", {"default": 8, "min": 1, "max": 4096, "step": 1, "tooltip": "The new rank to resize the LoRA. Acts as max rank when using dynamic_method."}),
                    "dynamic_method": (["disabled", "sv_ratio", "sv_cumulative", "sv_fro"], {"default": "disabled", "tooltip": "Method to use for dynamically determining new alphas and dims"}),
                    "dynamic_param": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Method to use for dynamically determining new alphas and dims"}),
                    "output_dtype": (["match_original", "fp16", "bf16", "fp32"], {"default": "match_original", "tooltip": "Data type to save the LoRA as."}),
                    "verbose": ("BOOLEAN", {"default": True}),
                },

    }
    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    EXPERIMENTAL = True
    DESCRIPTION = "Resize a LoRA model by reducing it's rank. Based on kohya's sd-scripts."

    CATEGORY = "QQ/lora"

    def save(self, lora_name, new_rank, output_dtype, dynamic_method, dynamic_param, verbose):

        lora_path = folder_paths.get_full_path("loras", lora_name)
        lora_sd, metadata = comfy.utils.load_torch_file(lora_path, return_metadata=True)

        if output_dtype == "fp16":
            save_dtype = torch.float16
        elif output_dtype == "bf16":
            save_dtype = torch.bfloat16
        elif output_dtype == "fp32":
            save_dtype = torch.float32
        elif output_dtype == "match_original":
            first_weight_key = next(k for k in lora_sd if k.endswith(".weight") and isinstance(lora_sd[k], torch.Tensor))
            save_dtype = lora_sd[first_weight_key].dtype

        # Note: resize_lora_model is defined in lora_nodes.py; this class copy is for organization only.
        # Import lazily to avoid circular imports if needed.
        from .lora_nodes import resize_lora_model, device  # type: ignore

        new_lora_sd = {}
        for k, v in lora_sd.items():
            new_lora_sd[k.replace(".default", "")] = v
        del lora_sd
        print("Resizing Lora...")
        output_sd, old_dim, new_alpha, rank_list = resize_lora_model(new_lora_sd, new_rank, save_dtype, device, dynamic_method, dynamic_param, verbose)

        # update metadata
        if metadata is None:
            metadata = {}

        comment = metadata.get("ss_training_comment", "")

        if dynamic_method == "disabled":
            metadata["ss_training_comment"] = f"dimension is resized from {old_dim} to {new_rank}; {comment}"
            metadata["ss_network_dim"] = str(new_rank)
            metadata["ss_network_alpha"] = str(new_alpha)
        else:
            metadata["ss_training_comment"] = f"Dynamic resize with {dynamic_method}: {dynamic_param} from {old_dim}; {comment}"
            metadata["ss_network_dim"] = "Dynamic"
            metadata["ss_network_alpha"] = "Dynamic"

        # cast to save_dtype before calculating hashes
        for key in list(output_sd.keys()):
            value = output_sd[key]
            if type(value) == torch.Tensor and value.dtype.is_floating_point and value.dtype != save_dtype:
                output_sd[key] = value.to(save_dtype)

        output_filename_prefix = "loras/" + lora_name

        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(output_filename_prefix, self.output_dir)
        output_dtype_str = f"_{output_dtype}" if output_dtype != "match_original" else ""
        import numpy as np
        average_rank = str(int(np.mean(rank_list)))
        rank_str = new_rank if dynamic_method == "disabled" else f"dynamic_{average_rank}"
        output_checkpoint = f"{filename.replace('.safetensors', '')}_resized_from_{old_dim}_to_{rank_str}{output_dtype_str}_{counter:05}_.safetensors"
        output_checkpoint = os.path.join(full_output_folder, output_checkpoint)
        print(f"Saving resized LoRA to {output_checkpoint}")

        comfy.utils.save_torch_file(output_sd, output_checkpoint, metadata=metadata)
        return {}


class LoraRemapStrength:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                {
                    "lora_name": (folder_paths.get_filename_list("loras"), {"tooltip": "LoRA to remap."}),
                    "reference_strength": ("FLOAT", {"default": 0.15, "min": 1e-6, "max": 10.0, "step": 0.01, "tooltip": "Existing effective strength you typically use (e.g., 0.15)."}),
                    "target_strength": ("FLOAT", {"default": 1.0, "min": 1e-6, "max": 10.0, "step": 0.01, "tooltip": "Desired equivalent strength (e.g., 1.0)."}),
                    "create_missing_alpha": ("BOOLEAN", {"default": True, "tooltip": "Create per-module .alpha if missing (uses rank as base)."}),
                    "output_dtype": (["match_original", "fp16", "bf16", "fp32"], {"default": "match_original", "tooltip": "Optional cast before save."}),
                }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "QQ/lora"

    def save(self, lora_name, reference_strength, target_strength, create_missing_alpha, output_dtype):
        print(f"[LoraRemapStrength DEBUG] Starting with inputs:")
        print(f"  - lora_name: {lora_name}")
        print(f"  - reference_strength: {reference_strength}")
        print(f"  - target_strength: {target_strength}")
        print(f"  - create_missing_alpha: {create_missing_alpha}")
        print(f"  - output_dtype: {output_dtype}")

        lora_path = folder_paths.get_full_path("loras", lora_name)
        print(f"[LoraRemapStrength DEBUG] Loading LoRA from: {lora_path}")

        try:
            lora_sd, metadata = comfy.utils.load_torch_file(lora_path, return_metadata=True)
            print(f"[LoraRemapStrength DEBUG] Successfully loaded LoRA with {len(lora_sd)} keys")
            if metadata:
                print(f"[LoraRemapStrength DEBUG] Metadata keys: {list(metadata.keys())}")
            else:
                print(f"[LoraRemapStrength DEBUG] No metadata found")
        except Exception as e:
            print(f"[LoraRemapStrength ERROR] Failed to load LoRA: {e}")
            return {}

        # compute scale factor to make target behave like reference
        factor = float(target_strength) / float(reference_strength)
        print(f"[LoraRemapStrength DEBUG] Computed scaling factor: {factor}")

        # Determine save dtype
        if output_dtype == "match_original":
            # try to find a floating weight to infer dtype
            first_weight_key = next((k for k in lora_sd if k.endswith(".weight") and isinstance(lora_sd[k], torch.Tensor)), None)
            save_dtype = lora_sd[first_weight_key].dtype if first_weight_key is not None else torch.float16
            print(f"[LoraRemapStrength DEBUG] Match original dtype: {save_dtype} (from key: {first_weight_key})")
        elif output_dtype == "fp16":
            save_dtype = torch.float16
            print(f"[LoraRemapStrength DEBUG] Using fp16 dtype")
        elif output_dtype == "bf16":
            save_dtype = torch.bfloat16
            print(f"[LoraRemapStrength DEBUG] Using bf16 dtype")
        else:
            save_dtype = torch.float32
            print(f"[LoraRemapStrength DEBUG] Using fp32 dtype")

        # Helper to get module prefix and weight name variant
        def split_lora_key(key):
            if key.endswith(".weight"):
                parts = key.split(".")
                if len(parts) >= 3:
                    mod = parts[-2]
                    if mod in ("lora_down", "lora_up", "lora_A", "lora_B", "down", "up"):
                        return ".".join(parts[:-2]), mod, True
            else:
                parts = key.split(".")
                if len(parts) >= 2 and parts[-1] in ("lora_down", "lora_up", "lora_A", "lora_B", "down", "up"):
                    return ".".join(parts[:-1]), parts[-1], False
            return None, None, None

        # Collect modules and detect ranks
        modules = {}
        processed_keys = []
        for k, v in lora_sd.items():
            pref, mod, has_weight = split_lora_key(k)
            if pref is None:
                continue
            processed_keys.append(k)
            m = modules.setdefault(pref, {"down": None, "up": None, "alpha": None})
            # track alpha
            alpha_key = pref + ".alpha"
            if alpha_key in lora_sd:
                m["alpha"] = alpha_key
            # track weights
            if (mod in ("lora_down", "lora_A", "down")):
                m["down"] = k
            elif (mod in ("lora_up", "lora_B", "up")):
                m["up"] = k

        print(f"[LoraRemapStrength DEBUG] Found {len(modules)} LoRA modules")
        print(f"[LoraRemapStrength DEBUG] Processed {len(processed_keys)} LoRA keys")

        # Scale existing alphas; create missing if requested
        alpha_scaled_count = 0
        alpha_created_count = 0
        for pref, info in modules.items():
            alpha_key = info["alpha"]
            if alpha_key is not None and isinstance(lora_sd[alpha_key], torch.Tensor):
                try:
                    original_alpha = lora_sd[alpha_key].clone()
                    lora_sd[alpha_key] = (lora_sd[alpha_key].to(torch.float32) * factor).to(save_dtype)
                    alpha_scaled_count += 1
                    print(f"[LoraRemapStrength DEBUG] Scaled alpha for {pref}: {original_alpha} -> {lora_sd[alpha_key]}")
                except Exception as e:
                    print(f"[LoraRemapStrength DEBUG] Error scaling alpha for {pref}: {e}")
                    lora_sd[alpha_key] = torch.tensor(float(lora_sd[alpha_key]) * factor, dtype=save_dtype)
                    alpha_scaled_count += 1
            elif create_missing_alpha and info["down"] is not None:
                w = lora_sd[info["down"]]
                rank = w.shape[0] if isinstance(w, torch.Tensor) and w.ndim >= 2 else 1
                lora_sd[pref + ".alpha"] = torch.tensor(float(rank) * factor, dtype=save_dtype)
                alpha_created_count += 1
                print(f"[LoraRemapStrength DEBUG] Created alpha for {pref}: rank={rank}, alpha={lora_sd[pref + '.alpha']}")

        print(f"[LoraRemapStrength DEBUG] Scaled {alpha_scaled_count} existing alphas")
        print(f"[LoraRemapStrength DEBUG] Created {alpha_created_count} missing alphas")

        # Cast weights to save_dtype for consistency
        for key in list(lora_sd.keys()):
            val = lora_sd[key]
            if isinstance(val, torch.Tensor) and val.dtype.is_floating_point and val.dtype != save_dtype:
                lora_sd[key] = val.to(save_dtype)

        # Update metadata
        if metadata is None:
            metadata = {}
        comment = metadata.get("ss_training_comment", "")
        metadata["ss_training_comment"] = f"alpha scaled by x{factor:.4f} to remap {reference_strength} -> {target_strength}; {comment}"

        # Build output filename - save next to original LoRA
        base_name = os.path.basename(lora_name).replace(".safetensors", "")
        suffix = f"_remap_{reference_strength}_to_{target_strength}"

        # Get the directory of the original LoRA file
        original_lora_dir = os.path.dirname(lora_path)

        print(f"[LoraRemapStrength DEBUG] Building output path:")
        print(f"  - base_name: {base_name}")
        print(f"  - suffix: {suffix}")
        print(f"  - original_lora_dir: {original_lora_dir}")
        print(f"  - original_lora_path: {lora_path}")

        try:
            # Create output filename in the same directory as the original LoRA
            # Add a counter to avoid overwriting existing files
            counter = 1
            while True:
                output_filename = f"{base_name}{suffix}_{counter:05}_.safetensors"
                output_checkpoint = os.path.join(original_lora_dir, output_filename)
                if not os.path.exists(output_checkpoint):
                    break
                counter += 1

            print(f"[LoraRemapStrength DEBUG] Path generation results:")
            print(f"  - output_checkpoint: {output_checkpoint}")
            print(f"  - counter: {counter}")

            # Verify the directory exists (it should since it contains the original LoRA)
            os.makedirs(original_lora_dir, exist_ok=True)
            print(f"[LoraRemapStrength DEBUG] Confirmed output directory exists: {original_lora_dir}")

        except Exception as e:
            print(f"[LoraRemapStrength ERROR] Failed to generate output path: {e}")
            return {}

        # Update metadata
        if metadata is None:
            metadata = {}
        comment = metadata.get("ss_training_comment", "")
        metadata["ss_training_comment"] = f"alpha scaled by x{factor:.4f} to remap {reference_strength} -> {target_strength}; {comment}"
        print(f"[LoraRemapStrength DEBUG] Updated metadata comment")

        try:
            print(f"[LoraRemapStrength DEBUG] Attempting to save LoRA file...")
            comfy.utils.save_torch_file(lora_sd, output_checkpoint, metadata=metadata)
            print(f"[LoraRemapStrength SUCCESS] LoRA saved successfully to: {output_checkpoint}")

            # Verify the file was actually created
            if os.path.exists(output_checkpoint):
                file_size = os.path.getsize(output_checkpoint)
                print(f"[LoraRemapStrength DEBUG] File verification: EXISTS, size: {file_size} bytes")
            else:
                print(f"[LoraRemapStrength ERROR] File verification: FILE NOT FOUND at {output_checkpoint}")

        except Exception as e:
            print(f"[LoraRemapStrength ERROR] Failed to save LoRA file: {e}")
            return {}

        return {}

NODE_CLASS_MAPPINGS = {
    "LoraReduceRank": LoraReduceRank,
    "LoraRemapStrength": LoraRemapStrength
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraReduceRank": "Lora Reduce Rank",
    "LoraRemapStrength": "Lora Remap Strength"
}