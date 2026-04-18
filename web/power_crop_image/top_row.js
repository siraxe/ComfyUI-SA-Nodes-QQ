/**
 * TopRowWidget for Power Image Crop
 * Row: Refresh | Crop (toggle) | Keep AR (toggle) | [hidden width/height controls]
 */
import { app } from '../../../scripts/app.js';
import {
  drawWidgetButton,
  RgthreeBaseWidget,
} from '../power_spline_editor/drawing_utils.js';

export class PowerCropTopRowWidget extends RgthreeBaseWidget {
  constructor(name = "PowerCropTopRow") {
    super(name);
    this.type = "custom";
    this.options = { serialize: false };
    this.value = {};

    // Track button states
    this.refreshButtonMouseDown = false;
  }

  draw(ctx, node, w, posY, height) {
    const margin = 15;
    const spacing = 10;
    const midY   = posY + height * 0.5;
    ctx.save();

    // Widget values from backend
    const wW   = node.widgets?.find(w => w.name === "mask_width");
    const hW   = node.widgets?.find(w => w.name === "mask_height");
    const arW  = node.widgets?.find(w => w.name === "keep_ar");

    // Layout: 3 buttons equally spaced, or fixed widths
    const btnW   = 90;  // Fixed button width like PowerLoadVideo style

    let x = margin;

    // — Refresh button (🔄) —
    drawWidgetButton(ctx, { size: [btnW, height], pos: [x, posY] }, "🔄 Refresh", this.refreshButtonMouseDown);
    x += btnW + spacing;

    // — Crop toggle button (green outline when active) —
    const cropOn = !!node.cropWidget?.value.visible;
    drawWidgetButton(ctx, { size: [btnW, height], pos: [x, posY] }, "Crop", cropOn);
    if (cropOn) {
      ctx.save();
      ctx.strokeStyle = '#00ff64'; ctx.lineWidth = 2;
      const p = 0.5;
      ctx.beginPath(); ctx.roundRect(x+p, posY+p, btnW-p*2, height-p*2, [4]); ctx.stroke();
      ctx.restore();
    }
    x += btnW + spacing;

    // — Keep AR toggle button (blue when active) —
    const keepAr = arW ? arW.value : true;
    drawWidgetButton(ctx, { size: [btnW, height], pos: [x, posY] }, "Keep AR", keepAr);
    if (keepAr) {
      ctx.save();
      ctx.strokeStyle = '#2cc6ff'; ctx.lineWidth = 2;
      const p = 0.5;
      ctx.beginPath(); ctx.roundRect(x+p, posY+p, btnW-p*2, height-p*2, [4]); ctx.stroke();
      ctx.restore();
    }

    // Assign hit areas for all buttons
    this.hitAreas.refreshButton = { bounds: [margin, btnW], onClick: null, onDown: null, onUp: null };
    this.hitAreas.cropButton = { bounds: [margin + btnW + spacing, btnW], onClick: null };
    this.hitAreas.keepArButton = { bounds: [margin + (btnW + spacing) * 2, btnW], onClick: null };

    // Set handlers
    this.hitAreas.refreshButton.onClick = () => {
      handleRefresh(node);
      return true;
    };
    this.hitAreas.refreshButton.onDown = () => { this.refreshButtonMouseDown = true; };
    this.hitAreas.refreshButton.onUp = () => { this.refreshButtonMouseDown = false; };

    this.hitAreas.cropButton.onClick = () => {
      node.cropWidget.value.visible = !node.cropWidget.value.visible;
      node.cropWidget.redraw(node);
      syncCropToWidgets(node);
      node.setDirtyCanvas(true, true);
      return true;
    };

    this.hitAreas.keepArButton.onClick = () => {
      if (arW) {
        arW.value = !arW.value;
        if (arW.callback) arW.callback(arW.value);
        // When toggling keep AR, optionally adjust height to maintain ratio with current width
        if (arW.value && wW && hW && node.cropCanvas?.originalImageWidth) {
          const aspect = node.cropCanvas.originalImageHeight / node.cropCanvas.originalImageWidth;
          const newH = Math.round((wW.value * aspect) / 8) * 8;
          if (hW && newH > 0 && newH !== hW.value) {
            hW.value = newH;
            if (hW.callback) hW.callback(hW.value);
          }
        }
      }
      node.setDirtyCanvas(true, true);
      return true;
    };

    ctx.restore();
  }

  onMouseUp(event, pos, node) {
    super.onMouseUp(event, pos, node);
  }

  computeSize(width) {
    // Fixed height row
    return [width, LiteGraph.NODE_WIDGET_HEIGHT];
  }
}

function syncCropToWidgets(node) {
  if (!node.cropWidget) return;
  const bv = node.cropWidget.value;
  for (const [name, val] of [['crop_x',bv.x],['crop_y',bv.y],['crop_width',bv.width],['crop_height',bv.height]]) {
    const w = node.widgets.find(w => w.name === name); if (w) w.value = val;
  }
}

// — Refresh: load connected image onto canvas —
async function handleRefresh(node) {
  try {
    const imgData = await getImageFromConnectedNode(node);
    if (!imgData || !node.cropCanvas) return;

    const img = new Image();
    img.onload = () => {
      // Draw to display canvas for crop overlay
      node.cropCanvas.loadBackgroundImage(img);

      // Hide placeholder
      const ph = document.getElementById(`power-crop-placeholder-${node.id}`);
      if (ph) ph.style.display = 'none';

      // Reset crop box to full image
      const bv = node.cropWidget.value;
      bv.x = 0.5; bv.y = 0.5; bv.width = 1.0; bv.height = 1.0;
      syncCropToWidgets(node);

      // Update width/height widgets to image dimensions (step of 8)
      const wW = node.widgets?.find(w => w.name === "mask_width");
      const hW = node.widgets?.find(w => w.name === "mask_height");
      if (wW) {
        wW.value = Math.round(node.cropCanvas.originalImageWidth / 8) * 8;
        if (wW.callback) wW.callback(wW.value);
      }
      if (hW) {
        hW.value = Math.round(node.cropCanvas.originalImageHeight / 8) * 8;
        if (hW.callback) hW.callback(hW.value);
      }

      node.setDirtyCanvas(true, true);
    };
    img.onerror = () => console.error('[PowerImageCrop] Failed to load image');
    img.src = imgData;
  } catch (e) {
    console.error('[PowerImageCrop] Refresh error:', e);
  }
}

/** Normalize a widget value into a /view URL or data URL. */
function toImageUrl(value, fallbackType = 'input') {
  if (!value) return null;
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.startsWith('http')) return value;
    return `/view?filename=${encodeURIComponent(value)}&type=${fallbackType}`;
  }
  if (typeof value === 'object') {
    const filename = value.filename || value.name || value.file;
    if (!filename) return null;
    const type = value.type || fallbackType;
    const subfolder = value.subfolder ? `&subfolder=${encodeURIComponent(value.subfolder)}` : '';
    return `/view?filename=${encodeURIComponent(filename)}&type=${type}${subfolder}`;
  }
  return null;
}

async function getImageFromConnectedNode(node) {
  const graph = app.graph;
  if (!graph || !graph.links) return null;

  // Find the "image" input index
  const inputIndex = node.inputs?.findIndex(i => i.name === "image") ?? -1;
  if (inputIndex < 0) return null;

  // Find the link connected to this input
  let link = null;
  if (graph.links instanceof Map) {
    for (const [, linkObj] of graph.links) {
      if (linkObj && linkObj.target_id === node.id && linkObj.target_slot === inputIndex) {
        link = linkObj;
        break;
      }
    }
  } else if (Array.isArray(graph.links)) {
    link = graph.links.find(l => l && l.target_id === node.id && l.target_slot === inputIndex);
  }
  if (!link) return null;

  // Resolve the source node
  const srcNode = graph._nodes?.find(n => n.id === link.origin_id);
  if (!srcNode) return null;

  // Extract image URL from the source node
  if (srcNode.imagePath)
    return `/view?filename=${encodeURIComponent(srcNode.imagePath)}&type=input`;

  // Check widgets (handles both file-selected and pasted images)
  if (srcNode.widgets) {
    for (const w of srcNode.widgets) {
      if ((w.type === 'image' || w.name?.toLowerCase().includes('image')) && w.value) {
        const v = Array.isArray(w.value) ? w.value[0] : w.value;
        const url = toImageUrl(v);
        if (url) return url;
      }
    }
  }

  // Fallback: widgets_values (index 0 = filename, 1 = subfolder)
  if (srcNode.widgets_values && srcNode.widgets_values[0]) {
    const subfolder = srcNode.widgets_values[1];
    const sub = subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : '';
    return `/view?filename=${encodeURIComponent(srcNode.widgets_values[0])}&type=input${sub}`;
  }

  return null;
}
