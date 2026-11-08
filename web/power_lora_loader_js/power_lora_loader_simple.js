/**
 * Simple Power Lora Loader UI.
 * All logic lives in the shared factory (power_lora_loader_common.js); this
 * file only provides the simple configuration: one united Strength per LoRA,
 * no Low/High split, no "<" / ">" copy buttons and no "Output both" toggle.
 */

import { createPowerLoraLoaderExtension } from "./power_lora_loader_common.js";

createPowerLoraLoaderExtension({
    extensionName: "WanVideo.SimplePowerLoraLoader",
    nodeNames: ["SimplePowerLoraLoader"],
    logTag: "SimplePowerLoraLoader",
    strengthSplit: false,  // Single united Strength column
    copyButtons: false,    // No "<" / ">" strength copy buttons
    outputBoth: false,     // No "Output both" toggle
    localStoragePrefix: "powerLoraLoaderSimple",
});