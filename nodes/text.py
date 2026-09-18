import re
import random
id_pattern = re.compile(r'^[a-zA-Z0-9 ]+$')

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

class PromptReplacer:
    """
    A node that replaces search_word variants in input_text with random picks from input_list.
    Automatically detects numbered variants (wordx, wordx2, wordx3...) in the text.
    In the input list, * items go to wordx, ** items go to wordx2, *** items go to wordx3, etc.
    Unprefixed items are the shared pool for all variants.
    Supports block comments (//) and single-line comments (#).
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {"default": '', "multiline": False}),
                "input_list": ("STRING", {"default": '', "multiline": True}),
                "search_word": ("STRING", {"default": 'wordx'}),
                "seed": ("INT", {"default": 1337, "min": 0, "max": 0xffffffffffffffff}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "selected_item")
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "sa_nodes/text"

    def parse_input(self, input_list):
        entries = input_list.strip().split('\n') if input_list.strip() else ['']
        # Keys: 'shared' for no-star items, and 1/2/3... for * / ** / *** items
        variant_pools = {}
        in_comment_block = False

        for entry in entries:
            stripped_entry = entry.strip()

            if stripped_entry == '//':
                if in_comment_block:
                    in_comment_block = False
                else:
                    in_comment_block = True
                continue

            if in_comment_block or stripped_entry == '' or stripped_entry.startswith('#'):
                continue

            # Count leading stars to determine variant assignment
            star_count = 0
            content = stripped_entry
            while content.startswith('*'):
                star_count += 1
                content = content[1:].strip()
            if star_count == 0:
                pool_key = 'shared'
            else:
                # 1 star = wordx (variant 0), 2 stars = wordx2 (variant 2), etc.
                pool_key = 0 if star_count == 1 else star_count

            # Parse id@description
            parts = content.split('@', 1)
            if len(parts) == 1:
                item_id = None
                description = parts[0].strip() or None
            else:
                item_id = parts[0].strip()
                assert id_pattern.match(item_id), f'IDs can only contain alphanumeric characters (a-z, A-Z, 0-9). Offending id is {item_id}'
                description = parts[1].strip() or None

            if not description:
                continue

            variant_pools.setdefault(pool_key, []).append((item_id, description))

        return variant_pools

    def find_variants_in_text(self, text, base_word):
        """Find all numbered variants of base_word present in text (e.g. wordx, wordx2, wordx3)."""
        variant_nums = []
        # Match numbered variants first (wordx2, wordx3, etc.)
        for match in re.finditer(re.escape(base_word) + r'(\d+)', text):
            variant_nums.append(int(match.group(1)))
        # Check for standalone base_word (wordx) — not part of a numbered variant
        num_pattern = re.escape(base_word) + r'\d'
        if base_word in text and not re.search(num_pattern, text):
            variant_nums.append(0)
        # If text has both wordx and wordx2, check for wordx not followed by a digit
        if re.search(num_pattern, text):
            # Also check for standalone base_word using word boundary
            if re.search(re.escape(base_word) + r'(?!\d)', text):
                variant_nums.append(0)
        return sorted(set(variant_nums))

    def execute(self, input_list, input_text, search_word, seed):
        random.seed(seed)

        variant_pools = self.parse_input(input_list)
        shared_pool = variant_pools.get('shared', [])
        all_dedicated = any(k != 'shared' for k in variant_pools)
        if not shared_pool and not all_dedicated:
            raise ValueError("Input list contains no valid entries to pick from.")

        # Detect which numbered variants exist in the text
        variant_nums = self.find_variants_in_text(input_text, search_word)
        if not variant_nums:
            return (input_text, '')

        # For each variant, pick a random item: prefer dedicated pool, fall back to shared
        replacements = {}  # variant_num -> (description, id)
        shared_available = list(shared_pool)
        for num in variant_nums:
            dedicated = variant_pools.get(num, [])
            if dedicated:
                pick = random.choice(dedicated)
                replacements[num] = pick
            elif shared_available:
                pick = random.choice(shared_available)
                shared_available.remove(pick)
                replacements[num] = pick
            else:
                raise ValueError(f"No items available for variant {search_word}{num if num else ''}.")

        # Build selected_item string and filename
        selected_parts = []
        filename_parts = []
        for num in sorted(replacements):
            item_id, desc = replacements[num]
            selected_parts.append(desc)
            filename_parts.append(item_id or f'no_id_{num}')
        selected_item = ", ".join(selected_parts)
        filename = '-'.join(filename_parts)

        # Replace in text: process longer variants first to avoid overlap (wordx2 before wordx)
        result_text = input_text
        for num in sorted(variant_nums, reverse=True):
            _, desc = replacements[num]
            if num == 0:
                result_text = result_text.replace(search_word, desc)
            else:
                result_text = result_text.replace(search_word + str(num), desc)

        return (result_text, selected_item)
