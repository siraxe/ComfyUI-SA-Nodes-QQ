import { app } from "../../../scripts/app.js";
import { NODE_CLASS, TYPE_LABELS, TYPE_COLORS, COLOR_IMAGE, TEXT, getWidget, isReferenceMode } from "./h3_text_multiline.js";
import { normalizeLinks } from "./links.js";

// ---------------------------------------------------------------------------
// Mention popup over the native multiline textarea
// ---------------------------------------------------------------------------

function ensureStyles() {
    if (document.getElementById("h3qq-mention-styles")) return;
    const style = document.createElement("style");
    style.id = "h3qq-mention-styles";
    style.textContent = `
.h3qq-mention-menu{position:fixed;z-index:100001;min-width:210px;max-width:320px;max-height:320px;overflow-y:auto;
background:rgba(32,32,36,.97);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:4px;
box-shadow:0 10px 28px rgba(0,0,0,.55);font:12px/1.45 system-ui,sans-serif;color:#e6e6e6;user-select:none}
.h3qq-mention-title{padding:4px 8px 6px;font-size:11px;color:#9a9a9a;letter-spacing:.02em}
.h3qq-mention-empty{padding:8px 10px;color:#9a9a9a}
.h3qq-mention-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
.h3qq-mention-item.is-active{background:rgba(90,169,240,.28)}
.h3qq-mention-badge{flex:none;min-width:60px;text-align:center;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;color:#141414}
.h3qq-mention-main{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h3qq-mention-detail{color:#9a9a9a;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h3qq-mention-text{min-width:0;display:flex;flex-direction:column}
.h3qq-mention-thumb{width:36px;height:36px;object-fit:cover;border-radius:5px;flex:none;background:rgba(255,255,255,.1)}
.h3qq-editor-wrap{position:relative;display:block;width:100%;height:100%;min-width:0;min-height:0;max-height:100%;
box-sizing:border-box;padding:0;border-radius:var(--h3qq-native-radius,0);overflow:hidden;contain:size layout paint}
.h3qq-editor{--h3qq-text-size:var(--comfy-textarea-font-size,12px);
display:block;width:100%;height:100%;min-width:0;min-height:0;max-height:100%;box-sizing:border-box;
padding:var(--h3qq-native-padding,2px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
white-space:pre-wrap;overflow-wrap:anywhere;border:0;border-radius:var(--h3qq-native-radius,0);outline:none;resize:none;
background-color:var(--h3qq-native-bg,var(--comfy-input-bg,#222));color:var(--h3qq-native-text,var(--input-text,#ddd));
caret-color:var(--h3qq-native-text,var(--input-text,#ddd));
font-family:Consolas,"Courier New",monospace;font-size:var(--h3qq-text-size);font-weight:400;line-height:normal;letter-spacing:0}
.h3qq-editor :not(.h3qq-mention-chip):not(.h3qq-mention-chip *){
font-family:Consolas,"Courier New",monospace !important;font-size:var(--h3qq-text-size) !important;
font-weight:400 !important;font-style:normal !important;line-height:normal !important;letter-spacing:0 !important}
.h3qq-editor-wrap.h3qq-native-vue-nodes .h3qq-editor:focus{
box-shadow:0 0 0 1px var(--h3qq-native-focus,var(--h3qq-native-outline,rgba(255,255,255,.18)))}
.h3qq-editor:empty::before{content:attr(data-placeholder);color:var(--h3qq-native-muted,rgba(255,255,255,.38));pointer-events:none}
.h3qq-mention-chip{display:inline;max-width:150px;margin:0 1px;padding:0;vertical-align:baseline;border:0;border-radius:0;
background:transparent;color:rgba(0,226,187,.98);font-family:inherit;font-size:var(--h3qq-text-size,12px);
font-weight:400;line-height:inherit;letter-spacing:0;user-select:text;cursor:text}
.h3qq-mention-chip.is-unresolved{color:#ff9b9b;text-decoration:underline wavy rgba(255,110,110,.86);text-decoration-thickness:1px}
.h3qq-mention-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:baseline}
.h3qq-mention-chip-thumb{display:inline-block;width:16px;height:16px;margin-right:2px;object-fit:cover;border-radius:3px;
vertical-align:-2px;background:rgba(255,255,255,.12);user-select:none}
.h3qq-mention-chip-thumb.is-image{background:#5aa9f0}
.h3qq-mention-chip-thumb.is-video{position:relative;background:linear-gradient(135deg,#1557b8,#49b6ff)}
.h3qq-mention-chip-thumb.is-video::after{content:"";position:absolute;left:6px;top:4px;
border-left:6px solid rgba(255,255,255,.9);border-top:4px solid transparent;border-bottom:4px solid transparent}
`;
    document.head.append(style);
}

// ---------------------------------------------------------------------------
// Structured contentEditable editor (port of MiniMax H3 Easy's prompt editor)
// Media are rendered as inline chips with thumbnails inside the text area, and
// typing "@" opens the mention picker. No `widget.inputEl` dependency.
// ---------------------------------------------------------------------------

const AUDIO_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
const CHIP_CLASS = "h3qq-mention-chip";
const TOKEN_RE = /@(Picture|Video|Audio)\s+(\d+)/g;

// Self-heal state: when the contentEditable widget is detached (e.g. after a
// tab/workspace switch that rebuilds node DOM) its text appears lost even
// though the hidden "text" widget still holds it. Snapshot on every sync and
// restore+rebuild if the editor element ever ends up outside the document.
const HEAL_INTERVAL_MS = 3000;
let healTimerId = null;

function getWidgetValueLocal(node) {
    return String(getWidget(node, "text")?.value ?? "");
}

function snapshotNodeText(node) {
    const value = getWidgetValueLocal(node);
    node.properties ||= {};
    if (node.properties.__h3qqLastSyncedText !== value) node.properties.__h3qqLastSyncedText = value;
}

function installSelfHeal() {
    if (typeof document === "undefined" || healTimerId != null) return;
    const onVisibility = () => { if (!document.hidden) check(); };
    const stop = () => { clearInterval(healTimerId); healTimerId = null; document.removeEventListener("visibilitychange", onVisibility); };
    const check = () => {
        let hasH3Node = false;
        for (const node of app.graph?._nodes || []) {
            if (String(node?.comfyClass || node?.type) !== NODE_CLASS) continue;
            hasH3Node = true;
            if (!node.__h3qqEditor || !document.contains(node.__h3qqEditor)) continue;
            const text = getWidgetValueLocal(node);
            const snapshot = String(node.properties?.__h3qqLastSyncedText ?? "");
            // The DOM is gone while the value lives on: restore it (only when
            // a real snapshot exists so we never clobber fresh content), then
            // rebuild the editor so text is visible again.
            if (text === "" && snapshot !== "") {
                const widget = getWidget(node, "text");
                if (widget) widget.value = snapshot;
            }
            node.__h3qqEditor = null;
            node.__h3qqEditorWrap = null;
            installPromptEditorFactory(node);
            snapshotNodeText(node);
        }
        if (!hasH3Node) stop();
    };
    healTimerId = setInterval(check, HEAL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
}

function setWidgetOption(widget, key, value) {
    if (!widget) return;
    widget.options ||= {};
    if (value === undefined) delete widget.options[key];
    else widget.options[key] = value;
    if (widget._state?.options) {
        if (value === undefined) delete widget._state.options[key];
        else widget._state.options[key] = value;
    }
}

function isVueNodesMode() {
    return Boolean(globalThis.LiteGraph?.vueNodesMode);
}

function applyNativeEditorTheme(element) {
    if (!element?.style) return;
    const LiteGraph = globalThis.LiteGraph || {};
    const modern = isVueNodesMode();
    if (modern) {
        element.classList.add("h3qq-native-vue-nodes");
        element.style.setProperty("--h3qq-native-bg", "var(--component-node-widget-background, var(--secondary-background, #222))");
        element.style.setProperty("--h3qq-native-text", "var(--component-node-foreground, var(--base-foreground, #ddd))");
        element.style.setProperty("--h3qq-native-outline", "var(--border-default, rgba(255,255,255,.18))");
        element.style.setProperty("--h3qq-native-focus", "var(--border-default, rgba(255,255,255,.28))");
        element.style.setProperty("--h3qq-native-muted", "rgba(255,255,255,.42)");
        element.style.setProperty("--h3qq-native-radius", "var(--radius-lg, 8px)");
        element.style.setProperty("--h3qq-native-padding", "8px 12px");
    } else {
        element.style.setProperty("--h3qq-native-bg", "var(--comfy-input-bg, #222)");
        element.style.setProperty("--h3qq-native-text", "var(--input-text, #ddd)");
        element.style.setProperty("--h3qq-native-outline", "rgba(255,255,255,.18)");
        element.style.setProperty("--h3qq-native-focus", "rgba(255,255,255,.28)");
        element.style.setProperty("--h3qq-native-muted", "rgba(255,255,255,.42)");
        element.style.setProperty("--h3qq-native-radius", "0px");
        element.style.setProperty("--h3qq-native-padding", "2px");
    }
}

function hideOriginalTextWidget(widget) {
    if (!widget) return;
    if (!widget.__h3qqTextHidden) {
        widget.__h3qqTextHidden = true;
        widget.__h3qqOriginalType = widget.type;
        widget.__h3qqOriginalComputeSize = widget.computeSize;
        widget.__h3qqOriginalHidden = widget.hidden;
    }
    widget.hidden = true;
    setWidgetOption(widget, "hidden", true);
    setWidgetOption(widget, "canvasOnly", true);
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
}

function restoreOriginalTextWidget(widget) {
    if (!widget?.__h3qqTextHidden) return;
    widget.type = widget.__h3qqOriginalType || "customtext";
    widget.computeSize = widget.__h3qqOriginalComputeSize || (() => [220, 120]);
    widget.hidden = widget.__h3qqOriginalHidden ?? false;
    setWidgetOption(widget, "hidden", false);
    setWidgetOption(widget, "canvasOnly", false);
    widget.__h3qqTextHidden = false;
}

function makeMentionThumb(option, menu = false) {
    const className = menu ? "h3qq-mention-thumb" : "h3qq-mention-chip-thumb";
    if (option.type === "audio") {
        const span = document.createElement("span");
        span.className = `${className} is-audio`;
        span.style.color = TYPE_COLORS.audio;
        span.innerHTML = AUDIO_ICON_SVG;
        span.dataset.mediaType = "audio";
        return span;
    }
    if (option.previewUrl) {
        const image = document.createElement("img");
        image.className = className;
        image.alt = "";
        image.draggable = false;
        image.src = option.previewUrl;
        image.dataset.mediaType = option.type || "image";
        image.addEventListener("error", () => image.replaceWith(makeMentionThumb({ ...option, previewUrl: "" }, menu)), { once: true });
        return image;
    }
    const icon = document.createElement("span");
    icon.className = `${className} is-${option.type || "image"}`;
    icon.dataset.mediaType = option.type || "image";
    return icon;
}

function makeMentionChip(option) {
    const chip = document.createElement("span");
    chip.className = `${CHIP_CLASS}${option.unresolved ? " is-unresolved" : ""}`;
    chip.contentEditable = "false";
    chip.dataset.token = option.token || option.tag || "";
    chip.dataset.tag = option.tag || option.token || "";
    chip.dataset.label = option.label || "";
    chip.dataset.fullLabel = option.fullLabel || option.label || "";
    chip.dataset.mediaType = option.type || "image";
    chip.dataset.ordinal = Number(option.ordinal) || "";
    chip.dataset.sourceId = option.sourceId != null ? String(option.sourceId) : "";
    chip.title = option.fullLabel || option.label || "";
    const label = document.createElement("span");
    label.className = "h3qq-mention-chip-label";
    label.textContent = `@${option.label || ""}`;
    chip.append(makeMentionThumb(option), label);
    chip.addEventListener("pointerdown", (event) => {
        if (event.target?.closest?.(".h3qq-mention-chip-label")) return;
        event.preventDefault();
        event.stopPropagation();
        const selection = window.getSelection?.();
        if (!selection) return;
        const range = document.createRange();
        const rect = chip.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        before ? range.setStartBefore(chip) : range.setStartAfter(chip);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    });
    return chip;
}

function appendTextWithBreaks(container, value) {
    String(value || "").split("\n").forEach((part, index) => {
        if (index) container.append(document.createElement("br"));
        if (part) container.append(document.createTextNode(part));
    });
}

function tokenizePromptText(node, text) {
    const tokens = [];
    let last = 0;
    let match;
    TOKEN_RE.lastIndex = 0;
    const live = isReferenceMode(node) ? mentionOptions(node) : [];
    while ((match = TOKEN_RE.exec(String(text || ""))) !== null) {
        if (match.index > last) tokens.push({ type: "text", value: text.slice(last, match.index) });
        const kind = match[1].toLowerCase() === "picture" ? "image" : match[1].toLowerCase();
        const ordinal = Number(match[2]);
        const opt = live.find((o) => (o.type || "image") === kind && Number(o.ordinal) === ordinal)
            || { type: kind, ordinal, label: `${TYPE_LABELS[kind] || kind} ${ordinal}`, previewUrl: "", unresolved: true };
        tokens.push({ type: "mention", option: opt });
        last = match.index + match[0].length;
    }
    if (last < String(text || "").length) tokens.push({ type: "text", value: text.slice(last) });
    return tokens;
}

export function renderEditorFromNode(node, force = false) {
    const editor = node?.__h3qqEditor;
    const widget = getWidget(node, "text");
    if (!editor || !widget || (document.activeElement === editor && !force)) return;
    editor.textContent = "";
    for (const token of tokenizePromptText(node, String(widget.value || ""))) {
        if (token.type === "mention") editor.append(makeMentionChip(token.option));
        else appendTextWithBreaks(editor, token.value);
    }
    snapshotNodeText(node);
}

function serializeEditorText(editor) {
    let text = "";
    const visit = (item) => {
        if (item.nodeType === Node.TEXT_NODE) {
            text += String(item.textContent || "").replaceAll("​", "");
            return;
        }
        if (item.nodeType !== Node.ELEMENT_NODE) return;
        if (item.classList?.contains(CHIP_CLASS)) {
            text += String(item.dataset.tag || item.dataset.token || "");
            return;
        }
        if (item.tagName === "BR") {
            text += "\n";
            return;
        }
        for (const child of item.childNodes || []) visit(child);
    };
    for (const child of editor.childNodes || []) visit(child);
    return text;
}

function syncEditorFromNode(node) {
    const editor = node?.__h3qqEditor;
    const widget = getWidget(node, "text");
    if (!editor || !widget) return;
    const text = serializeEditorText(editor);
    if (String(widget.value ?? "") !== text) widget.value = text;
    snapshotNodeText(node);
    node.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
}

function getMentionRange(editor) {
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
    const caret = selection.getRangeAt(0);
    if (!editor.contains(caret.startContainer)) return null;
    // Build an editable-text stream that treats chips and line breaks as hard
    // boundaries, so a typed "@" right after a chip does not look like a query.
    const units = [];
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement?.closest?.(`.${CHIP_CLASS}`)) units.push({ kind: "text", node });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList?.contains(CHIP_CLASS)) {
            units.push({ kind: "chip", node });
            return;
        }
        if (node.tagName === "BR") {
            units.push({ kind: "break", node });
            return;
        }
        for (const child of node.childNodes || []) visit(child);
    };
    visit(editor);

    if (caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const currentIndex = units.findIndex((unit) => unit.kind === "text" && unit.node === caret.startContainer);
    if (currentIndex < 0) return null;

    const selected = [];
    for (let index = currentIndex; index >= 0; index -= 1) {
        const unit = units[index];
        if (unit.kind !== "text") break;
        const end = index === currentIndex ? caret.startOffset : (unit.node.textContent || "").length;
        selected.unshift({ unit, text: (unit.node.textContent || "").slice(0, end) });
    }
    const before = selected.map((entry) => entry.text).join("");
    const match = before.match(/@[^@\n]*$/);
    if (!match) return null;

    const targetStart = before.length - match[0].length;
    let offset = 0;
    const range = document.createRange();
    for (const entry of selected) {
        const next = offset + entry.text.length;
        if (targetStart <= next) {
            range.setStart(entry.unit.node, Math.max(0, targetStart - offset));
            break;
        }
        offset = next;
    }
    range.setEnd(caret.startContainer, caret.startOffset);
    return { range, query: match[0].slice(1) };
}

// ---------------------------------------------------------------------------
// Mention options data
// ---------------------------------------------------------------------------

function sourceLabel(node) {
    return String(node?.title || node?.comfyClass || node?.type || "Media");
}

function widgetFilename(value) {
    const candidate = typeof value === "object" ? (value?.filename || value?.name || "") : value;
    const text = String(candidate || "").trim();
    if (!text || /^data:|^blob:|^https?:/i.test(text)) return "";
    return text.split(/[\\/]/).pop() || text;
}

function sourceFilename(node, mediaType) {
    if (!node) return "";
    const preferred = {
        image: ["image", "filename", "file"],
        video: ["video", "file", "filename", "video_file", "videofile"],
        audio: ["audio", "file", "filename", "audio_file", "audiofile"],
    }[mediaType] || ["file", "filename"];
    const preferredSet = new Set(preferred);
    const widgets = Array.isArray(node.widgets) ? node.widgets : [];
    const ordered = [
        ...widgets.filter((widget) => preferredSet.has(String(widget?.name || "").toLowerCase())),
        ...widgets,
    ];
    for (const widget of ordered) {
        const name = String(widget?.name || "").toLowerCase();
        const filename = widgetFilename(widget?.value);
        if (!filename) continue;
        if (preferredSet.has(name) || /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|mkv|avi|m4v|mp3|wav|flac|ogg|m4a)$/i.test(filename)) return filename;
    }
    return widgetFilename(node?.properties?.filename || node?.properties?.file || "");
}

function refPreviewUrl(source, mediaType) {
    if (!source || mediaType === "audio") return "";
    for (const widget of source.widgets || []) {
        const el = widget?.element;
        if (!el || typeof el.querySelector !== "function") continue;
        const img = el.matches?.("img") ? el : el.querySelector("img");
        if (img?.src && !/data:/i.test(img.src)) return img.src;
        const video = el.matches?.("video") ? el : el.querySelector("video");
        if (video?.poster) return video.poster;
    }
    const filename = sourceFilename(source, mediaType);
    if (!filename) return "";
    const params = new URLSearchParams({ filename: String(filename), type: "input" });
    return `/view?${params.toString()}`;
}

function mentionOptions(node) {
    if (!isReferenceMode(node)) return [];
    const mediaOrder = { image: 0, video: 1, audio: 2 };
    const orderedLinks = normalizeLinks(node)
        .map((link, index) => ({ link, index }))
        .sort((left, right) => {
            const leftType = String(left.link.media_type || "image").toLowerCase();
            const rightType = String(right.link.media_type || "image").toLowerCase();
            return (mediaOrder[leftType] ?? 0) - (mediaOrder[rightType] ?? 0) || left.index - right.index;
        })
        .map((entry) => entry.link);
    const counts = { image: 0, video: 0, audio: 0 };
    return orderedLinks.map((link) => {
        const type = String(link.media_type || "image").toLowerCase();
        counts[type] = (counts[type] || 0) + 1;
        const ordinal = counts[type];
        const source = app.graph?.getNodeById?.(Number(link.source_id));
        const filename = sourceFilename(source, type);
        const label = `${TYPE_LABELS[type] || type} ${ordinal}`;
        return {
            type,
            ordinal,
            label,
            token: `@${label} `,
            fullLabel: filename || label,
            source: sourceLabel(source),
            sourceId: Number(link.source_id),
            previewUrl: refPreviewUrl(source, type),
        };
    });
}

// ---------------------------------------------------------------------------
// Mention popup UI
// ---------------------------------------------------------------------------

function positionMentionMenu(element, editor) {
    const selection = window.getSelection?.();
    const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const editorRect = editor.getBoundingClientRect();
    const rect = caret && (caret.width || caret.height) ? caret : editorRect;
    const width = Math.min(320, Math.max(210, element.offsetWidth || 210));
    const height = Math.min(320, element.offsetHeight || 120);
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    element.style.left = `${Math.max(8, Math.round(left))}px`;
    element.style.top = `${Math.max(8, Math.round(top))}px`;
}

export function closeMentionMenu(node) {
    const menu = node?.__h3qqMentionMenu;
    menu?.element?.remove?.();
    if (node) node.__h3qqMentionMenu = null;
}

function renderMentionMenu(node) {
    const state = node?.__h3qqMentionMenu;
    if (!state) return;
    const { element, options, activeIndex } = state;
    element.textContent = "";
    const title = document.createElement("div");
    title.className = "h3qq-mention-title";
    title.textContent = TEXT.mentionTitle;
    element.append(title);
    if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "h3qq-mention-empty";
        empty.textContent = state.hadMedia ? TEXT.mentionNoMatch : TEXT.mentionEmpty;
        element.append(empty);
        return;
    }
    options.forEach((option, index) => {
        const item = document.createElement("div");
        item.className = `h3qq-mention-item${index === activeIndex ? " is-active" : ""}`;
        const badge = document.createElement("span");
        badge.className = "h3qq-mention-badge";
        badge.textContent = option.label;
        badge.style.background = TYPE_COLORS[option.type] || COLOR_IMAGE;
        const text = document.createElement("div");
        text.className = "h3qq-mention-text";
        const main = document.createElement("div");
        main.className = "h3qq-mention-main";
        main.textContent = option.fullLabel;
        main.title = `${option.fullLabel} — ${option.source}`;
        const detail = document.createElement("div");
        detail.className = "h3qq-mention-detail";
        detail.textContent = option.source;
        text.append(main, detail);
        item.append(badge, text);
        item.addEventListener("pointermove", () => {
            if (!node.__h3qqMentionMenu || node.__h3qqMentionMenu.activeIndex === index) return;
            node.__h3qqMentionMenu.activeIndex = index;
            renderMentionMenu(node);
        });
        item.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            chooseMention(node, option);
        });
        element.append(item);
    });
}

function openMentionMenu(node, editor) {
    if (!isReferenceMode(node)) {
        closeMentionMenu(node);
        return false;
    }
    const mention = getMentionRange(editor);
    if (!mention) {
        closeMentionMenu(node);
        return false;
    }
    const query = mention.query.trim().toLowerCase();
    const all = mentionOptions(node);
    const options = all.filter((option) => !query
        || `${option.label} ${option.fullLabel} ${option.source}`.toLowerCase().includes(query));
    const existing = node.__h3qqMentionMenu;
    if (existing) {
        existing.mention = mention;
        existing.options = options;
        existing.hadMedia = all.length > 0;
        existing.activeIndex = Math.min(existing.activeIndex, Math.max(0, options.length - 1));
        renderMentionMenu(node);
        positionMentionMenu(existing.element, editor);
        return true;
    }
    ensureStyles();
    const element = document.createElement("div");
    element.className = "h3qq-mention-menu";
    document.body.append(element);
    node.__h3qqMentionMenu = { element, mention, options, hadMedia: all.length > 0, activeIndex: 0 };
    renderMentionMenu(node);
    positionMentionMenu(element, editor);
    return true;
}

function syncMentionMenuToCaret(node, editor) {
    if (!isReferenceMode(node)) {
        closeMentionMenu(node);
        return;
    }
    openMentionMenu(node, editor);
}

function chooseMention(node, option) {
    const state = node?.__h3qqMentionMenu;
    const range = state?.mention?.range;
    const editor = node?.__h3qqEditor;
    if (!range || !editor) return;
    range.deleteContents();
    const before = document.createTextNode("​");
    const chip = makeMentionChip(option);
    const after = document.createTextNode("​");
    const fragment = document.createDocumentFragment();
    fragment.append(before, chip, after);
    range.insertNode(fragment);
    const selection = window.getSelection?.();
    if (selection) {
        const caret = document.createRange();
        caret.setStart(after, after.textContent.length);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
    }
    closeMentionMenu(node);
    syncEditorFromNode(node);
    editor.focus();
}

function handleMentionMenuKeydown(node, event) {
    const menu = node.__h3qqMentionMenu;
    if (!menu) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const count = Math.max(1, menu.options.length);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        menu.activeIndex = (menu.activeIndex + delta + count) % count;
        renderMentionMenu(node);
        return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
        if (menu.options.length) {
            chooseMention(node, menu.options[menu.activeIndex]);
        } else {
            closeMentionMenu(node);
        }
        return true;
    }
    if (event.key === "Escape") {
        closeMentionMenu(node);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// DOM widget factory + retry loop
// ---------------------------------------------------------------------------

function removePromptEditorWidgets(node) {
    if (!node?.widgets) return;
    const dom = node.widgets.find((widget) => String(widget?.name || "") === "h3qq_prompt_mentions");
    if (dom && Array.isArray(node.widgets)) {
        const index = node.widgets.indexOf(dom);
        if (index >= 0) node.widgets.splice(index, 1);
    }
    node.__h3qqDomWidget = null;
}

function installPromptEditorFactory(node) {
    if (node.__h3qqEditor) return;
    if (typeof document === "undefined" || typeof node.addDOMWidget !== "function") return;
    const widget = getWidget(node, "text");
    if (!widget) return;
    removePromptEditorWidgets(node);
    ensureStyles();
    hideOriginalTextWidget(widget);

    const wrap = document.createElement("div");
    wrap.className = "h3qq-editor-wrap";
    wrap.style.minHeight = "0px";
    applyNativeEditorTheme(wrap);
    const editor = document.createElement("div");
    editor.className = "comfy-multiline-input h3qq-editor";
    editor.contentEditable = "true";
    editor.spellcheck = true;
    editor.tabIndex = 0;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "text");
    editor.dataset.placeholder = isReferenceMode(node) ? TEXT.mentionTitle : "Prompt text";
    editor.__h3qqPromptNode = node;

    editor.addEventListener("input", (event) => {
        if (event?.isComposing || event?.inputType === "insertCompositionText" || node.__h3qqComposing) return;
        syncEditorFromNode(node);
        syncMentionMenuToCaret(node, editor);
    });
    editor.addEventListener("beforeinput", (event) => {
        if (event?.data === "@" && isReferenceMode(node)) setTimeout(() => syncMentionMenuToCaret(node, editor), 0);
    });
    editor.addEventListener("compositionstart", () => { node.__h3qqComposing = true; });
    editor.addEventListener("compositionend", () => {
        node.__h3qqComposing = false;
        syncEditorFromNode(node);
    });
    editor.addEventListener("focus", () => syncMentionMenuToCaret(node, editor));
    editor.addEventListener("keyup", (event) => {
        if (!isReferenceMode(node) || ["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key)) return;
        syncMentionMenuToCaret(node, editor);
    });
    editor.addEventListener("keydown", (event) => {
        if (handleMentionMenuKeydown(node, event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            const selection = window.getSelection?.();
            if (selection?.rangeCount) {
                const range = selection.getRangeAt(0);
                const br = document.createElement("br");
                const marker = document.createTextNode("​");
                range.deleteContents();
                range.insertNode(br);
                range.insertNode(marker);
                const caret = document.createRange();
                caret.setStart(marker, 1);
                caret.collapse(true);
                selection.removeAllRanges();
                selection.addRange(caret);
            }
            closeMentionMenu(node);
            syncEditorFromNode(node);
            return;
        }
        if (event.key === "Backspace") {
            const selection = window.getSelection?.();
            const chip = selection?.rangeCount
                ? (selection.getRangeAt(0).startContainer.parentElement?.closest?.(`.${CHIP_CLASS}`)
                    || selection.getRangeAt(0).startContainer.closest?.(`.${CHIP_CLASS}`))
                : null;
            if (chip && editor.contains(chip)) {
                chip.remove();
                syncEditorFromNode(node);
                event.preventDefault();
                event.stopPropagation();
            }
        }
    });
    editor.addEventListener("blur", () => {
        syncEditorFromNode(node);
        setTimeout(() => {
            if (!node.__h3qqMentionMenu?.element?.matches?.(":hover")) closeMentionMenu(node);
        }, 160);
    });
    wrap.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        if (!event.target?.closest?.(`.${CHIP_CLASS}`)) closeMentionMenu(node);
    });

    wrap.append(editor);
    node.__h3qqEditor = editor;
    node.__h3qqEditorWrap = wrap;

    const domWidget = node.addDOMWidget("h3qq_prompt_mentions", "h3qq_prompt_mentions", wrap, {
        getValue: () => String(getWidget(node, "text")?.value || ""),
        setValue: (value) => {
            const textWidget = getWidget(node, "text");
            if (textWidget) textWidget.value = String(value || "");
            renderEditorFromNode(node, true);
        },
        margin: 10,
        serialize: false,
        getMinHeight: () => 60,
        afterResize: () => {
            applyNativeEditorTheme(wrap);
            node._widgetSlotsDirty = true;
            node.setDirtyCanvas?.(true, true);
        },
        onDraw: () => applyNativeEditorTheme(wrap),
    });
    if (!domWidget) {
        restoreOriginalTextWidget(widget);
        wrap.remove();
        node.__h3qqEditor = null;
        node.__h3qqEditorWrap = null;
        return;
    }
    node.__h3qqDomWidget = domWidget;
    domWidget.serialize = false;
    setWidgetOption(domWidget, "serialize", false);
    setWidgetOption(domWidget, "canvasOnly", false);
    // A healthy editor means any earlier retry delay has no business carrying
    // over: the next detach must recover fast again, not with a 2 s backoff.
    node.__h3qqHookAttempts = 0;
    installSelfHeal();
    // Keep the editor row directly under the (now hidden) text widget.
    const domIndex = node.widgets?.indexOf(domWidget) ?? -1;
    const textIndex = node.widgets?.indexOf(widget) ?? -1;
    if (domIndex >= 0 && textIndex >= 0 && domIndex !== textIndex + 1) {
        node.widgets.splice(domIndex, 1);
        const nextTextIndex = node.widgets.indexOf(widget);
        node.widgets.splice(nextTextIndex + 1, 0, domWidget);
    }
    renderEditorFromNode(node, true);
}

export function installPromptEditor(node) {
    installPromptEditorFactory(node);
    if (node.__h3qqEditor) return;
    if (node.__h3qqHookAttempts >= 40) return;
    node.__h3qqHookAttempts = (node.__h3qqHookAttempts || 0) + 1;
    node.__h3qqHookRetry = setTimeout(() => installPromptEditor(node), 150);
}
