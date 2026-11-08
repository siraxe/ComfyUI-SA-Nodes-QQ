class GroupsBypasser:
    """Virtual node that lists every group in the current graph as a toggle.

    Toggling a group bypasses (or enables) all nodes inside it.
    The "override" bool widget forces every listed group to the same
    state (on/off) when flipped.

    The Python side only registers the node and provides the "override"
    widget; the group widgets and bypass logic live in web/groups_bypasser.js.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "override": ("BOOLEAN", {
                    "default": False,
                    "label_on": "all on",
                    "label_off": "all off",
                }),
            }
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "bypass"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def bypass(self, **kwargs):
        # Never executed: the node has no outputs, groups are toggled in the frontend.
        return ()

