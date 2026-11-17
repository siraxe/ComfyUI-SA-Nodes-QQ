/**
 * Any Switch (QQ)
 * Port of rgthree's "Any Switch". Outputs the first non-empty connected input.
 *
 * Fixes vs. the original: all link/slot resolution is done against the graph
 * the node actually lives in (node.graph), instead of app.graph /
 * app.canvas.getCurrentGraph(), so it works when placed inside a subgraph.
 */
import { app } from "../../scripts/app.js";

const MIN_INPUTS = 4;

// #region subgraph-safe graph helpers -----------------------------------------

function resolveLinkObj(graph, linkId) {
    return (
        graph?.getLink?.(linkId) ??
        graph?.links?.get?.(linkId) ??
        graph?.links?.[linkId] ??
        graph?._links?.get?.(linkId) ??
        null
    );
}

function getNodeById(graph, id) {
    return (
        graph?.getNodeById?.(id) ??
        graph?._nodes_by_id?.[id] ??
        graph?._nodes?.find?.((n) => n.id === id) ??
        null
    );
}

function getSlotLinks(graph, slot) {
    const links = [];
    if (!slot) return links;
    if (Array.isArray(slot.links)) {
        for (const id of slot.links) {
            const l = resolveLinkObj(graph, id);
            if (l) links.push(l);
        }
    } else if (slot.link != null) {
        const l = resolveLinkObj(graph, slot.link);
        if (l) links.push(l);
    }
    return links;
}

function isSlotConnected(node, index) {
    const slot = node.inputs?.[index];
    if (!slot) return false;
    return getSlotLinks(node.graph, slot).length > 0;
}

/**
 * Slot array for a node on a given side ("input"/"output"). Falls back to
 * `node.slots` for subgraph IO nodes (SubgraphInputNode / SubgraphOutputNode),
 * which expose their subgraph boundary slots that way and have no
 * .inputs/.outputs arrays.
 */
function slotsFor(node, side) {
    if (!node) return null;
    const primary = side === "output" ? node.outputs : node.inputs;
    if (primary) return primary;
    if (Array.isArray(node.slots)) return node.slots;
    return null;
}

/**
 * Recurses at the NODE level (like rgthree), never blindly following links:
 * going upstream ("input") we scan the connected node's own INPUTS next;
 * going downstream ("output") its OUTPUTS. A slot-level recursion could head
 * in the wrong direction through "*"-typed slots and pick up an unrelated
 * type (e.g. a downstream consumer's CLIP input instead of the upstream
 * CONDITIONING source). Always resolves against `graph` (the node's own
 * graph), so it works inside subgraphs.
 */
function followTypeFromNode(graph, node, dir, depth, visited) {
    if (!node || depth > 32) return null;
    const key = `${node.id}:${dir}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const slots = slotsFor(node, dir);
    if (!slots) return null;
    for (const slot of slots) {
        for (const link of getSlotLinks(graph, slot)) {
            const otherId = dir === "output" ? link.target_id : link.origin_id;
            const otherSlotNum = dir === "output" ? link.target_slot : link.origin_slot;
            const otherNode = getNodeById(graph, otherId);
            if (!otherNode) continue;
            const otherSlot = slotsFor(otherNode, dir === "output" ? "input" : "output")?.[
                otherSlotNum
            ];
            if (!otherSlot) continue;
            if (otherSlot.type != null && otherSlot.type !== "*") {
                return { type: otherSlot.type, label: otherSlot.label ?? otherSlot.name };
            }
            const r = followTypeFromNode(graph, otherNode, dir, depth + 1, visited);
            if (r) return r;
        }
    }
    return null;
}

function followConnectionUntilType(node, dir) {
    const visited = new Set();
    const slots = slotsFor(node, dir);
    if (!slots?.length) return null;
    for (const slot of slots) {
        if (slot.type != null && slot.type !== "*") {
            return { type: slot.type, label: slot.label ?? slot.name };
        }
        for (const link of getSlotLinks(node.graph, slot)) {
            const otherId = dir === "output" ? link.target_id : link.origin_id;
            const otherSlotNum = dir === "output" ? link.target_slot : link.origin_slot;
            const otherNode = getNodeById(node.graph, otherId);
            if (!otherNode) continue;
            const otherSlot = slotsFor(otherNode, dir === "output" ? "input" : "output")?.[
                otherSlotNum
            ];
            if (!otherSlot) continue;
            if (otherSlot.type != null && otherSlot.type !== "*") {
                return { type: otherSlot.type, label: otherSlot.label ?? otherSlot.name };
            }
            const r = followTypeFromNode(node.graph, otherNode, dir, 1, visited);
            if (r) return r;
        }
    }
    return null;
}

// #endregion ------------------------------------------------------------------

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

function addAnyInput(node, num = 1) {
    for (let i = 0; i < num; i++) {
        node.addInput(
            `any_${String(node.inputs.length + 1).padStart(2, "0")}`,
            node._asNodeType || "*",
        );
    }
}

function stabilize(node) {
    if (!node.graph || !node.inputs) return;

    // Trim trailing unconnected inputs, keeping MIN_INPUTS.
    for (let i = node.inputs.length - 1; i >= MIN_INPUTS; i--) {
        if (isSlotConnected(node, i)) break;
        node.removeInput(i);
    }
    // Always leave one free input to connect to.
    addAnyInput(node);

    // Adapt input/output types to what is actually connected.
    let connectedType =
        followConnectionUntilType(node, "input") ||
        followConnectionUntilType(node, "output");
    node._asNodeType = connectedType?.type || "*";
    for (const input of node.inputs) input.type = node._asNodeType;
    for (const output of node.outputs || []) {
        output.type = node._asNodeType;
        output.label = String(node._asNodeType);
    }
    app.graph.setDirtyCanvas(true, false);
}

app.registerExtension({
    name: "SAQQ.AnySwitch",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "AnySwitch") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const node = this;

            // Fresh node: start with five inputs (configure() re-adds whatever
            // the stored workflow had).
            if (!node.inputs?.length) addAnyInput(node, 5);

            node._asStabilize = debounce(() => stabilize(node), 64);

            // Stabilize shortly after creation and after workflow load.
            setTimeout(() => node._asStabilize?.(), 100);
            setTimeout(() => node._asStabilize?.(), 600);

            return r;
        };

        // Hook once on the prototype (not per instance).
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            origOnConnectionsChange?.apply(this, arguments);
            this._asStabilize?.();
        };
    },
});
