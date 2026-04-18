/**
 * Power Image Crop — Main Extension
 *
 * Simple image crop node with:
 *  - one image input + output
 *  - Refresh button to load connected image onto canvas
 *  - Crop toggle button (shows/hides draggable overlay box)
 *  - Keep AR checkbox (default true)
 *  - width / height number controls
 */
import { app } from '../../../scripts/app.js';
import { PowerCropTopRowWidget } from './top_row.js';
import { CropOverlayWidget }     from './crop_overlay.js';
import { CropCanvas }            from './crop_canvas.js';
import { chainCallback }         from '../power_spline_editor/general_utils.js';

app.registerExtension({
  name: 'PowerImageCrop',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== 'PowerImageCrop') return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

    chainCallback(nodeType.prototype, 'onNodeCreated', function () {
      this.serialize_widgets = true;

      // Enforce minimum width so the row fits comfortably
      if (this.size[0] < 620) this.size[0] = 620;

      // ---- Polyfill addCustomWidget (same pattern as PowerLoadVideo) ----
      if (!this.addCustomWidget) {
        this.addCustomWidget = function (widget) {
          widget.parent = this;
          this.widgets = this.widgets || [];
          this.widgets.push(widget);

          const origMouse = widget.mouse;
          widget.mouse = function (event, pos, node) {
            const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
            return origMouse?.call(this, event, localPos, node);
          };
        };
      }

      // ---- Create DOM container for image display ----
      const container = document.createElement('div');
      container.style.cssText = `
        width: 100%; height: 380px; background-color: #000; position: relative;
        overflow: hidden; display: flex; align-items: center; justify-content: center;
      `;

      const placeholder = document.createElement('div');
      placeholder.id = `power-crop-placeholder-${this.id}`;
      placeholder.textContent = 'Connect an image and press Refresh';
      placeholder.style.cssText = `
        color: #888; font-size: 14px; pointer-events: none; user-select: none;
        position: absolute; text-align: center; width: 100%; top: 50%; transform: translateY(-50%);
      `;

      const displayCanvas = document.createElement('canvas');
      displayCanvas.setAttribute('willReadFrequently', 'true');
      displayCanvas.style.cssText = `
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        display: block; background: #000; z-index: 1;
      `;

      // Placeholder behind the canvas (lower z-index)
      placeholder.style.zIndex = '0';
      container.appendChild(placeholder);
      container.appendChild(displayCanvas);

      this.displayCanvas = displayCanvas;
      // Set initial pixel dimensions to match container so canvas isn't tiny 300x150 default
      displayCanvas.width  = 620;
      displayCanvas.height = 380;
      this.cropCanvas    = new CropCanvas(displayCanvas);
      this.imageWidth    = 0;
      this.imageHeight   = 0;
      this._imageElement = null;       // cached Image element for redraws

      // Keep canvas pixel buffer in sync with display size (avoids stretching on node resize)
      const ro = new ResizeObserver(() => {
        const rect = container.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w > 0 && h > 0) {
          this.cropCanvas.setSize(w, h);
          this.cropWidget.redraw(this);
        }
      });
      ro.observe(container);

      // ---- Register custom widgets in order ----

      // 1. Top row widget (Refresh | Crop | AR | width/height)
      if (!this.topRowWidget) {
        this.topRowWidget = new PowerCropTopRowWidget();
        this.addCustomWidget(this.topRowWidget);
      }

      // 2. Hidden crop overlay widget (draws on displayCanvas, no row height)
      if (!this.cropWidget) {
        this.cropWidget = new CropOverlayWidget();
        this.addCustomWidget(this.cropWidget);
      }

      // 3. Display canvas as DOM widget
      const nodeRef = this;  // capture reference to the node for arrow functions
      this.displayWidget = this.addDOMWidget(nodeData.name, 'ImageDisplay', container, {
        serialize: false,
        hideOnZoom: false,
      });
      this.displayWidget.computeSize = () => [nodeRef.size[0], 380];

      // ---- Hide backend widgets from UI (keep them for serialization only) ----
      setTimeout(() => {
        const hideNames = ['mask_width', 'mask_height', 'keep_ar', 'crop_x', 'crop_y', 'crop_width', 'crop_height'];
        for (const name of hideNames) {
          const w = nodeRef.widgets?.find(wg => wg.name === name);
          if (w) {
            w.computeSize = () => [0, 0];
            w.hidden = true;
          }
        }
      }, 0);

      // ---- Wire up crop mouse interaction on the display canvas ----
      displayCanvas.addEventListener('mousedown', (e) => {
        if (!this.cropWidget?.value?.visible) return;
        if (!this.cropCanvas?.originalImageWidth) return;
        if (this.cropWidget.handleCanvasMouse(e, this)) {
          e.stopPropagation();
          e.preventDefault();
          const onMove = (ev) => this.cropWidget.handleCanvasMouse(ev, this);
          const onUp   = (ev) => {
            this.cropWidget.handleCanvasMouse(ev, this);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }
      });

      // Cursor changes when hovering crop box handles
      displayCanvas.addEventListener('mousemove', (e) => {
        if (!this.cropWidget?.value?.visible || this.cropWidget.isDragging) return;
        const cc = this.cropCanvas;
        if (!cc?.originalImageWidth) return;

        const coords = cc.getCanvasCoords(e);
        const n = cc.canvasToNorm(coords.x, coords.y);

        const bv = this.cropWidget.value;
        const hw = bv.width / 2, hh = bv.height / 2;

        // Corner positions in canvas space
        const corners = [
          { nx: bv.x - hw, ny: bv.y - hh, cursor: 'nw-resize' },
          { nx: bv.x + hw, ny: bv.y - hh, cursor: 'ne-resize' },
          { nx: bv.x + hw, ny: bv.y + hh, cursor: 'se-resize' },
          { nx: bv.x - hw, ny: bv.y + hh, cursor: 'sw-resize' },
        ];

        let cursor = 'default';
        for (const c of corners) {
          const can = cc.normToCanvas(c.nx, c.ny);
          if (Math.hypot(coords.x - can.x, coords.y - can.y) < 15) {
            cursor = c.cursor;
            break;
          }
        }
        if (cursor === 'default') {
          if (n.x >= bv.x - hw && n.x <= bv.x + hw && n.y >= bv.y - hh && n.y <= bv.y + hh) {
            cursor = 'move';
          }
        }
        displayCanvas.style.cursor = cursor;
      });

      displayCanvas.addEventListener('mouseleave', () => {
        displayCanvas.style.cursor = 'default';
      });

      // ---- Helper: sync crop values to backend widgets on every change ----
      this.syncCropToWidgets = () => {
        if (!this.cropWidget) return;
        const bv = this.cropWidget.value;
        for (const [name, val] of [
          ['crop_x',      bv.x],
          ['crop_y',      bv.y],
          ['crop_width',  bv.width],
          ['crop_height', bv.height],
        ]) {
          const w = this.widgets.find(w => w.name === name);
          if (w) w.value = val;
        }
      };

      // ---- Override getImageFromConnectedNode so Refresh stores the image element for redraws ----
      // Patch the import in top_row.js to also cache the Image object.
      // We do this by wrapping the img.onload callback inside handleRefresh.
      // The simplest way: intercept displayCanvas drawImage calls via a small wrapper.

      // Instead, we just store it on node when image loads — see the patch below.
    });
  },
});

