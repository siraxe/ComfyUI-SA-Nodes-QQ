// Seed (QQ): remembers the last queued seed and reuses it when "use_last" is enabled.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SeedQQ";

const SPECIAL_SEED_RANDOM = -1;
const SPECIAL_SEED_INCREMENT = -2;
const SPECIAL_SEED_DECREMENT = -3;
const SPECIAL_SEEDS = [SPECIAL_SEED_RANDOM, SPECIAL_SEED_INCREMENT, SPECIAL_SEED_DECREMENT];
const LAST_SEED_BUTTON_LABEL = "♻️ Use Last Queued Seed";
const DEFAULT_RANDOM_MAX = 1125899906842624;

const MODE_NEVER = 2;
const MODE_BYPASS = 4;

// All live Seed (QQ) node instances.
const seedNodes = new Set();

function getFullNodeId(apiPrompt, id) {
    const output = apiPrompt?.output ?? {};
    const key = String(id);
    return output[key] ? key : Object.keys(output).find((i) => i.endsWith(`:${key}`));
}

function getWorkflowNode(apiPrompt, fullId) {
    const workflow = apiPrompt?.workflow ?? {};
    const nodeIds = String(fullId).split(":");
    const subgraphs = workflow?.definitions?.subgraphs ?? [];
    let nodesList = workflow?.nodes ?? [];
    let found = null;
    for (const nodeId of nodeIds) {
        found = nodesList.find((n) => String(n.id) === String(nodeId)) ?? null;
        if (found?.type) {
            const subgraph = subgraphs.find((g) => g.id === found.type) ?? null;
            if (subgraph?.nodes) nodesList = subgraph.nodes;
        }
    }
    return found;
}

function generateRandomSeed(node) {
    const options = node.seedWidget?.options ?? {};
    const stepSize = (Number(options.step) || 10) / 10;
    let min = Number(options.min);
    let max = Number(options.max);
    // Normal seeds are positive, so ignore the negative widget min that exists for special seeds.
    if (!Number.isFinite(min) || min < 0) min = 0;
    if (!Number.isFinite(max) || max <= min) max = DEFAULT_RANDOM_MAX;
    const randomRange = (max - min) / stepSize;
    let seed = Math.round(Math.floor(Math.random() * randomRange) * stepSize + min);
    if (SPECIAL_SEEDS.includes(seed)) seed = 0;
    return seed;
}

function getSeedToUse(node) {
    const widgetSeed = Number(node.seedWidget?.value);
    const hasLast = typeof node.lastSeed === "number";

    // "use_last" overrides the UI value entirely.
    if (node.useLastWidget?.value && hasLast) {
        return node.lastSeed;
    }

    if (!SPECIAL_SEEDS.includes(widgetSeed)) {
        return widgetSeed;
    }

    // Resolve special seeds (-1 random, -2 increment, -3 decrement).
    if (hasLast && !SPECIAL_SEEDS.includes(node.lastSeed)) {
        if (widgetSeed === SPECIAL_SEED_INCREMENT) return node.lastSeed + 1;
        if (widgetSeed === SPECIAL_SEED_DECREMENT) return node.lastSeed - 1;
    }
    return generateRandomSeed(node);
}

function updateLastSeedButton(node) {
    const button = node.lastSeedButton;
    if (!button) return;
    const hasLast = typeof node.lastSeed === "number";
    const isCurrent = hasLast && Number(node.seedWidget?.value) === node.lastSeed;
    const label = hasLast ? `♻️ Last seed: ${node.lastSeed}` : LAST_SEED_BUTTON_LABEL;
    button.label = label;
    button.name = label;
    button.disabled = !hasLast || isCurrent;
}

function useLastSeed(node) {
    if (typeof node.lastSeed !== "number") return;
    node.seedWidget.value = node.lastSeed;
    updateLastSeedButton(node);
    app.graph?.setDirtyCanvas?.(true, false);
}

function applySeedOverride(node, apiPrompt) {
    if (!node.seedWidget || !apiPrompt?.output) return;
    if (node.mode === MODE_NEVER || node.mode === MODE_BYPASS) return;

    const fullId = getFullNodeId(apiPrompt, node.id);
    if (fullId === undefined) return;

    const inputs = apiPrompt.output[fullId]?.inputs;
    // Only override literal seed values; leave wired inputs (links) alone.
    if (!inputs || typeof inputs.seed !== "number") return;

    const widgetSeed = Number(node.seedWidget.value);
    const seedToUse = getSeedToUse(node);

    // Write the effective seed into the prompt that is sent to the server.
    inputs.seed = seedToUse;

    // Keep the workflow metadata in sync with what is actually used.
    const workflowNode = getWorkflowNode(apiPrompt, fullId);
    if (Array.isArray(workflowNode?.widgets_values)) {
        const serializable = (node.widgets ?? []).filter((w) => w.serialize !== false);
        let index = serializable.indexOf(node.seedWidget);
        if (index < 0) index = node.widgets.indexOf(node.seedWidget);
        if (index >= 0 && index < workflowNode.widgets_values.length) {
            workflowNode.widgets_values[index] = seedToUse;
        }
    }
    if (workflowNode?.widgets_values_named && typeof workflowNode.widgets_values_named === "object") {
        workflowNode.widgets_values_named.seed = seedToUse;
    }

    // "use_last" overrides the value shown in the UI as well.
    if (node.useLastWidget?.value && typeof node.lastSeed === "number" && widgetSeed !== seedToUse) {
        node.seedWidget.value = seedToUse;
        app.graph?.setDirtyCanvas?.(true, false);
    }

    node.lastSeed = seedToUse;
    updateLastSeedButton(node);
}

function applySeedOverrides(apiPrompt) {
    for (const node of [...seedNodes]) {
        try {
            applySeedOverride(node, apiPrompt);
        } catch (error) {
            console.error("[Seed (QQ)] Failed to apply seed override:", error);
        }
    }
}

let queueHookInstalled = false;

function installQueueHook() {
    if (queueHookInstalled) return;
    if (typeof api.queuePrompt !== "function") {
        // API not ready yet in some frontend versions; retry shortly.
        setTimeout(installQueueHook, 500);
        return;
    }
    queueHookInstalled = true;

    const originalQueuePrompt = api.queuePrompt;
    api.queuePrompt = async function (index, prompt, ...args) {
        try {
            applySeedOverrides(prompt);
        } catch (error) {
            console.error("[Seed (QQ)] Failed to apply seed overrides:", error);
        }
        return originalQueuePrompt.apply(this, [index, prompt, ...args]);
    };
}

function onSeedNodeCreated(node) {
    seedNodes.add(node);

    node.seedWidget = (node.widgets ?? []).find((w) => w.name === "seed");
    node.useLastWidget = (node.widgets ?? []).find((w) => w.name === "use_last");
    node.lastSeed = undefined;

    // Remove any control_after_generate widget because special seeds are handled here.
    const controlWidget = (node.widgets ?? []).find((w) => w.name === "control_after_generate");
    if (controlWidget) {
        node.widgets.splice(node.widgets.indexOf(controlWidget), 1);
    }

    node.generateRandomSeed = () => generateRandomSeed(node);

    node.addWidget("button", "🎲 Randomize Each Time", "", () => {
        node.seedWidget.value = SPECIAL_SEED_RANDOM;
        updateLastSeedButton(node);
        app.graph?.setDirtyCanvas?.(true, false);
    }, { serialize: false });

    node.addWidget("button", "🎲 New Fixed Random", "", () => {
        node.seedWidget.value = generateRandomSeed(node);
        updateLastSeedButton(node);
        app.graph?.setDirtyCanvas?.(true, false);
    }, { serialize: false });

    node.lastSeedButton = node.addWidget("button", LAST_SEED_BUTTON_LABEL, "", () => {
        useLastSeed(node);
    }, { serialize: false });

    // Keep the last-seed button state in sync with manual seed edits.
    if (node.seedWidget) {
        const originalSeedCallback = node.seedWidget.callback;
        node.seedWidget.callback = function () {
            const result = originalSeedCallback?.apply(this, arguments);
            updateLastSeedButton(node);
            return result;
        };
    }

    // Turning "use_last" on immediately shows the remembered seed in the UI.
    if (node.useLastWidget) {
        const originalCallback = node.useLastWidget.callback;
        node.useLastWidget.callback = function (value) {
            if (value && typeof node.lastSeed === "number") {
                useLastSeed(node);
            } else {
                updateLastSeedButton(node);
            }
            return originalCallback?.apply(this, arguments);
        };
    }

    updateLastSeedButton(node);

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        seedNodes.delete(node);
        return originalOnRemoved?.apply(this, arguments);
    };
}

installQueueHook();

app.registerExtension({
    name: "SAQQ.Seed",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            onSeedNodeCreated(this);
            return result;
        };
    },
});
