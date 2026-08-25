"""H3 prompt text node with virtual media references.

Companion to the MiniMax H3 Easy frontend: media wires are collected virtually
by web/h3_text_multiline.js and summarized in the hidden ``media_order`` widget
as a comma list ("image,video,image"). Typing ``@Picture 1`` inside the text
inserts a reference that is resolved here to the official H3 tag
``<Picture 1>`` at execution time, so reordered media stays correct.
"""

import re

MODE_IMAGE = "image"
MODE_REFERENCE = "reference"
MENTION_RE = re.compile(r"@(Picture|Image|Video|Audio)\s*(\d+)")
TAG_NAMES = {"picture": "Picture", "image": "Picture", "video": "Video", "audio": "Audio"}
MEDIA_KINDS = {"image", "video", "audio"}


class H3TextMultiline:
    CATEGORY = "QQ/text"
    FUNCTION = "build_text"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    DESCRIPTION = "Multiline H3 prompt text with @media reference picking. Resolve @Picture/@Video/@Audio mentions into official H3 tags based on the connected media order."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                "mode": ([MODE_IMAGE, MODE_REFERENCE], {"default": MODE_REFERENCE}),
                "media_order": ("STRING", {"default": ""}),
                "strip_newlines": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                # Frontend anchor slot for the virtual media wires; the value
                # itself is intentionally ignored.
                "media": ("*",),
            },
        }

    def build_text(self, text, mode, media_order, strip_newlines, media=None):
        order = [kind for kind in str(media_order or "").split(",") if kind in MEDIA_KINDS]

        def resolve(match):
            kind = match.group(1).lower()
            kind = "image" if kind == "picture" else kind
            ordinal = int(match.group(2))
            seen = 0
            for entry in order:
                if entry == kind:
                    seen += 1
                    if seen == ordinal:
                        return f"<{TAG_NAMES[kind]} {ordinal}>"
            # No connected media for this mention; keep it visible in the text.
            return match.group(0)

        result = MENTION_RE.sub(resolve, str(text or ""))
        if strip_newlines:
            result = result.replace("\n", "")
        return (result,)
