"""
Chain Edit Video - A node for chaining video edits with shared metadata
Allows synchronizing crop areas and other settings across multiple videos.
"""


class ChainEditVideo:
    """
    Chains video edit operations by passing metadata between nodes.

    Inputs:
        - metadata: METADATA dict from PowerLoadVideo or previous ChainEditVideo node
        - crop: Boolean to enable/disable crop propagation
        - start_offset: Integer offset added to starting frame number (default 0)
        - forcef_override: FLOAT force_fps override sent to downstream PowerLoadVideo
          nodes via metadata (default 24). 0 = native FPS.
        - maxf_override: INT max_fps (max output frame count) override sent to
          downstream PowerLoadVideo nodes via metadata (default 0 = disabled).

    Outputs:
        - METADATA: Modified metadata dict to pass to next node in chain
        - maxf (INT): The effective max output frame count - maxf_override when > 0,
          otherwise the max_fps inherited from the input metadata (0 = none)

    Features:
        - Crop: When enabled, reads crop area boundary info from input metadata
          and passes it through. Connect this output to another PowerLoadVideo's
          metadata input to apply the same crop to a different video.
        - Start Offset: Adds an offset to the starting frame number. Useful for
          synchronizing multiple videos with different start points.
        - FPS Overrides: forcef_override / maxf_override are written into the
          metadata as force_fps_override / max_fps_override. A PowerLoadVideo
          receiving this metadata uses those values INSTEAD of its own UI
          force_fps / max_fps widgets.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "crop": ("BOOLEAN", {"default": False, "label": "Enable Crop Propagation"}),
                "start_offset": ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1, "display": "number"}),
                "forcef_override": ("FLOAT", {"default": 24, "min": 0, "max": 240, "step": 1, "display": "number"}),
                "maxf_override": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1, "display": "number"}),
            },
            "optional": {
                "metadata": ("METADATA",),
            },
        }

    RETURN_TYPES = ("METADATA", "INT")
    RETURN_NAMES = ("metadata", "maxf")
    FUNCTION = "process"
    CATEGORY = "Power/Video"
    DESCRIPTION = "Chain video edits by propagating metadata. Enable Crop to pass crop area settings to other videos. Also outputs the effective max frame count (maxf)."

    def process(self, crop=False, start_offset=0, forcef_override=24, maxf_override=0, metadata=None):
        """
        Process metadata chain.

        Args:
            crop: If True, preserves crop boundary info in output metadata for use by other nodes.
            start_offset: Integer offset to add to the starting frame number. Positive values skip frames,
                        negative values go back (if supported). Default 0 = no offset.
            forcef_override: force_fps value written into the metadata as force_fps_override.
                        Downstream PowerLoadVideo nodes use it instead of their own UI force_fps.
                        0 = native FPS.
            maxf_override: max_fps (max output frame count) value written into the metadata as
                        max_fps_override. Downstream PowerLoadVideo nodes use it instead of their
                        own UI max_fps. 0 = disabled (no frame-count cap).
            metadata: Input METADATA dict containing video info and optionally crop settings.

        Returns:
            tuple: (metadata_dict,) - Updated metadata to pass downstream
        """
        if metadata is None:
            # Create empty metadata if none provided
            output_metadata = {
                "crop_enabled": False,
                "crop_x": 0.5,
                "crop_y": 0.5,
                "crop_w": 1.0,
                "crop_h": 1.0,
                "start_offset": start_offset,
            }
        else:
            # Copy input metadata
            output_metadata = metadata.copy()

            # If crop is enabled in this node, ensure the crop settings are preserved
            # for downstream nodes to use
            if crop:
                # Ensure crop_enabled reflects whether we want to propagate crop
                output_metadata["crop_enabled"] = True
                # Preserve existing crop boundary info from input metadata
                if "crop_x" in metadata:
                    output_metadata["crop_x"] = metadata["crop_x"]
                if "crop_y" in metadata:
                    output_metadata["crop_y"] = metadata["crop_y"]
                if "crop_w" in metadata:
                    output_metadata["crop_w"] = metadata["crop_w"]
                if "crop_h" in metadata:
                    output_metadata["crop_h"] = metadata["crop_h"]
            else:
                # If crop is disabled, set crop_enabled to False so downstream
                # PowerLoadVideo nodes won't apply cropping
                output_metadata["crop_enabled"] = False

            # Always update start_offset from this node's input (overwrites any previous offset)
            output_metadata["start_offset"] = start_offset

        # FPS overrides: downstream PowerLoadVideo nodes use these instead of
        # their own UI force_fps / max_fps widgets when present in metadata.
        output_metadata["force_fps_override"] = float(forcef_override)
        output_metadata["max_fps_override"] = int(maxf_override)

        # Effective max output frame count: the override when set, otherwise
        # the max_fps inherited from the input metadata (0 = none/disabled)
        if maxf_override > 0:
            effective_maxf = int(maxf_override)
        else:
            try:
                effective_maxf = int(output_metadata.get("max_fps") or 0)
            except (ValueError, TypeError):
                effective_maxf = 0

        return (output_metadata, effective_maxf)

    @classmethod
    def IS_CHANGED(s, crop=False, start_offset=0, forcef_override=24, maxf_override=0, metadata=None):
        """
        Determine if node needs to re-execute.
        """
        # Return hash based on all widget settings
        return f"{crop}_{start_offset}_{forcef_override}_{maxf_override}"


# Node registration
NODE_CLASS_MAPPINGS = {
    "ChainEditVideo": ChainEditVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ChainEditVideo": "Chain Edit Video",
}
