/**
 * Power Image Grid - frontend
 *
 * Displays the images piped into its input almost exactly like the default
 * "Preview Image" node does for multiple images: a plain DOM grid of <img>
 * elements, nothing else. No toolbar, no top row, no buttons beyond the
 * per-image crop toggle.
 *
 * Layout: node size + image count determine rows/columns (largest uniform
 * cell that fits wins, aspect from the FIRST image); resizing the node
 * re-wraps the grid.
 *
 * Each image gets a small scissors button in its top-right corner that
 * toggles an interactive crop box for THAT image only (drag body to move,
 * corner handles to resize - same interaction as Power Load Video's box
 * crop). Crop values are stored as normalized {enabled, x, y, w, h} (center
 * + size) in the hidden `crop_json` STRING widget the backend parses on
 * execute. The backend returns UNCROPPED previews, so crop boxes stay live.
 */

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';

const GAP = 4;              // px gap between grid cells
const BTN_W = 24;           // crop button size (per cell, top-right corner)
const BTN_H = 18;
const HANDLE = 10;          // crop corner-handle hit radius
const MIN_CELL = 320;       // minimum cell size - cells scale up with the node
const WIDGET_AREA = 110;    // fallback offset above the grid before first draw
const GRID_MIN_H = 160;     // widget's DECLARED height (fixed, never derived
                            // from node size: litegraph enforces node min
                            // height = sum of widget heights, so a size-derived
                            // value would lock the node and block shrinking)

function defaultCrop() {
    return { enabled: false, x: 0.5, y: 0.5, w: 1.0, h: 1.0 };
}

app.registerExtension({
    name: 'PowerImageGrid',

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== 'PowerImageGrid') return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = originalOnNodeCreated?.apply(this, arguments);
            const node = this;

            // Guard against double initialization - a second (empty) container
            // would stack on top and paint a black sheet over the images
            if (node.gridWidget) return r;

            node.gridMeta = [];     // { w, h } natural image sizes
            node.gridCrops = [];    // per-image crop state (serialized via crop_json)
            node.cellEls = [];      // per-image cell DOM elements

            if (node.size[0] < 320) node.size[0] = 320;
            if (node.size[1] < 240) node.size[1] = 240;

            // === DOM widget: plain image grid (Preview Image style) ===
            const container = document.createElement('div');
            container.style.cssText =
                'width:100%;height:' + GRID_MIN_H + 'px;background:transparent;' +
                'position:relative;overflow:hidden;box-sizing:border-box;';
            const grid = document.createElement('div');
            grid.style.cssText = [
                'width:100%', 'height:100%',
                'display:grid',
                `gap:${GAP}px`,
                'overflow:hidden',
                'box-sizing:border-box',
                'padding:2px',
            ].join(';');
            container.appendChild(grid);
            node.gridEl = grid;

            node.gridWidget = node.addDOMWidget('grid', 'GridDisplay', container, {
                serialize: false,
                hideOnZoom: false,
            });
            // FIXED declared height: keeps litegraph's node-min-size constant
            // so the node can always be freely resized in both directions.
            node.gridWidget.computeSize = () => [node.size[0], GRID_MIN_H];

            // Keep the element's real height synced to the actual node height
            // (called from onResize AND onDrawBackground, so it converges no
            // matter what changed the size). The grid always fills the node.
            node.syncGridSize = () => {
                const offset = node.gridWidget.last_y || WIDGET_AREA;
                const h = Math.max(GRID_MIN_H, Math.min(4096, node.size[1] - offset - 2));
                if (Math.abs((node._lastGridH || 0) - h) > 0.5) {
                    node._lastGridH = h;
                    container.style.height = h + 'px';
                    requestAnimationFrame(() => node.layoutGrid());
                }
            };
            node.syncGridSize();

            // Hide the crop_json widget (backend serialization only)
            setTimeout(() => {
                const w = node.widgets?.find((w) => w.name === 'crop_json');
                if (w) {
                    w.computeSize = () => [0, 0];
                    w.hidden = true;
                    if (typeof w.value !== 'string' || !w.value.trim()) w.value = '[]';
                }
            }, 0);

            // === crop state helpers ===
            node.ensureCrops = (n) => {
                while (node.gridCrops.length < n) node.gridCrops.push(defaultCrop());
            };

            node.syncCropsToWidget = () => {
                const w = node.widgets?.find((w) => w.name === 'crop_json');
                if (w) {
                    w.value = JSON.stringify(
                        node.gridCrops.map((c) => ({
                            enabled: !!c.enabled, x: c.x, y: c.y, w: c.w, h: c.h,
                        }))
                    );
                }
            };

            // Fit an image fully inside a cell rect preserving aspect
            // (CSS object-fit: contain) - nothing gets cropped away, so wide
            // (2:1) and tall (1:2) images both stay fully visible. Crop-box
            // coordinates map onto this rect.
            node.coverRect = (cw, ch, meta) => {
                if (!meta || !meta.w || !meta.h) return { x: 0, y: 0, w: cw, h: ch };
                const s = Math.min(cw / meta.w, ch / meta.h);
                const dw = meta.w * s;
                const dh = meta.h * s;
                return { x: (cw - dw) / 2, y: (ch - dh) / 2, w: dw, h: dh };
            };

            // === CELL CONSTRUCTION ===
            node.buildCells = (n) => {
                grid.innerHTML = '';
                node.cellEls = [];
                node.ensureCrops(n);
                for (let i = 0; i < n; i++) {
                    const cell = document.createElement('div');
                    cell.style.cssText =
                        'position:relative;background:#161616;border:1px solid #333;' +
                        'overflow:hidden;box-sizing:border-box;';

                    const img = document.createElement('img');
                    img.style.cssText =
                        'width:100%;height:100%;display:block;object-fit:contain;' +
                        'pointer-events:none;background:#111;';
                    cell.appendChild(img);

                    // Crop overlay canvas (only visible while crop is active)
                    const cv = document.createElement('canvas');
                    cv.style.cssText =
                        'position:absolute;left:0;top:0;width:100%;height:100%;display:none;';
                    cell.appendChild(cv);

                    // Crop toggle button (top-right corner)
                    const btn = document.createElement('button');
                    btn.textContent = '✂';
                    btn.title = 'Toggle crop for this image';
                    btn.style.cssText = [
                        'position:absolute', `right:4px`, 'top:4px',
                        `width:${BTN_W}px`, `height:${BTN_H}px`,
                        'padding:0', 'line-height:1', 'font-size:12px',
                        'background:rgba(30,30,30,0.85)', 'color:#ccc',
                        'border:1px solid #555', 'border-radius:3px',
                        'cursor:pointer', 'z-index:3',
                    ].join(';');
                    btn.addEventListener('mousedown', (e) => e.stopPropagation());
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        node.gridCrops[i].enabled = !node.gridCrops[i].enabled;
                        btn.style.background = node.gridCrops[i].enabled
                            ? 'rgba(0,255,100,0.2)' : 'rgba(30,30,30,0.85)';
                        btn.style.color = node.gridCrops[i].enabled ? '#00ff64' : '#ccc';
                        btn.style.borderColor = node.gridCrops[i].enabled ? '#00ff64' : '#555';
                        cv.style.display = node.gridCrops[i].enabled ? 'block' : 'none';
                        if (node.gridCrops[i].enabled) node.drawCropOverlay(i);
                        node.syncCropsToWidget();
                    });
                    cell.appendChild(btn);

                    // Crop box drag interaction on the overlay canvas
                    cv.addEventListener('mousedown', (e) => node.cropMouseDown(e, i));

                    // Cursor feedback over crop handles / box
                    cv.addEventListener('mousemove', (e) => {
                        const c = node.gridCrops[i];
                        if (!c || !c.enabled) { cv.style.cursor = 'default'; return; }
                        const r = cv.getBoundingClientRect();
                        const mx = e.clientX - r.left, my = e.clientY - r.top;
                        const ir = node.coverRect(cell.clientWidth, cell.clientHeight, node.gridMeta[i]);
                        const cx = ir.x + c.x * ir.w;
                        const cy = ir.y + c.y * ir.h;
                        const hw = (c.w * ir.w) / 2;
                        const hh = (c.h * ir.h) / 2;
                        const near = (x, y) => Math.hypot(mx - x, my - y) <= HANDLE;
                        let cursor = 'default';
                        if (near(cx - hw, cy - hh)) cursor = 'nw-resize';
                        else if (near(cx + hw, cy - hh)) cursor = 'ne-resize';
                        else if (near(cx + hw, cy + hh)) cursor = 'se-resize';
                        else if (near(cx - hw, cy + hh)) cursor = 'sw-resize';
                        else if (mx >= cx - hw && mx <= cx + hw && my >= cy - hh && my <= cy + hh) cursor = 'move';
                        cv.style.cursor = cursor;
                    });
                    cv.addEventListener('mouseleave', () => { cv.style.cursor = 'default'; });

                    grid.appendChild(cell);
                    node.cellEls.push({ cell, img, cv, btn });
                }
            };

            // === CROP OVERLAY (same math as Power Load Video's BoxCropWidget) ===
            node.drawCropOverlay = (i) => {
                const entry = node.cellEls[i];
                if (!entry) return;
                const cv = entry.cv;
                const cw = entry.cell.clientWidth;
                const chh = entry.cell.clientHeight;
                if (cv.width !== Math.round(cw) || cv.height !== Math.round(chh)) {
                    cv.width = Math.round(cw);
                    cv.height = Math.round(chh);
                }
                const ctx = cv.getContext('2d');
                ctx.clearRect(0, 0, cw, chh);

                const c = node.gridCrops[i];
                if (!c || !c.enabled) return;
                const ir = node.coverRect(cw, chh, node.gridMeta[i]);
                const cx = ir.x + c.x * ir.w;
                const cy = ir.y + c.y * ir.h;
                const hw = (c.w * ir.w) / 2;
                const hh = (c.h * ir.h) / 2;

                ctx.fillStyle = 'rgba(0, 255, 100, 0.25)';
                ctx.strokeStyle = '#00ff64';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.rect(cx - hw, cy - hh, hw * 2, hh * 2);
                ctx.fill();
                ctx.stroke();

                const handleSize = 8;
                const corners = [
                    [cx - hw, cy - hh],
                    [cx + hw, cy - hh],
                    [cx + hw, cy + hh],
                    [cx - hw, cy + hh],
                ];
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                corners.forEach(([hx, hy]) => {
                    ctx.beginPath();
                    ctx.rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                    ctx.fill();
                    ctx.stroke();
                });

                ctx.beginPath();
                ctx.arc(cx, cy, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
                ctx.strokeStyle = '#000';
                ctx.stroke();
            };

            node.cropMouseDown = (e, i) => {
                const c = node.gridCrops[i];
                if (!c || !c.enabled) return;
                e.preventDefault();
                e.stopPropagation();

                const entry = node.cellEls[i];
                const rect = entry.cv.getBoundingClientRect();
                const toLocal = (ev) => [
                    ev.clientX - rect.left,
                    ev.clientY - rect.top,
                ];
                const [sx, sy] = toLocal(e);
                const ir = node.coverRect(entry.cell.clientWidth, entry.cell.clientHeight, node.gridMeta[i]);
                const cx = ir.x + c.x * ir.w;
                const cy = ir.y + c.y * ir.h;
                const hw = (c.w * ir.w) / 2;
                const hh = (c.h * ir.h) / 2;

                // Corner hit first, then body
                const corners = [
                    { name: 'tl', x: cx - hw, y: cy - hh },
                    { name: 'tr', x: cx + hw, y: cy - hh },
                    { name: 'br', x: cx + hw, y: cy + hh },
                    { name: 'bl', x: cx - hw, y: cy + hh },
                ];
                let hitCorner = null;
                for (const cor of corners) {
                    if (Math.hypot(sx - cor.x, sy - cor.y) <= HANDLE) { hitCorner = cor.name; break; }
                }
                const inside = sx >= cx - hw && sx <= cx + hw && sy >= cy - hh && sy <= cy + hh;
                if (!hitCorner && !inside) return;

                const drag = { corner: hitCorner, start: { x: sx, y: sy }, init: { ...c } };

                const onMove = (ev) => {
                    const [mx, my] = toLocal(ev);
                    if (ir.w <= 0 || ir.h <= 0) return;
                    const toNorm = (px, py) => [(px - ir.x) / ir.w, (py - ir.y) / ir.h];
                    if (!hitCorner) {
                        // move
                        const [nx0, ny0] = toNorm(drag.start.x, drag.start.y);
                        const [nx1, ny1] = toNorm(mx, my);
                        c.x = Math.max(c.w / 2, Math.min(1 - c.w / 2, drag.init.x + (nx1 - nx0)));
                        c.y = Math.max(c.h / 2, Math.min(1 - c.h / 2, drag.init.y + (ny1 - ny0)));
                    } else {
                        // resize, opposite corner fixed
                        const iv = drag.init;
                        const ocx = ir.x + iv.x * ir.w;
                        const ocy = ir.y + iv.y * ir.h;
                        const ohw = (iv.w * ir.w) / 2;
                        const ohh = (iv.h * ir.h) / 2;
                        let ox, oy;
                        switch (hitCorner) {
                            case 'tl': ox = ocx + ohw; oy = ocy + ohh; break;
                            case 'tr': ox = ocx - ohw; oy = ocy + ohh; break;
                            case 'br': ox = ocx - ohw; oy = ocy - ohh; break;
                            case 'bl': ox = ocx + ohw; oy = ocy - ohh; break;
                        }
                        const px = Math.max(ir.x, Math.min(ir.x + ir.w, mx));
                        const py = Math.max(ir.y, Math.min(ir.y + ir.h, my));
                        c.x = ((ox + px) / 2 - ir.x) / ir.w;
                        c.y = ((oy + py) / 2 - ir.y) / ir.h;
                        c.w = Math.max(0.05, Math.min(1, Math.abs(px - ox) / ir.w));
                        c.h = Math.max(0.05, Math.min(1, Math.abs(py - oy) / ir.h));
                    }
                    node.drawCropOverlay(i);
                };
                const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    node.syncCropsToWidget();
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            };

            // === LAYOUT (node size + image count -> rows/columns) ===
            // Explicit CSS grid template (no flex re-wrapping -> no jitter):
            // cells fill the node and scale smoothly with it, never smaller
            // than MIN_CELL. Node is 640+ tall -> second row appears, etc.
            node.layoutGrid = () => {
                const n = node.cellEls.length;
                if (n === 0) {
                    grid.style.gridTemplateColumns = '';
                    grid.style.gridTemplateRows = '';
                    return;
                }
                const availW = Math.max(MIN_CELL, grid.clientWidth - 4);
                const availH = Math.max(MIN_CELL, grid.clientHeight - 4);

                // How many 320px cells fit per axis (at least 1 each)
                let cols = Math.max(1, Math.floor(availW / MIN_CELL));
                let rows = Math.max(1, Math.floor(availH / MIN_CELL));

                // More images than cells: add columns/rows on whichever axis
                // still has more space, until every image has a cell
                while (cols * rows < n) {
                    if (availW / cols >= availH / rows) cols++;
                    else rows++;
                }

                grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
                grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

                node.cellEls.forEach((entry, i) => {
                    if (node.gridCrops[i]?.enabled) node.drawCropOverlay(i);
                });
            };

            // Node resized -> just re-sync the element height (syncGridSize
            // only re-lays-out when the height actually changed, so auto-fit
            // echoes are harmless). The declared widget height is FIXED, so
            // litegraph's node minimum size never blocks shrinking.
            const originalOnResize = node.onResize;
            node.onResize = function (size) {
                originalOnResize?.apply(this, arguments);
                node.syncGridSize();
            };

            // === Receive previews from the backend ===
            // Uses the custom "grid_images" ui key: the frontend natively
            // renders any "images" key for output nodes (drawn under the node),
            // which would duplicate our grid.
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                originalOnExecuted?.apply(this, arguments);
                const imgs = message?.grid_images;
                if (!Array.isArray(imgs) || imgs.length === 0) return;

                const total = imgs.length;
                if (node.cellEls.length !== total) node.buildCells(total);
                node.ensureCrops(total);

                let loaded = 0;
                // Cache-buster: the backend reuses the same preview filenames
                // every run, so without this the browser would keep showing
                // the cached (previous-run) images and never fire onload.
                const bust = Date.now();
                imgs.forEach((info, i) => {
                    const url = api.apiURL(
                        `/view?filename=${encodeURIComponent(info.filename)}` +
                        `&subfolder=${encodeURIComponent(info.subfolder || '')}` +
                        `&type=${encodeURIComponent(info.type || 'temp')}` +
                        `&pigrid_run=${bust}_${i}`
                    );
                    const entry = node.cellEls[i];
                    const im = entry.img;
                    im.onload = () => {
                        node.gridMeta[i] = { w: im.naturalWidth, h: im.naturalHeight };
                        // Restore per-cell crop button state
                        const active = node.gridCrops[i]?.enabled;
                        entry.cv.style.display = active ? 'block' : 'none';
                        entry.btn.style.background = active ? 'rgba(0,255,100,0.2)' : 'rgba(30,30,30,0.85)';
                        entry.btn.style.color = active ? '#00ff64' : '#ccc';
                        entry.btn.style.borderColor = active ? '#00ff64' : '#555';
                        if (active) node.drawCropOverlay(i);
                        if (++loaded === total) node.layoutGrid();
                    };
                    im.onerror = () => {
                        if (++loaded === total) node.layoutGrid();
                    };
                    im.src = url;
                });
            };

            // === Restore crops from the saved workflow ===
            const originalOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                originalOnConfigure?.apply(this, arguments);
                const w = node.widgets?.find((w) => w.name === 'crop_json');
                if (w && typeof w.value === 'string') {
                    try {
                        const arr = JSON.parse(w.value);
                        if (Array.isArray(arr)) {
                            node.gridCrops = arr.map((c) => ({
                                enabled: !!(c && c.enabled),
                                x: Math.min(1, Math.max(0, +(c?.x ?? 0.5) || 0.5)),
                                y: Math.min(1, Math.max(0, +(c?.y ?? 0.5) || 0.5)),
                                w: Math.min(1, Math.max(0.05, +(c?.w ?? 1) || 1)),
                                h: Math.min(1, Math.max(0.05, +(c?.h ?? 1) || 1)),
                            }));
                        }
                    } catch (err) { /* keep defaults */ }
                }
            };

            // Keep the element height in sync on every redraw as well (covers
            // size changes that don't fire onResize, e.g. workflow load).
            // Done once at prototype level in beforeRegisterNodeDef (below).

            return r;
        };

        // Keep the element height in sync on every redraw (covers size changes
        // that don't fire onResize, e.g. workflow load). Wrapped ONCE at
        // prototype level; syncGridSize is per-instance and change-guarded.
        const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function () {
            originalOnDrawBackground?.apply(this, arguments);
            this.syncGridSize?.();
        };
    },
});
