import comfy.sd
import comfy.utils
import folder_paths


def _load_lora_file(lora_name: str):
    lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
    return comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)


class TextLlmLoraLoad:
    """V1 port of "Load LoRA (Text Encoder)" (comfy_extras/nodes_lora_stack.py).

    Applies a single LoRA to a CLIP text encoder only (model is untouched).
    Chain multiple nodes together to build a stack, just like the classic
    LoraLoader / LoraLoaderModelOnly nodes.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {"required":
                {
                    "clip": ("CLIP", {"tooltip": "The CLIP text encoder the LoRA will be applied to."}),
                    "lora_name": (folder_paths.get_filename_list("loras"), {"tooltip": "The name of the LoRA file to apply."}),
                    "strength": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01,
                                           "tooltip": "How strongly to apply this LoRA. 0 = off, negative inverts the effect."}),
                    "enabled": ("BOOLEAN", {"default": True,
                                            "tooltip": "Turn off to skip this LoRA without changing its file or strength."}),
                },
                "optional":
                {
                    # Optional chained stack: previous LoraLoaderTextEncoder nodes can be
                    # fed in via "lora_opt" so several can be applied in one chain.
                    "lora_opt": ("CLIP",),
                },
                }

    RETURN_TYPES = ("CLIP",)
    RETURN_NAMES = ("clip",)
    FUNCTION = "load_lora"
    DISPLAY_NAME = "Text LLM Lora Load (QQ)"
    CATEGORY = "model/loaders"
    DESCRIPTION = "Apply a LoRA to a CLIP text encoder. Chain multiple nodes to apply a stack of LoRAs."

    def load_lora(self, clip, lora_name, strength, enabled, lora_opt=None):
        # Use the chained result if one was passed in, otherwise start from the input.
        if lora_opt is not None:
            clip = lora_opt

        if not lora_name or not enabled or strength == 0:
            return (clip,)

        lora, metadata = _load_lora_file(lora_name)
        _, clip = comfy.sd.load_lora_for_models(None, clip, lora, 0, strength, lora_metadata=metadata)
        return (clip,)


NODE_CLASS_MAPPINGS = {
    "TextLlmLoraLoad": TextLlmLoraLoad,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TextLlmLoraLoad": "Text LLM Lora Load (QQ)",
}
