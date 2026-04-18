/**
 * CropCanvas — scaled image canvas with coordinate transforms.
 * Same scale/offset logic as PowerSplineEditor (80px padding).
 */

export class CropCanvas {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    // Image properties (same convention as PowerSplineEditor)
    this.originalImageWidth = null;
    this.originalImageHeight = null;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.backgroundImage = null;

    // Canvas dimensions (set by setSize)
    this.width  = canvasElement.width || 620;
    this.height = canvasElement.height || 380;
  }

  /** Recenter — same logic as PowerSplineEditor (40px padding each side). */
  recenter() {
    if (!this.originalImageWidth) return;
    const targetW = this.width  - 80;
    const targetH = this.height - 80;
    this.scale = Math.min(targetW / this.originalImageWidth, targetH / this.originalImageHeight);
    const drawW = this.originalImageWidth * this.scale;
    const drawH = this.originalImageHeight * this.scale;
    this.offsetX = (this.width  - drawW) / 2;
    this.offsetY = (this.height - drawH) / 2;
  }

  /** Load image and setup coordinate system. */
  loadBackgroundImage(img) {
    this.backgroundImage   = img;
    this.originalImageWidth  = img.naturalWidth || img.width;
    this.originalImageHeight = img.naturalHeight || img.height;

    // Sync canvas pixel dimensions to its actual displayed size
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.width  = Math.round(rect.width);
      this.height = Math.round(rect.height);
      this.canvas.width  = this.width;
      this.canvas.height = this.height;
    }

    this.recenter();
    this.render();
  }

  /** Update canvas pixel dimensions (called when width/height widgets change). */
  setSize(w, h) {
    this.width  = w;  this.height = h;
    this.canvas.width  = w;       this.canvas.height = h;
    if (this.originalImageWidth && this.originalImageHeight) this.recenter();
    this.render();
  }

  /** Render background image. */
  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.backgroundImage && this.originalImageWidth) {
      const drawW = this.originalImageWidth * this.scale;
      const drawH = this.originalImageHeight * this.scale;
      ctx.drawImage(this.backgroundImage, this.offsetX, this.offsetY, drawW, drawH);
    }
  }

  /** Draw the crop overlay box in canvas space. */
  drawCropOverlay(node) {
    const bv = node?.cropWidget?.value;
    if (!bv?.visible || !this.originalImageWidth) return;

    // Normalised crop coords (0-1 relative to original image) → canvas pixels
    const imgW = this.originalImageWidth  * this.scale;
    const imgH = this.originalImageHeight * this.scale;
    const cx   = bv.x * imgW + this.offsetX;
    const cy   = bv.y * imgH + this.offsetY;
    const hw   = (bv.width  * imgW) / 2;
    const hh   = (bv.height * imgH) / 2;

    this.ctx.save();
    this.ctx.fillStyle   = 'rgba(0, 255, 100, 0.2)';
    this.ctx.strokeStyle = '#00ff64';
    this.ctx.lineWidth   = 2;
    this.ctx.beginPath();
    this.ctx.rect(cx - hw, cy - hh, hw * 2, hh * 2);
    this.ctx.fill();
    this.ctx.stroke();

    // Corner handles (white squares, black outline)
    const hs = 8;
    for (const [hx, hy] of [[cx-hw,cy-hh],[cx+hw,cy-hh],[cx+hw,cy+hh],[cx-hw,cy+hh]]) {
      this.ctx.fillStyle   = '#fff';
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth   = 1;
      this.ctx.beginPath();
      this.ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
      this.ctx.fill();
      this.ctx.stroke();
    }

    // Centre point
    this.ctx.fillStyle   = '#fff';
    this.ctx.strokeStyle = '#000';
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.restore();
  }

  /** Mouse event → canvas coordinates. */
  getCanvasCoords(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width * this.canvas.width,
      y: (event.clientY - rect.top)  / rect.height * this.canvas.height,
    };
  }

  /** Canvas coordinates → normalised (0-1 relative to original image). */
  canvasToNorm(cX, cY) {
    if (!this.originalImageWidth || !this.scale) return { x: 0, y: 0 };
    const imgW = this.originalImageWidth * this.scale;
    const imgH = this.originalImageHeight * this.scale;
    return {
      x: (cX - this.offsetX) / imgW,
      y: (cY - this.offsetY) / imgH,
    };
  }

  /** Normalised → canvas coordinates. */
  normToCanvas(nx, ny) {
    if (!this.originalImageWidth || !this.scale) return { x: 0, y: 0 };
    const imgW = this.originalImageWidth * this.scale;
    const imgH = this.originalImageHeight * this.scale;
    return {
      x: nx * imgW + this.offsetX,
      y: ny * imgH + this.offsetY,
    };
  }
}

