/**
 * CropOverlayWidget — draggable/resizable crop box.
 * Draws the green overlay on the CropCanvas during mouse interaction.
 */
import { RgthreeBaseWidget } from '../power_spline_editor/drawing_utils.js';

export class CropOverlayWidget extends RgthreeBaseWidget {
  constructor(name = "crop_overlay") {
    super(name);
    this.type = 'custom';
    this.options = { serialize: false };

    this.value = { x: 0.5, y: 0.5, width: 1.0, height: 1.0, visible: false };

    this.isDragging   = false;
    this.dragType     = null;
    this.dragCorner   = null;
    this.initialValue = null;
    this._startNorm   = null;
  }

  computeSize() { return [0, 0]; }
  draw() {}

  /** Render the image + crop overlay on the CropCanvas. */
  redraw(node) {
    const cc = node.cropCanvas;
    if (!cc) return;
    cc.render();
    if (this.value.visible && cc.originalImageWidth) {
      cc.drawCropOverlay(node);
    }
  }

  /** Get current keep_ar widget value from node. */
  _keepAr(node) {
    const w = node.widgets?.find(w => w.name === "keep_ar");
    return w ? !!w.value : true;
  }

  /** Handle mouse events on the display canvas. */
  handleCanvasMouse(event, node) {
    if (!this.value.visible) return false;
    const cc = node.cropCanvas;
    if (!cc?.originalImageWidth) return false;

    const coords = cc.getCanvasCoords(event);
    const n = cc.canvasToNorm(coords.x, coords.y);

    const cx = this.value.x,   cy = this.value.y;
    const hw = this.value.width / 2,  hh = this.value.height / 2;

    if (event.type === 'mousedown') {
      // Check corners first (15px hit radius in canvas space)
      const corners = [
        { name: 'topLeft',     nx: cx - hw, ny: cy - hh },
        { name: 'topRight',    nx: cx + hw, ny: cy - hh },
        { name: 'bottomRight', nx: cx + hw, ny: cy + hh },
        { name: 'bottomLeft',  nx: cx - hw, ny: cy + hh },
      ];
      for (const c of corners) {
        const can = cc.normToCanvas(c.nx, c.ny);
        if (Math.hypot(coords.x - can.x, coords.y - can.y) < 15) {
          this.startDrag('corner', c.name, n, node);
          return true;
        }
      }

      // Check body hit
      if (n.x >= cx - hw && n.x <= cx + hw && n.y >= cy - hh && n.y <= cy + hh) {
        this.startDrag('move', null, n, node);
        return true;
      }
      return false;
    }

    if (event.type === 'mousemove' && this.isDragging) {
      const iv = this.initialValue;
      const sn = this._startNorm;

      if (this.dragType === 'move') {
        const dx = n.x - sn.x;
        const dy = n.y - sn.y;
        this.value.x = Math.max(this.value.width / 2,  Math.min(1 - this.value.width / 2,  iv.x + dx));
        this.value.y = Math.max(this.value.height / 2, Math.min(1 - this.value.height / 2, iv.y + dy));
      } else {
        // Corner drag
        // Opposite corner stays fixed
        let oppNx, oppNy;
        switch (this.dragCorner) {
          case 'topLeft':     oppNx = iv.x + iv.width / 2;  oppNy = iv.y + iv.height / 2;  break;
          case 'topRight':    oppNx = iv.x - iv.width / 2;  oppNy = iv.y + iv.height / 2;  break;
          case 'bottomRight': oppNx = iv.x - iv.width / 2;  oppNy = iv.y - iv.height / 2;  break;
          case 'bottomLeft':  oppNx = iv.x + iv.width / 2;  oppNy = iv.y - iv.height / 2;  break;
        }

        // Clamp mouse to image bounds [0,1]
        let mx = Math.max(0, Math.min(1, n.x));
        let my = Math.max(0, Math.min(1, n.y));

        let newW = Math.max(0.05, Math.abs(mx - oppNx));
        let newH = Math.max(0.05, Math.abs(my - oppNy));

        // If keep_ar is on, lock to the aspect ratio of the initial crop box
        if (this._keepAr(node)) {
          const ar = iv.width / iv.height;

          // Use the dominant axis (whichever moved more) to drive the other
          const dxFromOpp = Math.abs(mx - oppNx);
          const dyFromOpp = Math.abs(my - oppNy);
          const impliedAR = dxFromOpp / dyFromOpp;

          if (impliedAR > ar) {
            // Horizontal is too wide — constrain it to match AR
            newW = newH * ar;
            // Adjust mx to keep the correct width while preserving drag direction
            const signX = mx >= oppNx ? 1 : -1;
            mx = oppNx + signX * newW;
          } else {
            // Vertical is too tall — constrain it
            newH = newW / ar;
            const signY = my >= oppNy ? 1 : -1;
            my = oppNy + signY * newH;
          }
        }

        // Final bounds check — make sure new box stays within [0,1]
        const rawLeft   = Math.min(mx, oppNx);
        const rawRight  = Math.max(mx, oppNx);
        const rawTop    = Math.min(my, oppNy);
        const rawBottom = Math.max(my, oppNy);

        if (rawLeft < 0 || rawRight > 1 || rawTop < 0 || rawBottom > 1) {
          // Clamp and shrink to fit
          const clampedW = Math.min(newW, Math.min(oppNx, 1 - oppNx) * 2 || newW);
          const clampedH = Math.min(newH, Math.min(oppNy, 1 - oppNy) * 2 || newH);

          if (this._keepAr(node)) {
            const ar = iv.width / iv.height;
            // Pick the dimension that fits
            if (clampedW / clampedH > ar) {
              newW = clampedH * ar;
              newH = clampedH;
            } else {
              newH = clampedW / ar;
              newW = clampedW;
            }
          } else {
            newW = clampedW;
            newH = clampedH;
          }
        }

        newW = Math.max(0.05, Math.min(1, newW));
        newH = Math.max(0.05, Math.min(1, newH));

        this.value.width  = newW;
        this.value.height = newH;
        this.value.x = oppNx + (mx >= oppNx ? 1 : -1) * newW / 2;
        this.value.y = oppNy + (my >= oppNy ? 1 : -1) * newH / 2;

        // Re-clamp center to keep box within bounds
        this.value.x = Math.max(newW / 2, Math.min(1 - newW / 2, this.value.x));
        this.value.y = Math.max(newH / 2, Math.min(1 - newH / 2, this.value.y));
      }

      this.redraw(node);
      if (typeof node.syncCropToWidgets === 'function') node.syncCropToWidgets();
      return true;
    }

    if (event.type === 'mouseup') {
      if (this.isDragging) {
        this.endDrag(node);
        return true;
      }
    }

    return false;
  }

  startDrag(type, corner, startNorm, node) {
    this.isDragging   = true;
    this.dragType     = type;
    this.dragCorner   = corner;
    this._startNorm   = { ...startNorm };
    this.initialValue = { ...this.value };
  }

  endDrag(node) {
    this.isDragging   = false;
    this.dragType     = null;
    this.dragCorner   = null;
    this._startNorm   = null;
    if (typeof node.syncCropToWidgets === 'function') node.syncCropToWidgets();
  }
}
