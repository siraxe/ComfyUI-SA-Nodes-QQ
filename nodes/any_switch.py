from .power_loaders import AnyType, FlexibleOptionalInputType, any_type


def _is_none(value):
    """Checks if a value is none (treats empty rgthree-style contexts as none)."""
    if value is not None:
        if isinstance(value, dict) and "model" in value and "clip" in value:
            return not (value.get("model") or value.get("clip"))
    return value is None


class AnySwitch:
    """Dynamic switch that outputs the first non-empty connected input.

    Port of rgthree's "Any Switch". The Python side picks the first connected
    `any_XX` input that delivers a value (bypassed upstream nodes arrive as
    None). The frontend (web/any_switch.js) manages the dynamic inputs and
    type adaptation -- fixed to work from inside subgraphs, unlike the
    original which resolves links against the wrong graph.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(any_type),
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION = "switch"
    CATEGORY = "WanVideoWrapper_QQ/utils"

    def switch(self, **kwargs):
        """Chooses the first non-empty item to output."""
        any_value = None
        for key, value in kwargs.items():
            if key.startswith("any_") and not _is_none(value):
                any_value = value
                break
        return (any_value,)
