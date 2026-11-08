"""Seed (QQ): outputs a seed and can reuse the last queued seed when use_last is enabled."""
import random
from datetime import datetime

# Keep a private random state so other extensions seeding the global state can't affect generated seeds.
_initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
_seed_random_state = random.getstate()
random.setstate(_initial_random_state)


def new_random_seed():
    """Return a random seed without disturbing the global random state."""
    global _seed_random_state
    prev_random_state = random.getstate()
    random.setstate(_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    _seed_random_state = random.getstate()
    random.setstate(prev_random_state)
    return seed


def _get_workflow_node(extra_pnginfo, node_id):
    """Find a node in the saved workflow, descending into subgraphs if needed."""
    node_ids = str(node_id).split(":")
    workflow = (extra_pnginfo or {}).get("workflow", {}) or {}
    nodes_list = workflow.get("nodes", []) or []
    subgraphs = (workflow.get("definitions", {}) or {}).get("subgraphs", []) or []
    found = None
    for individual_node_id in node_ids:
        found = next((n for n in nodes_list if str(n.get("id")) == individual_node_id), None)
        if isinstance(found, dict) and "type" in found:
            subgraph = next((n for n in subgraphs if str(n.get("id")) == str(found["type"])), None)
            if isinstance(subgraph, dict) and "nodes" in subgraph:
                nodes_list = subgraph["nodes"]
    return found


def _save_generated_seed(prompt, extra_pnginfo, unique_id, old_seed, new_seed):
    """Replace a server-generated special seed in the workflow/prompt metadata."""
    if unique_id is None:
        return

    if extra_pnginfo is not None:
        workflow_node = _get_workflow_node(extra_pnginfo, str(unique_id))
        widget_values = (workflow_node or {}).get("widgets_values")
        if isinstance(widget_values, list):
            for index, widget_value in enumerate(widget_values):
                if widget_value == old_seed:
                    widget_values[index] = new_seed

    if prompt is not None:
        prompt_node = prompt.get(str(unique_id))
        inputs = (prompt_node or {}).get("inputs")
        if isinstance(inputs, dict) and "seed" in inputs:
            inputs["seed"] = new_seed


class Seed:
    """Outputs a seed, optionally reusing the last seed that was queued."""

    # Other packs also use "Seed", so register under a unique key while keeping the "Seed (QQ)" display name.
    NODE_KEY = "SeedQQ"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {
                    "default": 0,
                    "min": -1125899906842624,
                    "max": 1125899906842624,
                    # Suppress the frontend's own control_after_generate widget since special seeds are handled in web/seed.js.
                    "control_after_generate": False,
                }),
                "use_last": ("BOOLEAN", {
                    "default": False,
                    "label_on": "last seed",
                    "label_off": "seed widget",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    FUNCTION = "main"
    CATEGORY = "WanVideoWrapper_QQ/utils"
    DESCRIPTION = ("Outputs a seed. When 'use_last' is enabled, the last seed "
                   "queued by this node is reused instead of the UI value.")

    @classmethod
    def IS_CHANGED(cls, seed, use_last=False, **kwargs):
        """Force a changed state for special seeds."""
        if seed in (-1, -2, -3):
            return new_random_seed()
        return seed

    def main(self, seed, use_last=False, prompt=None, extra_pnginfo=None, unique_id=None):
        # If a special seed arrives from an API queue, generate a random seed and save it to the metadata.
        if seed in (-1, -2, -3):
            new_seed = new_random_seed()
            _save_generated_seed(prompt, extra_pnginfo, unique_id, seed, new_seed)
            return (new_seed,)

        return (seed,)
