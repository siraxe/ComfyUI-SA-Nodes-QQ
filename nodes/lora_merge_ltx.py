"""
LTX2 LoRA Select - Simplified LTX2 LoRA loader with metadata pass-through.
Designed for daisy-chaining multiple LoRA loaders with combined metadata tracking.
"""

import os
import sys
from pathlib import Path

# Add parent directory to sys.path to import utility module
parent_dir = Path(__file__).resolve().parent.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

import torch
import json
from safetensors.torch import save_file

import comfy.lora
import comfy.utils
import comfy.sd
import folder_paths

from utility.ltx import merge_lora_state_dicts, count_layer_types


class LoadModelMeta:
    """
    Loads a checkpoint model and stores the full directory path in metadata.
    Similar to checkpoint loader but with metadata tracking.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "checkpoint_name": (
                    folder_paths.get_filename_list("checkpoints"),
                    {"tooltip": "The name of the checkpoint file."},
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load_checkpoint"
    CATEGORY = "QQ/ltxv"

    def load_checkpoint(self, checkpoint_name):
        """
        Load checkpoint and store the full path in model_options.
        """
        # Get full path to checkpoint
        checkpoint_path = folder_paths.get_full_path("checkpoints", checkpoint_name)

        # Load the checkpoint
        model = comfy.sd.load_checkpoint_guess_config(
            checkpoint_path, output_vae=True, output_clip=True
        )[0]

        # Store checkpoint path in model_options for LTX2LoRASelect to read
        if not hasattr(model, "model_options"):
            model.model_options = {}

        # Store the full path as checkpoint_name
        model.model_options["checkpoint_name"] = checkpoint_path

        return (model,)


class LTX2LoRASelect:
    """
    Simplified LTX2 LoRA loader with per-block strength control.
    Outputs model with attached metadata for daisy-chaining multiple LoRA loaders.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "lora_name": (
                    folder_paths.get_filename_list("loras"),
                    {"tooltip": "The name of the LoRA file."},
                ),
                "model": (
                    "MODEL",
                    {"tooltip": "The diffusion model to apply LoRA to."},
                ),
                "strength_model": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "tooltip": "Overall LoRA strength multiplier.",
                    },
                ),
                "video": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Strength for video attention layers.",
                    },
                ),
                "video_to_audio": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Strength for video to audio cross-attention layers.",
                    },
                ),
                "audio": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Strength for audio attention layers.",
                    },
                ),
                "audio_to_video": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Strength for audio to video cross-attention layers.",
                    },
                ),
                "other": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "Strength for layers not caught by other layer filters.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply_lora"
    CATEGORY = "QQ/ltxv"

    def apply_lora(
        self,
        model,
        lora_name,
        strength_model,
        video,
        video_to_audio,
        audio,
        audio_to_video,
        other,
    ):
        """
        Load and apply LoRA with layer-specific strength control.
        Attaches metadata to the model for daisy-chaining multiple LoRA loaders.
        """
        # Load LoRA file
        lora_path = folder_paths.get_full_path("loras", lora_name)
        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)

        # Get rank info for metadata
        rank = "unknown"
        weight_key = next((key for key in lora.keys() if key.endswith("weight")), None)
        if weight_key:
            rank = str(lora[weight_key].shape[0])

        # Build key map for current model
        key_map = {}
        if model is not None:
            key_map = comfy.lora.model_lora_keys_unet(model.model, key_map)

        # Load LoRA weights
        loaded = comfy.lora.load_lora(lora, key_map)

        keys_to_delete = []

        # Apply layer-based attention strength filtering
        for key in list(loaded.keys()):
            if key in keys_to_delete:
                continue

            key_str = (
                key
                if isinstance(key, str)
                else (key[0] if isinstance(key, tuple) else str(key))
            )

            # Determine strength multiplier based on layer name
            strength_multiplier = None

            # Video to audio cross-attention (check first - most specific)
            if "video_to_audio_attn" in key_str:
                strength_multiplier = video_to_audio
            # Audio to video cross-attention
            elif "audio_to_video_attn" in key_str:
                strength_multiplier = audio_to_video
            # Audio layers
            elif "audio_attn" in key_str or "audio_ff.net" in key_str:
                strength_multiplier = audio
            # Video layers (check last - most general)
            elif "attn" in key_str or "ff.net" in key_str:
                strength_multiplier = video
            # Everything else not caught by above filters
            else:
                strength_multiplier = other

            # Apply strength or mark for deletion
            if strength_multiplier is not None:
                if strength_multiplier == 0:
                    keys_to_delete.append(key)
                elif strength_multiplier != 1.0:
                    value = loaded[key]
                    if hasattr(value, "weights"):
                        weights_list = list(value.weights)
                        # Handle case where alpha (weights[2]) might be None
                        current_alpha = (
                            weights_list[2] if weights_list[2] is not None else 1.0
                        )
                        weights_list[2] = current_alpha * strength_multiplier
                        loaded[key].weights = tuple(weights_list)

        for key in keys_to_delete:
            if key in loaded:
                del loaded[key]

        # Apply patches to model
        if model is not None:
            new_modelpatcher = model.clone()
            new_modelpatcher.add_patches(loaded, strength_model)

            # Get connected model info for metadata
            model_id = "unknown"
            checkpoint_path = ""

            if hasattr(model, "model_options"):
                # Try to get checkpoint path from model_options (set by LoadModelMeta)
                checkpoint_path = model.model_options.get("checkpoint_name", "")

                # Get model type as fallback
                if hasattr(model.model, "model_config"):
                    model_id = str(type(model.model).__name__)
                elif hasattr(model.model, "load_device"):
                    model_id = f"{type(model.model).__name__}"

            elif hasattr(model, "model"):
                if hasattr(model.model, "model_config"):
                    model_id = str(type(model.model).__name__)
                elif hasattr(model.model, "load_device"):
                    model_id = f"{type(model.model).__name__}"

            # Create and attach metadata for daisy-chaining
            lora_metadata = {
                "lora_name": lora_name,
                "strength_model": strength_model,
                "video": video,
                "video_to_audio": video_to_audio,
                "audio": audio,
                "audio_to_video": audio_to_video,
                "other": other,
                "rank": rank,
                "applied_keys_count": len(loaded),
                "connected_model": model_id,
                "checkpoint_path": checkpoint_path,
            }

            # Attach metadata to model_options for daisy-chaining
            if not hasattr(new_modelpatcher, "model_options"):
                new_modelpatcher.model_options = {}

            # Preserve checkpoint_name from input model
            if checkpoint_path:
                new_modelpatcher.model_options["checkpoint_name"] = checkpoint_path

            if "ltx2_lora_chain" not in new_modelpatcher.model_options:
                new_modelpatcher.model_options["ltx2_lora_chain"] = []

            # Append this LoRA's metadata to the chain
            new_modelpatcher.model_options["ltx2_lora_chain"].append(lora_metadata)
        else:
            new_modelpatcher = None

        return (new_modelpatcher,)


class LoraMergeLTX:
    """
    Merges multiple LoRAs that were applied via LTX2LoRASelect into a single LoRA file.

    This node reads the ltx2_lora_chain metadata from a model that has had
    multiple LoRAs applied, then merges them into a single safetensors file.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model_with_loras": (
                    "MODEL",
                    {"tooltip": "The model with LoRAs applied (from LTX2LoRASelect)."},
                ),
                "output_prefix": (
                    "STRING",
                    {
                        "default": "merged_lora",
                        "tooltip": "Prefix for the merged LoRA filename.",
                    },
                ),
                "rank": (
                    "INT",
                    {
                        "default": 64,
                        "min": 1,
                        "max": 512,
                        "step": 8,
                        "tooltip": "Target rank of the merged LoRA.",
                    },
                ),
                "output_dir": (
                    "STRING",
                    {
                        "default": "loras",
                        "tooltip": "Output directory (relative to ComfyUI root). Use 'loras' for auto-discovery.",
                    },
                ),
                "merge_on_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "Merge on model weights (more accurate) vs pure LoRA SVD merge (faster).",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("merged_lora_path",)
    FUNCTION = "merge_loras"
    CATEGORY = "QQ/ltxv"
    OUTPUT_NODE = True

    def merge_loras(self, model_with_loras, output_prefix, rank, output_dir, merge_on_model):
        """
        Merge multiple LoRAs from ltx2_lora_chain into a single safetensors file.

        The merge process:
        1. Extract the base model's state dict
        2. For each LoRA in the chain, compute its effective weight contribution
           (considering layer-specific strengths)
        3. Sum all contributions to get merged delta weights
        4. Apply SVD decomposition to factorize into up/down matrices at target rank
        5. Save as safetensors with metadata
        """
        # Validate input
        if model_with_loras is None:
            raise ValueError("No model provided for merging")

        if not hasattr(model_with_loras, "model_options"):
            raise ValueError("Model has no model_options attribute")

        lora_chain = model_with_loras.model_options.get("ltx2_lora_chain", [])
        if not lora_chain:
            raise ValueError(
                "No LoRA chain found in model options. Apply LoRAs first using LTX2LoRASelect."
            )

        print(f"\n{'=' * 60}")
        print(f"LTX2 LoRA Merge - Starting")
        print(f"{'=' * 60}")
        print(f"Found {len(lora_chain)} LoRA(s) to merge:")
        for i, lora_info in enumerate(lora_chain, 1):
            lora_name = lora_info.get('lora_name', 'unknown')
            strength_model = lora_info.get('strength_model', 0)
            layer_strs = [
                f"v:{lora_info.get('video', 1.0):.2f}",
                f"a:{lora_info.get('audio', 1.0):.2f}",
                f"v>a:{lora_info.get('video_to_audio', 1.0):.2f}",
                f"a>v:{lora_info.get('audio_to_video', 1.0):.2f}",
                f"o:{lora_info.get('other', 1.0):.2f}",
            ]
            print(
                f"  {i}. {lora_name} (strength: {strength_model:.2f} | {', '.join(layer_strs)})"
            )
        print(f"Target rank: {rank}")
        print(f"Output prefix: {output_prefix}")
        print(f"Output directory: {output_dir}")
        print(f"Merge mode: {'Model-weight (accurate)' if merge_on_model else 'LoRA SVD (fast)'}")
        print(f"{'=' * 60}\n")

        # Determine output path early to show user where file will be saved
        output_path = self._get_output_path(output_prefix, output_dir)
        print(f"Output path: {output_path}")
        print()

        # Get device for computation
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Load all LoRA files and build merged state dict
        lora_data_list = []  # List of (lora_sd, metadata, layer_strengths)

        for lora_info in lora_chain:
            lora_name = lora_info.get("lora_name", "")
            if not lora_name:
                continue

            # Load LoRA file
            try:
                lora_path = folder_paths.get_full_path("loras", lora_name)
                lora_sd, _ = self._load_lora_file(lora_path)

                layer_strengths = {
                    "video": lora_info.get("video", 1.0),
                    "video_to_audio": lora_info.get("video_to_audio", 1.0),
                    "audio": lora_info.get("audio", 1.0),
                    "audio_to_video": lora_info.get("audio_to_video", 1.0),
                    "other": lora_info.get("other", 1.0),
                }

                lora_data_list.append(
                    {
                        "sd": lora_sd,
                        "name": lora_name,
                        "strength_model": lora_info.get("strength_model", 1.0),
                        "layer_strengths": layer_strengths,
                    }
                )
            except Exception as e:
                print(f"Warning: Could not load LoRA '{lora_name}': {e}")
                continue

        if not lora_data_list:
            raise ValueError("No valid LoRAs found to merge")

        # Get checkpoint path for model-weight merge
        checkpoint_path = model_with_loras.model_options.get("checkpoint_name", "")

        # Debug: Show sample LoRA keys from first loaded LoRA
        if lora_data_list:
            sample_keys = list(lora_data_list[0]["sd"].keys())[:5]
            print(f"Sample LoRA keys from '{lora_data_list[0]['name']}':")
            for k in sample_keys:
                print(f"  - {k}")

        # Build merged state dict by combining all LoRA contributions
        if merge_on_model and checkpoint_path:
            print(f"Checkpoint path: {checkpoint_path}")
            if not Path(checkpoint_path).exists():
                raise ValueError(f"Checkpoint path not found: {checkpoint_path}")

            merged_sd = merge_lora_state_dicts(
                lora_data_list, rank, device, checkpoint_path=checkpoint_path
            )
        else:
            if merge_on_model:
                print("Warning: merge_on_model=True but no checkpoint path found. Using LoRA SVD merge instead.")
            merged_sd = merge_lora_state_dicts(lora_data_list, rank, device)

        # Print layer count summary
        print(f"\nMerge Summary:")
        print(f"  Total merged:     {len(merged_sd) // 3} layers")

        # Save merged LoRA
        self._save_merged_lora(merged_sd, output_path, lora_chain, rank)

        print(f"\n{'=' * 60}")
        print(f"Merge complete!")
        print(f"Output: {output_path}")
        print(f"{'=' * 60}\n")

        return (str(output_path),)

    def _load_lora_file(self, path):
        """Load a LoRA file (safetensors or pickle)."""
        from safetensors import safe_open as st_safe_open

        path = Path(path)
        if path.suffix == ".safetensors":
            with st_safe_open(path, framework="pt", device="cpu") as f:
                sd = {k: f.get_tensor(k) for k in f.keys()}
                metadata = f.metadata()
        else:
            sd = torch.load(path, map_location="cpu", weights_only=True)
            if isinstance(sd, dict) and "state_dict" in sd:
                sd = sd["state_dict"]
            metadata = None
        return sd, metadata

    def _get_output_path(self, prefix, output_dir="loras"):
        """
        Determine the output path for the merged LoRA.

        Args:
            prefix: Filename prefix
            output_dir: Output directory - either 'output' for ComfyUI output folder,
                       'loras' for ComfyUI loras folder, or a custom relative/absolute path
        """
        from datetime import datetime

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{prefix}_{timestamp}.safetensors"

        # Handle special directory names
        if output_dir.lower() == "loras":
            # Save to ComfyUI loras folder for auto-discovery
            try:
                loras_dirs = folder_paths.get_folder_paths("loras")
                if loras_dirs:
                    target_dir = os.path.join(loras_dirs[0], prefix)
                    os.makedirs(target_dir, exist_ok=True)
                    return os.path.join(target_dir, filename)
            except Exception as e:
                print(f"Warning: Could not access loras directory: {e}")
            # Fallback to output/loras if folder_paths doesn't work
            output_base = folder_paths.get_output_directory()
            target_dir = os.path.join(output_base, "loras", prefix)
        elif output_dir.lower() == "output":
            # Save to ComfyUI output folder using standard method
            try:
                full_output_folder, _, _, _ = folder_paths.get_save_image_path(prefix, None)
                return os.path.join(full_output_folder, filename)
            except Exception as e:
                print(f"Warning: Could not get save image path: {e}")
                output_base = folder_paths.get_output_directory()
                target_dir = os.path.join(output_base, prefix)
        else:
            # Custom directory - treat as relative to ComfyUI output
            output_base = folder_paths.get_output_directory()
            target_dir = os.path.join(output_base, output_dir, prefix)

        os.makedirs(target_dir, exist_ok=True)
        return os.path.join(target_dir, filename)

    def _save_merged_lora(self, merged_sd, output_path, lora_chain, rank):
        """
        Save the merged LoRA as a safetensors file with metadata.
        """
        # Build metadata
        metadata = {
            "ss_network_module": "diffusers",
            "ss_network_dim": str(rank),
            "ss_network_alpha": str(rank),
            "ss_merge_source": "LTX2LoRASelect Merge",
            "ss_merged_loras": json.dumps([l.get("lora_name", "unknown") for l in lora_chain]),
            "format": "diffusers",
        }

        # Convert tensors to cpu and ensure proper format
        processed_sd = {}
        for k, v in merged_sd.items():
            if isinstance(v, torch.Tensor):
                processed_sd[k] = v.cpu().contiguous()
            else:
                processed_sd[k] = v

        # Save as safetensors
        save_file(processed_sd, str(output_path), metadata=metadata)


class LoraApplyOnLTX:
    """
    Applies LoRA weights directly onto the base model checkpoint and saves as a new checkpoint.

    This is different from LoraMergeLTX which creates a merged LoRA file.
    Here we actually bake the LoRA into the model weights themselves.

    Workflow:
    1. Load base model checkpoint state dict
    2. For each LoRA in the chain, compute delta = up @ down * strength
    3. Apply delta directly to model weights: W_new = W_old + delta
    4. Save modified state dict as new checkpoint
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model_with_loras": (
                    "MODEL",
                    {"tooltip": "The model with LoRAs applied (from LTX2LoRASelect)."},
                ),
                "output_prefix": (
                    "STRING",
                    {
                        "default": "lora_applied_model",
                        "tooltip": "Prefix for the output checkpoint filename.",
                    },
                ),
                "output_dir": (
                    "STRING",
                    {
                        "default": "checkpoints",
                        "tooltip": "Output directory. Use 'checkpoints' to save to ComfyUI checkpoints folder.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_checkpoint_path",)
    FUNCTION = "apply_lora_to_model"
    CATEGORY = "QQ/ltxv"
    OUTPUT_NODE = True

    def apply_lora_to_model(self, model_with_loras, output_prefix, output_dir):
        """
        Apply LoRA weights directly to the base model checkpoint and save.

        Process:
        1. Get checkpoint path from model metadata
        2. Load all LoRAs from ltx2_lora_chain
        3. For each layer, compute: W_merged = W_base + sum(strength_i * up_i @ down_i)
        4. Save as new safetensors checkpoint
        """
        # Validate input
        if model_with_loras is None:
            raise ValueError("No model provided")

        if not hasattr(model_with_loras, "model_options"):
            raise ValueError("Model has no model_options attribute")

        lora_chain = model_with_loras.model_options.get("ltx2_lora_chain", [])
        if not lora_chain:
            raise ValueError(
                "No LoRA chain found. Apply LoRAs first using LTX2LoRASelect."
            )

        checkpoint_path = model_with_loras.model_options.get("checkpoint_name", "")
        if not checkpoint_path or not Path(checkpoint_path).exists():
            raise ValueError(f"Checkpoint path not found: {checkpoint_path}")

        print(f"\n{'=' * 60}")
        print(f"LTX LoRA Apply On Model - Starting")
        print(f"{'=' * 60}")
        print(f"Base checkpoint: {checkpoint_path}")
        print(f"LoRAs to apply: {len(lora_chain)}")
        for i, lora_info in enumerate(lora_chain, 1):
            lora_name = lora_info.get('lora_name', 'unknown')
            strength_model = lora_info.get('strength_model', 0)
            layer_strs = [
                f"v:{lora_info.get('video', 1.0):.2f}",
                f"a:{lora_info.get('audio', 1.0):.2f}",
                f"v>a:{lora_info.get('video_to_audio', 1.0):.2f}",
                f"a>v:{lora_info.get('audio_to_video', 1.0):.2f}",
                f"o:{lora_info.get('other', 1.0):.2f}",
            ]
            print(f"  {i}. {lora_name} (strength: {strength_model:.2f} | {', '.join(layer_strs)})")
        print(f"{'=' * 60}\n")

        # Determine output path
        output_path = self._get_checkpoint_output_path(output_prefix, output_dir)
        print(f"Output path: {output_path}")
        print()

        # Get device for computation
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using device: {device}")

        # Load all LoRA data
        lora_data_list = []
        for lora_info in lora_chain:
            lora_name = lora_info.get("lora_name", "")
            if not lora_name:
                continue

            try:
                lora_path = folder_paths.get_full_path("loras", lora_name)
                lora_sd, _ = self._load_lora_file(lora_path)

                layer_strengths = {
                    "video": lora_info.get("video", 1.0),
                    "video_to_audio": lora_info.get("video_to_audio", 1.0),
                    "audio": lora_info.get("audio", 1.0),
                    "audio_to_video": lora_info.get("audio_to_video", 1.0),
                    "other": lora_info.get("other", 1.0),
                }

                lora_data_list.append({
                    "sd": lora_sd,
                    "name": lora_name,
                    "strength_model": lora_info.get("strength_model", 1.0),
                    "layer_strengths": layer_strengths,
                })
            except Exception as e:
                print(f"Warning: Could not load LoRA '{lora_name}': {e}")
                continue

        if not lora_data_list:
            raise ValueError("No valid LoRAs found to apply")

        # Apply LoRAs directly to model weights
        merged_checkpoint = self._apply_loras_to_checkpoint(
            checkpoint_path, lora_data_list, device
        )

        # Save the modified checkpoint
        self._save_checkpoint(merged_checkpoint, output_path, lora_chain)

        print(f"\n{'=' * 60}")
        print(f"LoRA application complete!")
        print(f"Output: {output_path}")
        print(f"{'=' * 60}\n")

        return (str(output_path),)

    def _load_lora_file(self, path):
        """Load a LoRA file (safetensors or pickle)."""
        from safetensors import safe_open as st_safe_open

        path = Path(path)
        if path.suffix == ".safetensors":
            with st_safe_open(path, framework="pt", device="cpu") as f:
                sd = {k: f.get_tensor(k) for k in f.keys()}
                metadata = f.metadata()
        else:
            sd = torch.load(path, map_location="cpu", weights_only=True)
            if isinstance(sd, dict) and "state_dict" in sd:
                sd = sd["state_dict"]
            metadata = None
        return sd, metadata

    def _get_checkpoint_output_path(self, prefix, output_dir="checkpoints"):
        """
        Determine the output path for the checkpoint.
        """
        from datetime import datetime

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{prefix}_{timestamp}.safetensors"

        # Handle special directory names
        if output_dir.lower() == "checkpoints":
            # Save to ComfyUI checkpoints folder
            try:
                checkpoint_dirs = folder_paths.get_folder_paths("checkpoints")
                if checkpoint_dirs:
                    target_dir = os.path.join(checkpoint_dirs[0], prefix)
                    os.makedirs(target_dir, exist_ok=True)
                    return os.path.join(target_dir, filename)
            except Exception as e:
                print(f"Warning: Could not access checkpoints directory: {e}")
            # Fallback
            output_base = folder_paths.get_output_directory()
            target_dir = os.path.join(output_base, "checkpoints", prefix)
        elif output_dir.lower() == "output":
            output_base = folder_paths.get_output_directory()
            target_dir = os.path.join(output_base, prefix)
        else:
            # Custom directory
            output_base = folder_paths.get_output_directory()
            target_dir = os.path.join(output_base, output_dir, prefix)

        os.makedirs(target_dir, exist_ok=True)
        return os.path.join(target_dir, filename)

    def _apply_loras_to_checkpoint(self, checkpoint_path, lora_data_list, device):
        """
        Apply LoRA weights directly to checkpoint.

        For each layer with LoRA:
            W_new = W_old + sum_i(strength_i * up_i @ down_i)
        """
        from utility.ltx.core.merger import get_layer_strength
        from utility.ltx.utils.naming import LORA_DOWN_UP_FORMATS
        from safetensors.torch import safe_open

        print("Loading checkpoint...")
        with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
            checkpoint_keys = list(f.keys())
            print(f"Checkpoint has {len(checkpoint_keys)} keys")

            # Build block map from LoRAs - store original down/up key names for matching
            all_blocks = {}
            for lora_data in lora_data_list:
                sd = lora_data["sd"]
                strength_model = lora_data["strength_model"]
                layer_strengths = lora_data["layer_strengths"]

                for key in sd.keys():
                    if key.endswith(".alpha"):
                        continue

                    key_parts = key.split(".")
                    for fmt_down, fmt_up in LORA_DOWN_UP_FORMATS:
                        if len(key_parts) >= 2 and key_parts[-2] == fmt_down:
                            block_name = ".".join(key_parts[:-2])
                            weight_suffix = (
                                "." + key_parts[-1]
                                if key_parts[-1] in ["weight", "bias"]
                                else ""
                            )
                            up_key = f"{block_name}.{fmt_up}{weight_suffix}"

                            if up_key in sd:
                                if block_name not in all_blocks:
                                    all_blocks[block_name] = []

                                layer_str = get_layer_strength(block_name, layer_strengths)
                                combined_strength = strength_model * layer_str

                                all_blocks[block_name].append({
                                    "down": sd[key],
                                    "up": sd[up_key],
                                    "strength": combined_strength,
                                    "is_conv2d": len(sd[key].shape) == 4,
                                    "down_key": key,  # Store original key for matching
                                    "up_key": up_key,
                                })
                            break

            print(f"Found LoRA weights for {len(all_blocks)} layers")

            # Load entire checkpoint into memory and apply LoRAs
            print("Loading full checkpoint to memory...")
            merged_sd = {k: f.get_tensor(k) for k in checkpoint_keys}

        print(f"Applying LoRAs to model weights...")
        layers_modified = 0
        layers_skipped = 0

        # Build a map of shapes to keys for efficient matching
        shape_to_keys = {}
        for ckpt_key, tensor in merged_sd.items():
            shape_key = tuple(tensor.shape)
            if shape_key not in shape_to_keys:
                shape_to_keys[shape_key] = []
            shape_to_keys[shape_key].append(ckpt_key)

        for block_name, blocks in all_blocks.items():
            # Compute the expected output shape from LoRA up @ down
            first_block = blocks[0]
            down_shape = first_block["down"].shape
            up_shape = first_block["up"].shape

            if first_block["is_conv2d"]:
                # For conv: delta shape is (out_channels, in_channels * kh * kw)
                expected_out_shape = (up_shape[0], down_shape[1] * down_shape[2] * down_shape[3])
            else:
                # For linear: up @ down gives (up_rows, down_cols) = (out_features, in_features)
                expected_out_shape = (up_shape[0], down_shape[1])

            # Find matching model key by shape
            matched_key = None
            if expected_out_shape in shape_to_keys:
                for candidate_key in shape_to_keys[expected_out_shape]:
                    # Additional check: block_name should be related to the key
                    # Strip common prefixes/suffixes and compare
                    bn_clean = block_name.replace("model.", "").replace("diffusion_model.", "")
                    ck_clean = candidate_key.replace("model.", "").replace("diffusion_model.", "")

                    # Check if they share common path components
                    bn_parts = set(bn_clean.split("."))
                    ck_parts = set(ck_clean.split("."))

                    # Need significant overlap in path components
                    if len(bn_parts & ck_parts) >= 2:  # At least 2 matching parts
                        matched_key = candidate_key
                        break

            if matched_key is None:
                layers_skipped += 1
                if layers_skipped <= 5:
                    print(f"  Warning: No shape match for block '{block_name}' (expected shape {expected_out_shape})")
                continue

            base_weight = merged_sd[matched_key].to(device)
            is_conv2d = first_block["is_conv2d"]

            # Apply all LoRAs: W += sum(strength * up @ down)
            for block in blocks:
                strength = block["strength"]
                if abs(strength) < 1e-6:
                    continue

                down = block["down"].to(device)
                up = block["up"].to(device)

                if is_conv2d:
                    # Flatten conv for matrix multiplication
                    up_flat = up.reshape(up.shape[0], -1)
                    down_flat = down.reshape(down.shape[0], -1)
                    delta = (up_flat @ down_flat) * strength
                    delta = delta.reshape(base_weight.shape[0], base_weight.shape[1],
                                      base_weight.shape[2], base_weight.shape[3])
                else:
                    delta = (up @ down) * strength

                # Verify shapes match before adding
                if delta.shape != base_weight.shape:
                    print(f"  Shape mismatch! base: {base_weight.shape}, delta: {delta.shape}")
                    continue

                base_weight = base_weight + delta

            # Store back
            merged_sd[matched_key] = base_weight.cpu()
            layers_modified += 1

        print(f"Modified {layers_modified} layers, skipped {layers_skipped} layers")
        return merged_sd

    def _save_checkpoint(self, state_dict, output_path, lora_chain):
        """
        Save the modified checkpoint as safetensors.
        """
        # Build metadata
        metadata = {
            "ss_merge_source": "LTX LoRA Apply On Model",
            "ss_applied_loras": json.dumps([l.get("lora_name", "unknown") for l in lora_chain]),
        }

        print(f"Saving checkpoint to {output_path}...")
        save_file(state_dict, str(output_path), metadata=metadata)
        print("Saved!")


# Register the nodes
NODE_CLASS_MAPPINGS = {
    "LoadModelMeta": LoadModelMeta,
    "LTX2LoRASelect": LTX2LoRASelect,
    "LoraMergeLTX": LoraMergeLTX,
    "LoraApplyOnLTX": LoraApplyOnLTX,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadModelMeta": "Load Model Meta",
    "LTX2LoRASelect": "LTX2 LORA Select",
    "LoraMergeLTX": "Lora Merge LTX",
    "LoraApplyOnLTX": "LoRA Apply On LTX Model",
}
