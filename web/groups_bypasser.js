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

function getGroupsSorted() {
    const groups = [...(app.graph._groups || [])];
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
    let groups = getGroupsSorted();

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
    app.graph.setDirtyCanvas(true, false);
}

function refreshWidgets(node) {
    if (!node.graph || !app.graph._nodes?.includes(node)) return;

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
            const override = node.widgets?.find((w) => w.name === "override");
            if (override) {
                const origCallback = override.callback;
                override.callback = function (value) {
                    setAll(node, !!value);
                    return origCallback?.apply(this, arguments);
                };
            }

            node.refreshWidgets();
            node._gbInterval = setInterval(() => node.refreshWidgets(), 600);

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
