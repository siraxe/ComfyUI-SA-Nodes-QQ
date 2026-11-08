/**
 * Power Lora Loader V2 UI.
 * All logic lives in the shared factory (power_lora_loader_common.js); this
 * file only provides the v2 configuration: Low/High strength split, "<" / ">"
 * strength copy buttons and the "Output both" toggle (model_low support).
 */

import { createPowerLoraLoaderExtension } from "./power_lora_loader_common.js";

createPowerLoraLoaderExtension({
    extensionName: "WanVideo.PowerLoraLoaderV2",
    nodeNames: ["PowerLoraLoaderV2"],
    logTag: "PowerLoraLoaderV2",
    strengthSplit: true,   // Low + High strength columns
    copyButtons: true,     // "<" / ">" strength copy buttons
    outputBoth: true,      // "Output both" toggle + hidden output_both widget
    localStoragePrefix: "powerLoraLoaderV2",
});