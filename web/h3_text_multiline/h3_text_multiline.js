import { app } from "../../../scripts/app.js";
import { ensureLinks, normalizeLinks, pruneLinksForMode, syncMediaOrderWidget, getMediaInputIndex, hideMediaOrderWidget, patchCanvas, scheduleNativeMediaConnectionConversion } from "./links.js";
import { installPromptEditor as installPromptEditorSoon, closeMentionMenu, renderEditorFromNode } from "./editor.js";

// Minimal port of the MiniMax H3 Easy virtual-media frontend for the
// H3TextMultiline node: virtual media wires (drawn on the canvas, converted
// from native connections, right-click to delete), mode-based media limits,
// and an "@" mention popup over the plain multiline text widget. The ordered
// media types are mirrored into the hidden "media_order" widget so the server
// can resolve "@Picture 1"-style tokens into official H3 tags.

export const NODE_CLASS = "H3TextMultiline";
export const LINKS_PROP = "h3_qq_media_links";
export const MODE_IMAGE = "image";
export const MODE_REFERENCE = "reference";
export const MAX_MEDIA = 15;
export const COLOR_IMAGE = "#5aa9f0";
export const COLOR_LINK_BORDER = "rgba(0,0,0,0.5)";
export const COMFY_NATIVE_LINK_COLOR = "#9A9";
export const TYPE_LABELS = { image: "Picture", video: "Video", audio: "Audio" };
export const TYPE_COLORS = { image: "#5aa9f0", video: "#c792ea", audio: "#00e2bb" };

const ZH_BROWSER = /^(zh)/i.test(String(globalThis.navigator?.language || globalThis.navigator?.languages?.[0] || ""));
export const TEXT = {
    mentionTitle: ZH_BROWSER ? "引用媒体 (@)" : "Reference media (@)",
    mentionEmpty: ZH_BROWSER ? "未连接媒体" : "No media connected",
    mentionNoMatch: ZH_BROWSER ? "无匹配媒体" : "No matching media",
    deleteLink: ZH_BROWSER ? "删除媒体连接" : "Delete media link",
};

export function getWidget(node, name) {
    return (node?.widgets || []).find((widget) => String(widget?.name || "") === name) || null;
}

export function getWidgetValue(node, name, fallback = "") {
    const widget = getWidget(node, name);
    return widget?.value === undefined || widget?.value === null ? fallback : widget.value;
}

export function isReferenceMode(node) {
    return String(getWidgetValue(node, "mode", MODE_REFERENCE)) === MODE_REFERENCE;
}

// ComfyUI serializes widgets_values by absolute index, leaving a hole where
// the serialize:false DOM editor sits (spliced right after the text widget),
// but restores by a sequential counter that skips the editor — so every widget
// after it lands on the wrong slot on load, corrupting mode/media_order/
// strip_newlines. Realign by name. Prefer the name-keyed widgets_values_named
// (authoritative, immune to the hole) when present; otherwise strip the null
// placeholder and map positionally.
const WIDGET_ORDER = ["text", "mode", "media_order", "strip_newlines"];
const WIDGET_DEFAULTS = { text: "", mode: MODE_REFERENCE, media_order: "", strip_newlines: false };

function repairConfiguredWidgetValues(node, info) {
    if (!info) return;
    const byName = {};
    const named = info.widgets_values_named;
    if (named && typeof named === "object") {
        for (const name of WIDGET_ORDER) byName[name] = named[name];
    } else if (Array.isArray(info.widgets_values)) {
        let saved = [...info.widgets_values];
        if (saved.length === WIDGET_ORDER.length + 1) {
            const hole = saved.findIndex((value) => value == null);
            if (hole >= 0) saved.splice(hole, 1);
        }
        WIDGET_ORDER.forEach((name, index) => {
            byName[name] = index < saved.length ? saved[index] : undefined;
        });
    }
    for (const name of WIDGET_ORDER) {
        const value = byName[name] !== undefined ? byName[name] : WIDGET_DEFAULTS[name];
        const widget = getWidget(node, name);
        if (widget) widget.value = value;
    }
    info.widgets_values = WIDGET_ORDER.map((name) =>
        byName[name] !== undefined ? byName[name] : WIDGET_DEFAULTS[name]);
}

// ---------------------------------------------------------------------------
// Node hooks
// ---------------------------------------------------------------------------

function installNode(nodeType) {
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function onNodeCreatedH3QQ() {
        const result = originalCreated?.apply(this, arguments);
        this.properties ||= {};
        ensureLinks(this);
        normalizeLinks(this);
        hideMediaOrderWidget(this);
        patchCanvas();
        installPromptEditorSoon(this);
        const modeWidget = getWidget(this, "mode");
        if (modeWidget && !modeWidget.__h3qqBound) {
            modeWidget.__h3qqBound = true;
            const originalCallback = modeWidget.callback;
            modeWidget.callback = (value) => {
                originalCallback?.call(modeWidget, value);
                pruneLinksForMode(this);
                closeMentionMenu(this);
                if (this.__h3qqEditor) renderEditorFromNode(this, true);
                this.setDirtyCanvas?.(true, true);
            };
        }
        return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function onConfigureH3QQ(info) {
        const result = originalConfigure?.apply(this, arguments);
        this.properties ||= {};
        repairConfiguredWidgetValues(this, info);
        normalizeLinks(this);
        syncMediaOrderWidget(this);
        const mediaInputIndex = getMediaInputIndex(this);
        if (mediaInputIndex >= 0 && this.inputs?.[mediaInputIndex]?.link != null) {
            scheduleNativeMediaConnectionConversion(this, mediaInputIndex);
        }
        installPromptEditorSoon(this);
        return result;
    };

    const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function onConnectionsChangeH3QQ(type, index, connected, linkInfo) {
        const result = originalConnectionsChange?.apply(this, arguments);
        const inputIndex = Number(index);
        const input = this.inputs?.[Number.isFinite(inputIndex) ? inputIndex : -1];
        if (connected && !this.__h3qqWireClearing && /^media(?:_\d+)?$/i.test(String(input?.name || ""))) {
            scheduleNativeMediaConnectionConversion(this, inputIndex, linkInfo);
        }
        if (this.__h3qqEditor) renderEditorFromNode(this, true);
        return result;
    };

    // Rebuild the editor within one frame if its DOM was detached (e.g. a
    // workspace-tab switch that rebuilds node widget DOM). Mirrors Easy's
    // onDrawForeground recovery so text never visibly blanks out. Must null the
    // stale refs first: installPromptEditorFactory early-returns when
    // __h3qqEditor is set, even if that element has left the document.
    const originalDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function onDrawForegroundH3QQ(ctx) {
        const result = originalDraw?.apply(this, arguments);
        // Only recover an editor that WAS installed and then detached. A null
        // editor means the initial-install retry path (onNodeCreated/onConfigure)
        // still owns reinstallation; acting here would race it per frame.
        const editor = this.__h3qqEditor;
        if (!editor || document.contains(editor)) return result;
        if (this.__h3qqHealPending || this.__h3qqHookRetry) return result; // already recovering
        this.__h3qqHealPending = true;
        const self = this;
        const run = () => {
            self.__h3qqHealPending = false;
            if (!app.graph?.getNodeById?.(self.id)) return; // node removed while pending
            if (self.__h3qqEditor && document.contains(self.__h3qqEditor)) return; // healed meanwhile
            self.__h3qqEditor = null;
            self.__h3qqEditorWrap = null;
            installPromptEditorSoon(self);
        };
        (typeof requestAnimationFrame === "function" ? requestAnimationFrame : setTimeout)(run, 0);
        return result;
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function onRemovedH3QQ() {
        closeMentionMenu(this);
        if (this.__h3qqHookRetry) clearTimeout(this.__h3qqHookRetry);
        this.__h3qqHookRetry = null;
        this.__h3qqHealPending = false;
        this.__h3qqHookAttempts = 0;
        this.__h3qqEditor = null;
        this.__h3qqEditorWrap = null;
        this.__h3qqDomWidget = null;
        return originalRemoved?.apply(this, arguments);
    };
}

console.log("[H3QQ] extension file loaded (H3TextMultiline)");
app.registerExtension({
    name: "SA-Nodes-QQ.H3TextMultiline",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name === NODE_CLASS) installNode(nodeType);
    },
});
