/**
 * Groups Bypasser (QQ)
 * Simplified adaptation of rgthree's "Fast Groups Bypasser".
 * Lists every group in the current graph as a toggle widget; toggling a group
 * bypasses (or enables) all nodes inside it. The "override" widget forces
 * every listed group to the same state.
 */
import { app } from "../../scripts/app.js";

const MODE_ON = 0;      // LiteGraph.ALWAYS
const MODE_BYPASS = 4;  // bypassed

function recomputeGroup(group) {
    if (typeof group.recomputeInsideNodes === "function") {
        group.recomputeInsideNodes();
    }
    return group.nodes || [];
}

function isGroupEnabled(group) {
    const nodes = recomputeGroup(group);
    return nodes.length > 0 && nodes.some((n) => n.mode === MODE_ON);
}

function setGroupEnabled(group, enabled) {
    for (const n of recomputeGroup(group)) {
        n.mode = enabled ? MODE_ON : MODE_BYPASS;
    }
}

function normalizeColor(color) {
    color = (color || "").replace("#", "").trim().toLowerCase();
    if (!color) return null;
    if (window.LGraphCanvas?.node_colors?.[color]) {
        color = window.LGraphCanvas.node_colors[color].groupcolor.replace("#", "").toLowerCase();
    }
    if (color.length === 3) {
        color = color.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
    }
    return "#" + color;
}

function getAllGroupsSorted(graph) {
    // Groups of the graph the node lives in, plus groups of all subgraphs
    // (mirrors rgthree's FastGroupsService, which walks graph.subgraphs).
    const seen = new Set(graph?._groups || []);
    const groups = [...seen];
    const subgraphs = app.graph?.subgraphs?.values?.();
    if (subgraphs) {
        let s;
        while ((s = subgraphs.next().value)) {
            for (const g of s.groups || []) {
                if (!seen.has(g)) {
                    seen.add(g);
                    groups.push(g);
                }
            }
        }
    }
    groups.sort((a, b) => {
        const aY = Math.floor((a._pos?.[1] ?? 0) / 30);
        const bY = Math.floor((b._pos?.[1] ?? 0) / 30);
        if (aY !== bY) return aY - bY;
        return Math.floor((a._pos?.[0] ?? 0) / 30) - Math.floor((b._pos?.[0] ?? 0) / 30);
    });
    return groups;
}

function filterGroups(node) {
    const props = node.properties || {};
    let groups = getAllGroupsSorted(node.graph);

    const titleFilter = (props.matchTitle || "").trim();
    if (titleFilter) {
        try {
            const re = new RegExp(titleFilter, "i");
            groups = groups.filter((g) => re.test(g.title));
        } catch (e) {
            console.error("[GroupsBypasser] invalid matchTitle regex:", e);
        }
    }

    const colors = (props.matchColors || "")
        .split(",")
        .map((c) => normalizeColor(c))
        .filter(Boolean);
    if (colors.length) {
        groups = groups.filter((g) => colors.includes(normalizeColor(g.color || "")));
    }
    return groups;
}

function setAll(node, enabled) {
    for (const w of node.widgets || []) {
        if (w.isGroupsBypasserToggle) {
            w.value = enabled;
            setGroupEnabled(w.group, enabled);
        }
    }
    node._gbSig = null;
    node.graph?.setDirtyCanvas(true, false);
    app.graph.setDirtyCanvas(true, false);
}

// #region override via subgraph input -----------------------------------------
// When "override" is promoted to a subgraph input, the frontend stores the
// value on the HOST node (pinia widgetValueStore) and deliberately never
// writes it through to the inner widget ("adoptPromotedWidgetValue" only runs
// at unpack time). Since this node never executes, the inner widget would
// never see the value. So we watch the host node's projected widget instead:
// its `value` getter reads the store live.

function applyHostOverride(node, value) {
    if (!node.graph) return; // node was removed; drop stale host callbacks
    value = !!value;
    if (node._qqHostOverride === value) return;
    node._qqHostOverride = value;
    const override = (node.widgets || []).find((w) => w.name === "override");
    if (override && override.value !== value) {
        override.value = value; // intercepted setter -> setAll()
    } else if (override) {
        setAll(node, value);
    }
}

function* iterSubgraphHosts(graph) {
    for (const n of graph?._nodes || []) {
        if (n.isSubgraphNode?.() && n.subgraph) {
            yield n;
            yield* iterSubgraphHosts(n.subgraph); // handle nesting
        }
    }
}

function truthy(v) {
    if (typeof v === "number") return v !== 0;
    return !!v;
}

// Core logic nodes (comfy_extras/nodes_logic.py) we can evaluate inline.
// Only "Not" changes the value along the chain; AND/OR/XOR need several
// independent inputs so walking stops there.
const QQ_LOGIC_NODES = {
    ComfyNotNode: (v) => !v,
};

/**
 * Walks forward from a subgraph input slot through inline logic nodes
 * (e.g. "Not", legacy "Reroute") and returns the value arriving at any
 * input of `target`, or null when `target` is not fed by that slot.
 */
function resolveValueToNode(graph, linkIds, target, value, depth, visitedLinks) {
    if (depth > 32) return null;
    for (const linkId of linkIds || []) {
        if (visitedLinks.has(linkId)) continue;
        visitedLinks.add(linkId);
        const link = graph?.getLink?.(linkId);
        if (!link) continue;
        let tNode = null;
        try {
            tNode = link.resolve?.(graph)?.inputNode ?? null;
        } catch (e) {
            tNode = null;
        }
        if (!tNode && link.target_id != null) {
            tNode =
                graph.getNodeById?.(link.target_id) ??
                graph._nodes_by_id?.[link.target_id] ??
                null;
        }
        if (!tNode) continue;
        if (tNode === target) return value;

        const logic = QQ_LOGIC_NODES[tNode.type];
        if (logic || tNode.type === "Reroute") {
            const next = logic ? logic(truthy(value)) : truthy(value);
            const outLinkIds = (tNode.outputs || []).flatMap((o) =>
                o.links || [o.link].filter(Boolean),
            );
            const r = resolveValueToNode(
                graph,
                outLinkIds,
                target,
                next,
                depth + 1,
                visitedLinks,
            );
            if (r !== null) return r;
        }
    }
    return null;
}

/**
 * Finds the subgraph's interior input slot "override" if it feeds THIS node
 * (directly, or through inline logic like "Not"), so sibling Groups Bypasser
 * nodes with different group filters are not affected. The linkIds live on
 * the interior SubgraphInput slot (subgraph.inputNode.slots / subgraph.inputs)
 * — instance input slots on the host only have a single `link`.
 */
function findWiredSubgraphInput(node) {
    const subgraph = node.graph;
    if (!subgraph || subgraph === app.graph) return null;
    const slots = subgraph.inputNode?.slots || subgraph.inputs || [];
    for (const slot of slots) {
        if (slot.name !== "override") continue;
        if (resolveValueToNode(subgraph, slot.linkIds, node, true, 0, new Set()) !== null) {
            return slot;
        }
    }
    return null;
}

function syncHostOverride(node) {
    if (!node.graph || node.graph === app.graph) return;
    const slot = findWiredSubgraphInput(node);
    if (!slot) return; // override input isn't wired to this node

    // Computes the (possibly inverted) value this node receives from the
    // subgraph input; null => wiring changed / no longer fed by this slot.
    const transform = (v) =>
        resolveValueToNode(node.graph, slot.linkIds, node, truthy(v), 0, new Set());

    for (const host of iterSubgraphHosts(app.graph)) {
        if (host.subgraph !== node.graph) continue;
        // This instance's promoted widget for the same input name; its
        // store-backed `value` getter reads the pinia store live.
        const input = (host.inputs || []).find((i) => i.name === slot.name);
        if (!input || input.widgetId == null) continue;
        const w = (host.widgets || []).find((w) => w.widgetId === input.widgetId);
        if (!w) continue;

        if (!w._qqOverrideHook) {
            w._qqOverrideHook = true;
            const origCallback = w.callback;
            w.callback = function (value) {
                const t = transform(value);
                if (t !== null) applyHostOverride(node, t);
                return origCallback?.apply(this, arguments);
            };
        }
        const t = transform(w.value);
        if (t !== null) applyHostOverride(node, t);
    }
}
// #endregion ------------------------------------------------------------------

function refreshWidgets(node) {
    // Use the node's own graph (which is the subgraph when nested), not app.graph.
    if (!node.graph || !node.graph._nodes?.includes(node)) return;

    const groups = filterGroups(node);
    const sig = groups.map((g) => `${g.title}:${isGroupEnabled(g) ? 1 : 0}`).join("|");
    if (node._gbSig === sig) return;
    node._gbSig = sig;

    // Remove old toggles (keep the Python-defined widgets, e.g. "override").
    for (const w of [...(node.widgets || [])]) {
        if (w.isGroupsBypasserToggle) node.removeWidget(w);
    }

    for (const group of groups) {
        const widget = node.addWidget(
            "toggle",
            `Enable ${group.title}`,
            isGroupEnabled(group),
            () => {
                setGroupEnabled(group, widget.value);
                node._gbSig = null; // force resync on next refresh
                app.graph.setDirtyCanvas(true, false);
            },
            { on: "on", off: "off" },
        );
        widget.isGroupsBypasserToggle = true;
        widget.group = group;
    }

    node.setSize?.(node.computeSize());
    node.graph?.setDirtyCanvas(true, false);
    app.graph.setDirtyCanvas(true, false);
}

app.registerExtension({
    name: "SAQQ.GroupsBypasser",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "GroupsBypasser") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.properties ??= {};
            if (node.properties.matchColors === undefined) node.properties.matchColors = "";
            if (node.properties.matchTitle === undefined) node.properties.matchTitle = "";

            // Group states live in the actual node modes; don't serialize widgets
            // (avoids misaligned widgets_values when the group list changes).
            node.serialize_widgets = false;
            node.refreshWidgets = () => refreshWidgets(node);

            // "override" bool widget: force every listed group on/off.
            // Intercept the value SETTER (not just .callback): when this widget is
            // exposed as a subgraph input and driven from outside, the frontend syncs
            // it by assigning widget.value programmatically and never calls .callback.
            const override = node.widgets?.find((w) => w.name === "override");
            if (override) {
                let overrideValue = override.value;
                Object.defineProperty(override, "value", {
                    get() {
                        return overrideValue;
                    },
                    set(v) {
                        v = !!v;
                        if (v !== overrideValue) {
                            overrideValue = v;
                            setAll(node, v);
                        }
                    },
                    configurable: true,
                });
            }

            node.refreshWidgets();
            node._gbInterval = setInterval(() => {
                node.refreshWidgets();
                syncHostOverride(node);
            }, 600);

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(node._gbInterval);
                return origOnRemoved?.apply(this, arguments);
            };
            return r;
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.unshift(
                {
                    content: "Enable all",
                    callback: () => setAll(this, true),
                },
                {
                    content: "Bypass all",
                    callback: () => setAll(this, false),
                },
                {
                    content: "Toggle all",
                    callback: () => {
                        const toggles = (this.widgets || []).filter((w) => w.isGroupsBypasserToggle);
                        setAll(this, !toggles.some((w) => w.value));
                    },
                },
            );
        };
    },
});
