/**
 * Dataset Pair Save - frontend
 *
 * Displays the "before" and "after" images returned by the backend side by
 * side, and provides a Save button below them. Pressing Save asks
 * /sa_dataset/save to copy the currently previewed pair into the dataset
 * folder. Nothing is written to the output directory during graph execution.
 *
 * The backend sends its previews under the custom "dataset_images" UI key
 * (not "images") so the native output-node preview does not also draw them
 * below the node.
 */

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';

const NODE_NAME = 'DatasetPairSave';
const PANEL_MIN_H = 260;      // declared widget height
const FALLBACK_OFFSET = 130;  // widget y offset before the first layout pass

function makePane(label) {
    const pane = document.createElement('div');
    pane.style.cssText = [
        'position:relative', 'flex:1 1 0', 'min-width:0', 'min-height:0',
        'background:#111', 'border:1px solid #333', 'border-radius:4px',
        'overflow:hidden',
    ].join(';');

    const tag = document.createElement('div');
    tag.textContent = label;
    tag.style.cssText = [
        'position:absolute', 'left:6px', 'top:6px', 'z-index:1',
        'padding:1px 6px', 'font-size:11px', 'color:#ddd',
        'background:rgba(0,0,0,0.65)', 'border:1px solid #444',
        'border-radius:3px', 'pointer-events:none',
    ].join(';');
    pane.appendChild(tag);

    const placeholder = document.createElement('span');
    placeholder.textContent = 'no image yet';
    placeholder.style.cssText = [
        'position:absolute', 'left:50%', 'top:50%',
        'transform:translate(-50%,-50%)',
        'color:#555', 'font-size:12px', 'pointer-events:none',
    ].join(';');
    pane.appendChild(placeholder);

    const img = document.createElement('img');
    img.style.cssText = [
        'position:absolute', 'inset:0', 'width:100%', 'height:100%',
        'object-fit:contain', 'display:none', 'background:#0c0c0c',
    ].join(';');
    pane.appendChild(img);

    return { pane, img, placeholder };
}

app.registerExtension({
    name: 'SADatasetPairSave',

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = originalOnNodeCreated?.apply(this, arguments);
            const node = this;

            if (node._datasetPairUI) return r;
            node._datasetPairUI = true;
            node.datasetPair = null;

            if (node.size[0] < 520) node.size[0] = 520;
            if (node.size[1] < 520) node.size[1] = 520;

            // === DOM: two preview panes + Save row ===
            const root = document.createElement('div');
            root.style.cssText = [
                'display:flex', 'flex-direction:column', 'gap:6px',
                'width:100%', `height:${PANEL_MIN_H}px`,
                'box-sizing:border-box', 'padding:4px',
            ].join(';');

            const previews = document.createElement('div');
            previews.style.cssText = 'display:flex;gap:6px;flex:1 1 auto;min-height:0;';

            const beforePane = makePane('Before (control)');
            const afterPane = makePane('After (main)');
            previews.append(beforePane.pane, afterPane.pane);

            const footer = document.createElement('div');
            footer.style.cssText = 'display:flex;gap:8px;align-items:center;flex:0 0 auto;';

            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save';
            saveBtn.title = 'Save the current before/after pair to the dataset folder';
            saveBtn.disabled = true;
            saveBtn.style.cssText = [
                'min-width:84px', 'padding:4px 12px', 'cursor:pointer',
                'background:#2a5a2a', 'color:#e8ffe8', 'border:1px solid #4a8a4a',
                'border-radius:4px', 'font-size:12px',
            ].join(';');

            const status = document.createElement('div');
            status.textContent = 'Queue the graph to preview a pair, then press Save.';
            status.style.cssText = [
                'flex:1 1 auto', 'min-width:0', 'color:#999', 'font-size:11px',
                'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
            ].join(';');

            footer.append(saveBtn, status);
            root.append(previews, footer);

            node.datasetWidget = node.addDOMWidget('dataset_preview', 'DatasetPreview', root, {
                serialize: false,
                hideOnZoom: false,
            });
            // Fixed declared height keeps litegraph's minimum node size stable;
            // the actual element is stretched in syncDatasetPanel().
            node.datasetWidget.computeSize = () => [node.size[0], PANEL_MIN_H];

            node.beforePreview = beforePane;
            node.afterPreview = afterPane;
            node.datasetStatusEl = status;
            node.datasetSaveBtn = saveBtn;

            node.setDatasetStatus = (text, kind) => {
                status.textContent = text;
                status.title = text;
                status.style.color = kind === 'error' ? '#ff6b6b'
                    : kind === 'success' ? '#57d977' : '#999';
            };

            node.setDatasetPreview = (pane, info, bust) => {
                if (!pane || !info?.filename) return;
                const url = api.apiURL(
                    `/view?filename=${encodeURIComponent(info.filename)}` +
                    `&subfolder=${encodeURIComponent(info.subfolder || '')}` +
                    `&type=${encodeURIComponent(info.type || 'temp')}` +
                    `&sa_dataset_run=${bust}`
                );
                pane.img.onload = () => {
                    pane.img.style.display = 'block';
                    pane.placeholder.style.display = 'none';
                };
                pane.img.onerror = () => {
                    pane.img.style.display = 'none';
                    pane.placeholder.style.display = '';
                    pane.placeholder.textContent = 'preview failed to load';
                };
                pane.img.src = url;
            };

            // Let the preview area follow the node height.
            node.syncDatasetPanel = () => {
                const offset = node.datasetWidget?.last_y || FALLBACK_OFFSET;
                const h = Math.max(PANEL_MIN_H, Math.min(4096, node.size[1] - offset - 2));
                if (Math.abs((node._lastDatasetPanelH || 0) - h) > 0.5) {
                    node._lastDatasetPanelH = h;
                    root.style.height = `${h}px`;
                }
            };
            const originalOnResize = node.onResize;
            node.onResize = function (size) {
                originalOnResize?.apply(this, arguments);
                node.syncDatasetPanel();
            };
            node.syncDatasetPanel();

            // === Save button ===
            const widgetValue = (name) => {
                const w = node.widgets?.find((widget) => widget.name === name);
                return w?.value ?? '';
            };

            saveBtn.addEventListener('click', async () => {
                const pair = node.datasetPair;
                if (!pair?.before?.filename || !pair?.after?.filename) {
                    node.setDatasetStatus('Nothing to save - queue the graph first.', 'error');
                    return;
                }

                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';
                node.setDatasetStatus('Saving pair...');

                try {
                    const resp = await api.fetchApi('/sa_dataset/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            directory: widgetValue('directory'),
                            subdir: widgetValue('subdir'),
                            name: widgetValue('name'),
                            before: pair.before,
                            after: pair.after,
                        }),
                    });

                    let data = {};
                    try { data = await resp.json(); } catch (e) { /* no body */ }
                    if (!resp.ok || !data.success) {
                        throw new Error(data.error || `HTTP ${resp.status}`);
                    }

                    node.setDatasetStatus(
                        `Saved ${data.name}  ->  ${data.after}  +  ${data.before}`,
                        'success'
                    );
                } catch (err) {
                    node.setDatasetStatus(`Save failed: ${err?.message || err}`, 'error');
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
            });

            return r;
        };

        // === Previews from the backend ===
        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            originalOnExecuted?.apply(this, arguments);

            const imgs = message?.dataset_images;
            if (!Array.isArray(imgs) || imgs.length < 2) return;

            const before = imgs.find((i) => i?.role === 'before') || imgs[0];
            const after = imgs.find((i) => i?.role === 'after') || imgs[1];
            if (!before?.filename || !after?.filename) return;

            this.datasetPair = { before, after };
            const bust = Date.now();
            this.setDatasetPreview?.(this.beforePreview, before, `${bust}_b`);
            this.setDatasetPreview?.(this.afterPreview, after, `${bust}_a`);
            if (this.datasetSaveBtn) this.datasetSaveBtn.disabled = false;
            this.setDatasetStatus?.('Pair previewed. Press Save to write it to the dataset.');
        };

        // Keep the panel height in sync on every redraw (size changes that
        // don't fire onResize, e.g. workflow load).
        const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function () {
            originalOnDrawBackground?.apply(this, arguments);
            this.syncDatasetPanel?.();
        };
    },
});
