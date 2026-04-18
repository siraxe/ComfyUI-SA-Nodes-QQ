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

    Outputs:
        - METADATA: Modified metadata dict to pass to next node in chain

    Features:
        - Crop: When enabled, reads crop area boundary info from input metadata
          and passes it through. Connect this output to another PowerLoadVideo's
          metadata input to apply the same crop to a different video.
        - Start Offset: Adds an offset to the starting frame number. Useful for
          synchronizing multiple videos with different start points.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "crop": ("BOOLEAN", {"default": False, "label": "Enable Crop Propagation"}),
                "start_offset": ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1, "display": "number"}),
            },
            "optional": {
                "metadata": ("METADATA",),
            },
        }

    RETURN_TYPES = ("METADATA",)
    FUNCTION = "process"
    CATEGORY = "Power/Video"
    DESCRIPTION = "Chain video edits by propagating metadata. Enable Crop to pass crop area settings to other videos."

    def process(self, crop=False, start_offset=0, metadata=None):
        """
        Process metadata chain.

        Args:
            crop: If True, preserves crop boundary info in output metadata for use by other nodes.
            start_offset: Integer offset to add to the starting frame number. Positive values skip frames,
                        negative values go back (if supported). Default 0 = no offset.
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

        return (output_metadata,)

    @classmethod
    def IS_CHANGED(s, crop=False, start_offset=0, metadata=None):
        """
        Determine if node needs to re-execute.
        """
        # Return hash based on crop and start_offset settings
        return f"{crop}_{start_offset}"


# Node registration
NODE_CLASS_MAPPINGS = {
    "ChainEditVideo": ChainEditVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ChainEditVideo": "Chain Edit Video",
}
