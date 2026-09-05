import inspect
import sys
import re

# Import everything from the nodes directory
from .nodes.nodes import *
from .nodes.power_loaders import *
from .nodes.decode_overlap import *

from .nodes.power_load_video import *
from .nodes.power_compare_video import *
from .nodes.chain_edit_video import *
from .nodes.power_spline_editor import *
from .nodes.prepare_refs import *
from .nodes.video_inpaint import *
from .nodes.matanyone2 import *

from .nodes.lora_extract_v2 import *
from .nodes.lora_merge_ltx import *
from .nodes.lora_change import *
from .nodes.lora_combine import *
from .nodes.math_nodes import *

from .nodes.draw_shapes import *
from .nodes.draw_joints import *
from .nodes.draw_image import *

from .nodes.image_nodes import *
from .nodes.image_nodes_extra import *
from .nodes.image_to_video import *
from .nodes.video_nodes_extra import *
from .nodes.wan_first_middle_last import *

from .nodes.vace_utils import *
from .nodes.cache_samples import *
from .nodes.text import *
from .nodes.h3_text import *
from .nodes.power_crop_image import *


# Import API endpoints to register routes
from . import api
from .utility.rgthree_api import routes_model_info
from .nodes import trigger_ref_refresh  # Register PrepareRefs backend trigger endpoint

NODE_CONFIG = {}


def to_display_name(name):
    # Split CamelCase/PascalCase into words
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub('([a-z0-9])([A-Z])', r'\1 \2', s1)
    # Add " (QQ)" suffix
    return f"{s2} (QQ)"

# Dynamically populate NODE_CONFIG from imported classes
current_module = sys.modules[__name__]
for name, obj in inspect.getmembers(current_module):
    if inspect.isclass(obj):
        module_name = getattr(obj, '__module__', '')
        # Check if the class is defined in one of the modules within the .nodes package or ATI package
        if module_name.startswith(__name__ + '.nodes') or module_name.startswith(__name__ + '.ATI'):
            # --- ADDED CHECK: Exclude classes with "Math" in the name ---
            if "Math" in obj.__name__:
                continue # Skip this class
            # --- END ADDED CHECK ---

            # Basic check for ComfyUI node structure (customize if needed)
            # Support both old-style (INPUT_TYPES/FUNCTION/CATEGORY) and new-style (define_schema/execute) nodes
            is_old_style = hasattr(obj, 'INPUT_TYPES') and hasattr(obj, 'FUNCTION') and hasattr(obj, 'CATEGORY')
            is_new_style = hasattr(obj, 'define_schema') and hasattr(obj, 'execute')
            is_comfy_node = is_old_style or is_new_style
            if is_comfy_node:
                class_name = obj.__name__
                # Use explicit Node.DISPLAY_NAME if available, otherwise generate one
                display_name = getattr(obj, 'DISPLAY_NAME', None) or to_display_name(class_name)
                NODE_CONFIG[class_name] = {"class": obj, "name": display_name}
                
def generate_node_mappings(node_config):
    node_class_mappings = {}
    node_display_name_mappings = {}

    for node_name, node_info in node_config.items():
        node_class_mappings[node_name] = node_info["class"]
        node_display_name_mappings[node_name] = node_info.get("name", node_info["class"].__name__)

    return node_class_mappings, node_display_name_mappings

NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = generate_node_mappings(NODE_CONFIG)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

WEB_DIRECTORY = "./web"

# Add static path for web_async - define BEFORE using
from aiohttp import web
from pathlib import Path

# Store the directory path for later use
_WEB_ASYNC_DIR = str((Path(__file__).parent.absolute() / "web_async").as_posix())

def register_web_async_routes(server):
    """Register static routes for web_async - called by ComfyUI's extension system."""
    try:
        server.app.add_routes(
            [web.static("/web_async", _WEB_ASYNC_DIR, append_version=True)]
        )
        print(f"[SA-Nodes-QQ] Registered /web_async route pointing to: {_WEB_ASYNC_DIR}")
    except Exception as e:
        print(f"[SA-Nodes-QQ] Error adding static route for web_async: {e}")

# Register the route registration function with ComfyUI's extension system
from server import PromptServer

# Use the proper ComfyUI extension point - this runs when server starts
if hasattr(PromptServer, 'instance') and PromptServer.instance is not None:
    # Server already running (dev mode), register immediately
    register_web_async_routes(PromptServer.instance)
else:
    # Store for later registration - ComfyUI will call our function via the extension system
    # We need to monkey-patch or use a different approach
    import threading

    def wait_for_server_and_register():
        """Wait for PromptServer.instance to be available, then register routes."""
        import time
        for _ in range(30):  # Wait up to 30 seconds
            time.sleep(0.5)
            if hasattr(PromptServer, 'instance') and PromptServer.instance is not None:
                try:
                    register_web_async_routes(PromptServer.instance)
                    return
                except Exception as e:
                    print(f"[SA-Nodes-QQ] Waiting for server... error: {e}")
        print("[SA-Nodes-QQ] Failed to register web_async routes - server not ready")

    threading.Thread(target=wait_for_server_and_register, daemon=True).start()
