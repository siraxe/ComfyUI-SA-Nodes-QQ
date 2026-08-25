class TextMultiline:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                "strip_newlines": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "stringify"
    CATEGORY = "QQ/text"

    def stringify(self, text, strip_newlines):
        if strip_newlines:
            text = text.replace("\n", "")
        return (text,)


class TextConcatMulti:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "inputcount": ("INT", {"default": 2, "min": 2, "max": 1000, "step": 1}),
                "text_1": ("STRING", {"forceInput": True}),
                "separator": ("STRING", {"default": ""}),
                "strip_newlines": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "text_2": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "combine"
    CATEGORY = "QQ/text"

    def combine(self, inputcount, separator, strip_newlines, **kwargs):
        texts = []
        for i in range(1, inputcount + 1):
            text = kwargs.get(f"text_{i}", "")
            if strip_newlines:
                text = text.replace("\n", "")
            texts.append(str(text))
        return (separator.join(texts),)
