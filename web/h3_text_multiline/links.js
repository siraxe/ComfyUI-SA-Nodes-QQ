import { app } from "../../../scripts/app.js";
import { NODE_CLASS, LINKS_PROP, MAX_MEDIA, COLOR_IMAGE, COLOR_LINK_BORDER, COMFY_NATIVE_LINK_COLOR, TEXT, isReferenceMode, getWidget } from "./h3_text_multiline.js";

let patchedCanvas = false;
let linkMenu = null;

// ---------------------------------------------------------------------------
// Virtual media link store
// ---------------------------------------------------------------------------

function isSameNode(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const leftId = Number(left.id);
    const rightId = Number(right.id);
    return Number.isFinite(leftId) && Number.isFinite(rightId) && leftId === rightId;
}

export function ensureLinks(node) {
    node.properties ||= {};
    if (!Array.isArray(node.properties[LINKS_PROP])) {
        node.properties[LINKS_PROP] = [];
    }
    return node.properties[LINKS_PROP];
}

export function syncMediaOrderWidget(node) {
    const widget = getWidget(node, "media_order");
    if (!widget) return;
    const value = ensureLinks(node).map((link) => String(link.media_type || "image")).join(",");
    if (String(widget.value ?? "") !== value) widget.value = value;
}

export function hideMediaOrderWidget(node) {
    const widget = getWidget(node, "media_order");
    if (!widget || widget.type === "hidden") return;
    widget.type = "hidden";
    widget.computeLayoutSize = false;
}

function resequence(node) {
    const counts = { image: 0, video: 0, audio: 0 };
    ensureLinks(node).forEach((link) => {
        const mediaType = String(link.media_type || "image").toLowerCase();
        const sequenceType = Object.hasOwn(counts, mediaType) ? mediaType : "image";
        counts[sequenceType] += 1;
        link.order = counts[sequenceType];
    });
    syncMediaOrderWidget(node);
}

export function normalizeLinks(node, removeMissing = true) {
    const links = ensureLinks(node);
    const normalized = [];
    const seen = new Set();
    for (const link of links) {
        const sourceId = Number(link?.source_id);
        const sourceSlot = Number(link?.source_slot) || 0;
        const mediaType = String(link?.media_type || "image").toLowerCase();
        if (!Number.isFinite(sourceId) || !["image", "video", "audio"].includes(mediaType)) continue;
        if (Number.isFinite(Number(node?.id)) && sourceId === Number(node.id)) continue;
        const key = `${sourceId}:${sourceSlot}:${mediaType}`;
        if (seen.has(key)) continue;
        const canResolveSource = typeof app.graph?.getNodeById === "function";
        const source = canResolveSource ? app.graph.getNodeById(sourceId) : null;
        if (removeMissing && canResolveSource && !source) continue;
        seen.add(key);
        normalized.push({ ...link, source_id: sourceId, source_slot: sourceSlot, media_type: mediaType });
    }
    const changed = normalized.length !== links.length || normalized.some((link, index) => {
        const previous = links[index];
        return !previous
            || Number(previous.source_id) !== link.source_id
            || Number(previous.source_slot) !== link.source_slot
            || String(previous.media_type || "image").toLowerCase() !== link.media_type;
    });
    if (changed) node.properties[LINKS_PROP] = normalized;
    else if (links.some((link) => !Number.isFinite(Number(link?.order)))) node.properties[LINKS_PROP] = normalized;
    resequence(node);
    return ensureLinks(node);
}

function getSlotType(slot) {
    return String(slot?.type || slot?.datatype || slot?.label || "").toUpperCase();
}

function getMediaType(sourceType, sourceNode = null) {
    const type = String(sourceType || "").toUpperCase();
    if (type.includes("AUDIO")) return "audio";
    if (type.includes("VIDEO")) return "video";
    if (type.includes("IMAGE")) return "image";
    const name = String(sourceNode?.comfyClass || sourceNode?.type || "").toLowerCase();
    if (name.includes("audio")) return "audio";
    if (name.includes("video")) return "video";
    return "image";
}

function mediaLimits(node) {
    if (!isReferenceMode(node)) {
        return { image: 2, video: 0, audio: 0, total: 2 };
    }
    return { image: 9, video: 3, audio: 3, total: MAX_MEDIA };
}

function canAccept(node, mediaType) {
    const limits = mediaLimits(node);
    if (!limits[mediaType]) return false;
    const links = ensureLinks(node);
    if (links.length >= limits.total) return false;
    const count = links.filter((link) => String(link.media_type || "image") === mediaType).length;
    return count < limits[mediaType];
}

export function pruneLinksForMode(node) {
    const limits = mediaLimits(node);
    const counts = { image: 0, video: 0, audio: 0 };
    const kept = [];
    for (const link of ensureLinks(node)) {
        const type = String(link.media_type || "image");
        if (!limits[type] || counts[type] >= limits[type] || kept.length >= limits.total) continue;
        counts[type] += 1;
        kept.push(link);
    }
    node.properties[LINKS_PROP] = kept;
    resequence(node);
}

export function getMediaInputIndex(node) {
    return node?.inputs?.findIndex((input) => String(input?.name || "") === "media") ?? -1;
}

// ---------------------------------------------------------------------------
// Canvas geometry / interaction
// ---------------------------------------------------------------------------

function getConnectionPosition(node, isInput, slotIndex) {
    const normalize = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
        ? [point[0], point[1]]
        : null;
    const modern = isInput
        ? normalize(node?.getInputPos?.(slotIndex))
        : normalize(node?.getOutputPos?.(slotIndex));
    if (modern) return modern;
    const out = [0, 0];
    try {
        if (typeof node?.getConnectionPos === "function") {
            const legacy = normalize(node.getConnectionPos(isInput, slotIndex, out)) || normalize(out);
            if (legacy) return legacy;
        }
    } catch {
        // Fall through to stable LiteGraph geometry.
    }
    const slot = 40 + Math.max(0, slotIndex) * 20;
    return isInput
        ? [Number(node?.pos?.[0] || 0), Number(node?.pos?.[1] || 0) + slot]
        : [Number(node?.pos?.[0] || 0) + Number(node?.size?.[0] || 160), Number(node?.pos?.[1] || 0) + slot];
}

function getMediaDot(node) {
    const index = getMediaInputIndex(node);
    if (index < 0) return null;
    const point = getConnectionPosition(node, true, index);
    return { x: point[0], y: point[1] };
}

export function graphPosition(canvas, event) {
    try {
        canvas.adjustMouseEvent?.(event);
    } catch {
        // Older LiteGraph builds do not expose adjustMouseEvent.
    }
    if (Array.isArray(canvas?.graph_mouse)) return [canvas.graph_mouse[0], canvas.graph_mouse[1]];
    if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) return [event.canvasX, event.canvasY];
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
        return [(event.clientX - rect.left) / scale - offset[0], (event.clientY - rect.top) / scale - offset[1]];
    }
    return [0, 0];
}

export function clientPosition(canvas, point) {
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    if (!rect) return null;
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    return { x: rect.left + (point[0] + offset[0]) * scale, y: rect.top + (point[1] + offset[1]) * scale };
}

export function connectingOutput(canvas) {
    const node = canvas?.connecting_node || canvas?.connectingNode;
    if (!node) return null;
    const raw = canvas.connecting_output ?? canvas.connecting_slot ?? canvas.connecting_output_slot;
    if (raw == null && canvas.connecting_input) return null;
    const index = typeof raw === "number" ? raw : Number(raw?.slot_index ?? raw?.slot ?? 0);
    const output = node.outputs?.[Number.isFinite(index) ? index : 0] || raw || {};
    return {
        sourceNode: node,
        sourceSlot: Number.isFinite(index) ? index : 0,
        sourceType: getSlotType(output),
    };
}

export function getInputConnection(canvas) {
    const node = canvas?.connecting_node || canvas?.connectingNode;
    const input = canvas?.connecting_input || canvas?.connectingInput;
    if (!node || !input || String(node?.comfyClass || node?.type) !== NODE_CLASS) return null;
    const slot = typeof input === "number" ? node.inputs?.[input] : input;
    if (String(slot?.name || input?.name || "") !== "media") return null;
    return { targetNode: node };
}

export function addVirtualLink(targetNode, sourceNode, sourceSlot, sourceType, mediaType = null) {
    if (!targetNode || !sourceNode || isSameNode(targetNode, sourceNode)) return false;
    const sourceId = Number(sourceNode.id);
    if (!Number.isFinite(sourceId)) return false;
    mediaType ||= getMediaType(sourceType, sourceNode);
    if (!canAccept(targetNode, mediaType)) return false;
    const links = ensureLinks(targetNode);
    const exists = links.some((link) => Number(link.source_id) === sourceId && Number(link.source_slot) === Number(sourceSlot));
    if (exists) return false;
    links.push({
        source_id: sourceId,
        source_slot: Number(sourceSlot) || 0,
        source_type: sourceType || "*",
        media_type: mediaType,
        order: links.length + 1,
    });
    resequence(targetNode);
    targetNode.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
    return true;
}

export function removeVirtualLink(node, index) {
    const links = ensureLinks(node);
    if (index < 0 || index >= links.length) return false;
    links.splice(index, 1);
    resequence(node);
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
    return true;
}

function getNativeGraphLink(graph, linkId) {
    if (!graph || linkId == null) return null;
    for (const links of [graph.links, graph._links]) {
        if (!links) continue;
        if (typeof links.get === "function") {
            const link = links.get(linkId) ?? links.get(String(linkId));
            if (link) return link;
        }
        const link = links[linkId] ?? links[String(linkId)];
        if (link) return link;
    }
    return null;
}

export function convertNativeMediaConnection(targetNode, inputIndex, linkInfo = null) {
    if (String(targetNode?.comfyClass || targetNode?.type) !== NODE_CLASS || targetNode.__h3qqWireClearing) return false;
    const input = targetNode.inputs?.[inputIndex];
    if (!input || !/^media(?:_\d+)?$/i.test(String(input.name || ""))) return false;

    const graph = targetNode.graph || app.graph;
    const linkId = input.link ?? linkInfo?.id ?? linkInfo?.link_id ?? linkInfo?.linkId;
    const nativeLink = getNativeGraphLink(graph, linkId) || linkInfo;
    if (!nativeLink) return false;

    const directSourceCandidate = nativeLink.origin_node || nativeLink.originNode
        || nativeLink.fromNode || nativeLink.sourceNode;
    const directSource = directSourceCandidate && typeof directSourceCandidate === "object"
        ? directSourceCandidate
        : null;
    const sourceId = nativeLink.origin_id ?? nativeLink.originId
        ?? nativeLink.from_id ?? nativeLink.fromId
        ?? (directSourceCandidate && typeof directSourceCandidate !== "object" ? directSourceCandidate : directSource?.id);
    const sourceNode = directSource || graph?.getNodeById?.(Number(sourceId));
    if (!sourceNode || isSameNode(targetNode, sourceNode)) return false;

    const rawSourceSlot = nativeLink.origin_slot ?? nativeLink.originSlot
        ?? nativeLink.from_slot ?? nativeLink.fromSlot ?? nativeLink.from?.slot ?? 0;
    const parsedSourceSlot = Number(rawSourceSlot);
    const sourceSlot = Number.isFinite(parsedSourceSlot) ? parsedSourceSlot : 0;
    const output = sourceNode.outputs?.[sourceSlot] || {};
    const sourceType = getSlotType(output)
        || String(nativeLink.type || nativeLink.origin_type || nativeLink.originType || "*").toUpperCase();

    const added = addVirtualLink(targetNode, sourceNode, sourceSlot, sourceType);
    targetNode.__h3qqWireClearing = true;
    try {
        if (targetNode.inputs?.[inputIndex]?.link != null && typeof targetNode.disconnectInput === "function") {
            targetNode.disconnectInput(inputIndex);
        } else if (linkId != null && typeof graph?.removeLink === "function") {
            graph.removeLink(linkId);
        }
        if (targetNode.inputs?.[inputIndex]) targetNode.inputs[inputIndex].link = null;
    } finally {
        targetNode.__h3qqWireClearing = false;
    }

    targetNode.setDirtyCanvas?.(true, true);
    graph?.setDirtyCanvas?.(true, true);
    return added;
}

export function scheduleNativeMediaConnectionConversion(targetNode, inputIndex, linkInfo = null) {
    setTimeout(() => convertNativeMediaConnection(targetNode, inputIndex, linkInfo), 0);
    if (!linkInfo) setTimeout(() => convertNativeMediaConnection(targetNode, inputIndex), 50);
}

// ---------------------------------------------------------------------------
// Virtual link rendering
// ---------------------------------------------------------------------------

function cubicPoint(start, end, t) {
    const cp1 = [start[0] + 80, start[1]];
    const cp2 = [end[0] - 80, end[1]];
    const mt = 1 - t;
    return [
        mt * mt * mt * start[0] + 3 * mt * mt * t * cp1[0] + 3 * mt * mt * t * cp2[0] + t * t * t * end[0],
        mt * mt * mt * start[1] + 3 * mt * mt * t * cp1[1] + 3 * mt * mt * t * cp2[1] + t * t * t * end[1],
    ];
}

function linkGeometry(targetNode, link) {
    const sourceNode = targetNode.graph?.getNodeById?.(Number(link.source_id));
    const dot = getMediaDot(targetNode);
    if (!sourceNode || !dot) return null;
    const source = getConnectionPosition(sourceNode, false, Number(link.source_slot) || 0);
    const target = [dot.x, dot.y];
    return { sourceNode, source, target, mid: cubicPoint(source, target, 0.5) };
}

function getComfyLinkTypeColor(type) {
    const colors = globalThis.LGraphCanvas?.link_type_colors || {};
    const raw = String(type || "");
    const candidates = [raw, raw.toUpperCase(), raw.toLowerCase()].filter(Boolean);
    for (const candidate of candidates) {
        if (colors[candidate]) return colors[candidate];
    }
    return "";
}

function getComfyDefaultLinkColor(canvas) {
    return canvas?.default_link_color || globalThis.LiteGraph?.LINK_COLOR || COMFY_NATIVE_LINK_COLOR;
}

function linkHighlighted(canvas, targetNode, sourceNode) {
    return Boolean(
        targetNode?.selected || sourceNode?.selected ||
        canvas?.selectedItems?.has?.(targetNode) || canvas?.selectedItems?.has?.(sourceNode) ||
        canvas?.selected_nodes?.[targetNode?.id] || canvas?.selected_nodes?.[sourceNode?.id]
    );
}

function linkColor(canvas, targetNode, sourceNode, link) {
    if (linkHighlighted(canvas, targetNode, sourceNode)) return "#FFF";
    const typedColor = getComfyLinkTypeColor(link?.source_type);
    if (typedColor) return typedColor;
    return String(link?.media_type || "image") === "image" ? COLOR_IMAGE : getComfyDefaultLinkColor(canvas);
}

export function hitTestLinks(graph, x, y) {
    let best = null;
    for (const targetNode of graph?._nodes || []) {
        if (String(targetNode?.comfyClass || targetNode?.type) !== NODE_CLASS) continue;
        const links = ensureLinks(targetNode);
        links.forEach((link, index) => {
            const geometry = linkGeometry(targetNode, link);
            if (!geometry) return;
            const distance = Math.hypot(x - geometry.mid[0], y - geometry.mid[1]);
            if (distance <= 18 && (!best || distance < best.distance)) best = { targetNode, index, point: geometry.mid, distance };
        });
    }
    return best;
}

function closeContextMenuCompat(menu) {
    menu?.close?.();
    menu?.remove?.();
    globalThis.LiteGraph?.ContextMenu?.closeAllContextMenus?.(globalThis.window);
    if (typeof document !== "undefined") {
        document.querySelectorAll(".litecontextmenu").forEach((element) => element.remove());
    }
}

export function closeLinkMenu() {
    linkMenu?.close?.();
    linkMenu?.remove?.();
    linkMenu = null;
}

function openLinkMenu(canvas, hit, event) {
    closeLinkMenu();
    const anchor = clientPosition(canvas, hit.point) || { x: event?.clientX || 0, y: event?.clientY || 0 };
    const menuEvent = typeof PointerEvent === "function"
        ? new PointerEvent("pointerdown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true })
        : new MouseEvent("mousedown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true });
    let menuInstance = null;
    const remove = () => {
        removeVirtualLink(hit.targetNode, hit.index);
        closeContextMenuCompat(menuInstance);
        if (linkMenu === menuInstance) linkMenu = null;
    };
    if (globalThis.LiteGraph?.ContextMenu) {
        menuInstance = new globalThis.LiteGraph.ContextMenu([
            { content: TEXT.deleteLink, callback: remove },
        ], { event: menuEvent });
        linkMenu = menuInstance;
    } else {
        remove();
    }
}

function drawLinks(canvas, ctx) {
    const graph = canvas?.graph || app.graph;
    if (!graph?._nodes || canvas.links_render_mode === globalThis.LiteGraph?.HIDDEN_LINK) return;
    for (const targetNode of graph._nodes) {
        if (String(targetNode?.comfyClass || targetNode?.type) !== NODE_CLASS) continue;
        for (const link of ensureLinks(targetNode)) {
            const geometry = linkGeometry(targetNode, link);
            if (!geometry) continue;
            const highlighted = linkHighlighted(canvas, targetNode, geometry.sourceNode);
            const color = linkColor(canvas, targetNode, geometry.sourceNode, link);
            const width = canvas.connections_width || 3;
            ctx.save();
            ctx.lineJoin = "round";
            ctx.shadowBlur = 0;
            ctx.shadowColor = "transparent";
            ctx.beginPath();
            ctx.moveTo(geometry.source[0], geometry.source[1]);
            ctx.bezierCurveTo(geometry.source[0] + 80, geometry.source[1], geometry.target[0] - 80, geometry.target[1], geometry.target[0], geometry.target[1]);
            ctx.lineWidth = width + 4;
            ctx.strokeStyle = canvas.render_connections_border !== false && !canvas.low_quality ? COLOR_LINK_BORDER : "transparent";
            if (ctx.strokeStyle !== "transparent") ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(geometry.source[0], geometry.source[1]);
            ctx.bezierCurveTo(geometry.source[0] + 80, geometry.source[1], geometry.target[0] - 80, geometry.target[1], geometry.target[0], geometry.target[1]);
            ctx.lineWidth = width;
            ctx.strokeStyle = color;
            ctx.stroke();
            if (canvas.linkMarkerShape !== 0 && (canvas.ds?.scale ?? 1) >= 0.6 && canvas.highquality_render !== false) {
                ctx.beginPath();
                ctx.arc(geometry.mid[0], geometry.mid[1], 5, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.fillStyle = highlighted ? "#222" : "#fff";
                ctx.font = "bold 7px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(link.order || 1), geometry.mid[0], geometry.mid[1] + 0.3);
            }
            ctx.restore();
        }
    }
}

export function patchCanvas() {
    const canvas = app.canvas;
    if (!canvas || canvas.__h3qqCanvasPatched || typeof canvas.drawConnections !== "function") return;
    canvas.__h3qqCanvasPatched = true;
    patchedCanvas = true;
    const originalDraw = canvas.drawConnections;
    canvas.drawConnections = function drawConnectionsWithH3QQLinks(ctx) {
        const result = originalDraw?.apply(this, arguments);
        const connectionContext = ctx || this.bgctx || this.ctx;
        const onConnectionLayer = connectionContext?.canvas === this?.bgcanvas || connectionContext === this?.bgctx || !this?.bgcanvas;
        if (connectionContext && onConnectionLayer) drawLinks(this, connectionContext);
        return result;
    };

    const originalDown = canvas.processMouseDown;
    canvas.processMouseDown = function processMouseDownWithH3QQLinks(event) {
        if (!getInputConnection(this)) {
            const [x, y] = graphPosition(this, event);
            const hit = hitTestLinks(this.graph || app.graph, x, y);
            if (hit) {
                openLinkMenu(this, hit, event);
                event?.preventDefault?.();
                event?.stopImmediatePropagation?.();
                return true;
            }
        }
        return originalDown?.apply(this, arguments);
    };

    const linkPointerHandler = (event) => {
        if (connectingOutput(canvas) || getInputConnection(canvas)) return;
        const [x, y] = graphPosition(canvas, event);
        const hit = hitTestLinks(canvas.graph || app.graph, x, y);
        if (!hit) return;
        openLinkMenu(canvas, hit, event);
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
    };
    canvas.canvas?.addEventListener?.("pointerdown", linkPointerHandler, true);
}
