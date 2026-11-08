import { app } from '../../../scripts/app.js';
import { showCustomDrivenToggleMenu, showCustomEasingMenu } from './context_menu.js';
import { initializeDrivenConfig, initializeEasingConfig, toggleDrivenState, prepareDrivenMenu } from './persistence.js';
import { NodeSizeManager } from './node_size_manager.js';
import { PowerSplineHeaderWidget } from './layer_header.js';
import { PowerSplineWidget } from './layer_type_spline.js';
import { HandDrawLayerWidget } from './layer_type_draw.js';
import { BoxLayerWidget } from './layer_type_box.js';
import { TopRowWidget } from './canvas_top_row.js';
import {
    binarySearch,
    fitString,
    measureText,
    isLowQuality,
    drawRoundedRectangle,
    drawWidgetButton,
    drawTogglePart,
    drawNumberWidgetPart,
    QQBaseWidget
} from './drawing_utils.js';

// Re-export for convenience
export {
    NodeSizeManager,
    PowerSplineHeaderWidget,
    PowerSplineWidget,
    HandDrawLayerWidget,
    BoxLayerWidget,
    TopRowWidget,
    binarySearch,
    fitString,
    measureText,
    isLowQuality,
    drawRoundedRectangle,
    drawWidgetButton,
    drawTogglePart,
    drawNumberWidgetPart,
    QQBaseWidget
};

/**
 * Transform mouse coordinates from canvas space to video/image space
 * @param {Object} splineEditor - The spline editor instance
 * @param {number} mouseX - Mouse X coordinate in canvas space
 * @param {number} mouseY - Mouse Y coordinate in canvas space
 * @returns {Object} Transformed coordinates in video/image space
 */
export function transformMouseToVideoSpace(splineEditor, mouseX, mouseY) {
    // If video is loaded, transform from canvas to video coordinates
    if (splineEditor.videoMetadata && splineEditor.videoScale !== undefined && splineEditor.videoScale !== null) {
        const videoScale = splineEditor.videoScale;
        const videoOffsetX = splineEditor.videoOffsetX || 0;
        const videoOffsetY = splineEditor.videoOffsetY || 0;
        
        // Directly convert from canvas to original media pixel coordinates
        const origX = (mouseX - videoOffsetX) / videoScale;
        const origY = (mouseY - videoOffsetY) / videoScale;
        
        return { x: origX, y: origY };
    }
    
    // Fallback to image space transformation
    if (splineEditor.originalImageWidth && splineEditor.originalImageHeight && splineEditor.scale > 0) {
        const canvasScale = splineEditor.scale;
        const offsetX = splineEditor.offsetX || 0;
        const offsetY = splineEditor.offsetY || 0;
        
        // Directly convert from canvas to original media pixel coordinates
        const origX = (mouseX - offsetX) / canvasScale;
        const origY = (mouseY - offsetY) / canvasScale;
        
        return { x: origX, y: origY };
    }
    
    // No transformation needed
    return { x: mouseX, y: mouseY };
}

/**
 * Transform coordinates from video/image space to canvas space
 * @param {Object} splineEditor - The spline editor instance
 * @param {number} x - X coordinate in video/image space
 * @param {number} y - Y coordinate in video/image space
 * @returns {Object} Transformed coordinates in canvas space
 */
export function transformVideoToCanvasSpace(splineEditor, x, y) {
    // If video is loaded, transform from video to canvas coordinates
    if (splineEditor.videoMetadata && splineEditor.videoScale !== undefined && splineEditor.videoScale !== null) {
        const videoScale = splineEditor.videoScale;
        const videoOffsetX = splineEditor.videoOffsetX || 0;
        const videoOffsetY = splineEditor.videoOffsetY || 0;
        
        // Directly convert from original media pixel coordinates to canvas coordinates
        const canvasX = (x * videoScale) + videoOffsetX;
        const canvasY = (y * videoScale) + videoOffsetY;
        
        return { x: canvasX, y: canvasY };
    }
    
    // Fallback to image space transformation
    if (splineEditor.originalImageWidth && splineEditor.originalImageHeight && splineEditor.scale > 0) {
        const canvasScale = splineEditor.scale;
        const offsetX = splineEditor.offsetX || 0;
        const offsetY = splineEditor.offsetY || 0;
        
        // Directly convert from original media pixel coordinates to canvas coordinates
        const canvasX = (x * canvasScale) + offsetX;
        const canvasY = (y * canvasScale) + offsetY;
        
        return { x: canvasX, y: canvasY };
    }
    
    // No transformation needed
    return { x, y };
}

//from melmass
// IMPORTANT: These must match config/constants.py - keep them in sync!
export const BOX_BASE_RADIUS = 200;
export const POINT_BASE_RADIUS = 8;
export const BOX_BORDER_BAND = 20;

export function makeUUID() {
  let dt = new Date().getTime()
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = ((dt + Math.random() * 16) % 16) | 0
    dt = Math.floor(dt / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
  return uuid
}

export const loadScript = (
    FILE_URL,
    async = true,
    type = 'text/javascript',
  ) => {
    return new Promise((resolve, reject) => {
      try {
        // Check if the script already exists
        const existingScript = document.querySelector(`script[src="${FILE_URL}"]`)
        if (existingScript) {
          console.log(`[loadScript] Script already loaded: ${FILE_URL}`);
          resolve({ status: true, message: 'Script already loaded' })
          return
        }

        console.log(`[loadScript] Loading script: ${FILE_URL}`);
        const scriptEle = document.createElement('script')
        scriptEle.type = type
        scriptEle.async = async
        scriptEle.src = FILE_URL

        scriptEle.addEventListener('load', (ev) => {
          console.log(`[loadScript] Script loaded successfully: ${FILE_URL}`);
          resolve({ status: true })
        })

        scriptEle.addEventListener('error', (ev) => {
          console.error(`[loadScript] Failed to load script: ${FILE_URL}`, ev);
          reject({
            status: false,
            message: `Failed to load the script ${FILE_URL}`,
          })
        })

        document.body.appendChild(scriptEle)
      } catch (error) {
        console.error(`[loadScript] Exception while loading ${FILE_URL}:`, error);
        reject(error)
      }
    })
  }
  
export const create_documentation_stylesheet = () => {
    const tag = 'qq-splineditor-stylesheet'

    let styleTag = document.head.querySelector(tag)

    if (!styleTag) {
      styleTag = document.createElement('style')
      styleTag.type = 'text/css'
      styleTag.id = tag
      styleTag.innerHTML = `
       .spline-editor {

        position: relative;

        font: 12px monospace;
        line-height: 1.5em;
        padding: 0px;
        z-index: 1;
        overflow: visible;
        display: block;
        isolation: isolate;
       }
        `
      document.head.appendChild(styleTag)
    }
  }

// === DIMENSIONS WIDGET (Simplified version for backward compatibility) ===
export class DimensionsWidget extends QQBaseWidget {
    constructor(name = "DimensionsWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            widthDec: { bounds: [0, 0] },
            widthVal: { bounds: [0, 0] },
            widthInc: { bounds: [0, 0] },
            widthAny: { bounds: [0, 0] },
            heightDec: { bounds: [0, 0] },
            heightVal: { bounds: [0, 0] },
            heightInc: { bounds: [0, 0] },
            heightAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        // This widget is now replaced by TopRowWidget, but kept for backward compatibility
        // It will not be displayed
        return;
    }

    // Keep the methods for backward compatibility
    stepWidth(node, step) {
        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        if (widthWidget) {
            const newValue = widthWidget.value + step;
            widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
            if (widthWidget.callback) {
                widthWidget.callback(widthWidget.value);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    stepHeight(node, step) {
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        if (heightWidget) {
            const newValue = heightWidget.value + step;
            heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
            if (heightWidget.callback) {
                heightWidget.callback(heightWidget.value);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    promptWidth(node) {
        if (this.haveMouseMovedValue) return;
        const widthWidget = node.widgets?.find(w => w.name === "mask_width");
        if (widthWidget) {
            const canvas = app.canvas;
            canvas.prompt("Width", widthWidget.value, (v) => {
                const newValue = Number(v);
                widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
                if (widthWidget.callback) {
                    widthWidget.callback(widthWidget.value);
                }
            });
        }
    }

    promptHeight(node) {
        if (this.haveMouseMovedValue) return;
        const heightWidget = node.widgets?.find(w => w.name === "mask_height");
        if (heightWidget) {
            const canvas = app.canvas;
            canvas.prompt("Height", heightWidget.value, (v) => {
                const newValue = Number(v);
                heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
                if (heightWidget.callback) {
                    heightWidget.callback(heightWidget.value);
                }
            });
        }
    }

    dragWidth(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widthWidget = node.widgets?.find(w => w.name === "mask_width");
            if (widthWidget) {
                const newValue = widthWidget.value + event.deltaX * 2;
                widthWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasWidth(newValue) : Math.max(64, newValue);
                if (widthWidget.callback) {
                    widthWidget.callback(widthWidget.value);
                }
                node.setDirtyCanvas(true, true);
            }
        }
    }

    dragHeight(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const heightWidget = node.widgets?.find(w => w.name === "mask_height");
            if (heightWidget) {
                const newValue = heightWidget.value + event.deltaX * 2;
                heightWidget.value = node.sizeManager ? node.sizeManager.constrainCanvasHeight(newValue) : Math.max(64, newValue);
                if (heightWidget.callback) {
                    heightWidget.callback(heightWidget.value);
                }
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, 0]; // Zero height since it's not displayed
    }
}

// === INTERPOLATION WIDGET ===
export class InterpolationWidget extends QQBaseWidget {
    constructor(name = "InterpolationWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            interpDec: { bounds: [0, 0] },
            interpVal: { bounds: [0, 0] },
            interpInc: { bounds: [0, 0] },
            interpAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 130;
        const innerMargin = 10;
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const interpWidget = node.widgets?.find(w => w.name === "interpolation");
        const interpValue = interpWidget ? interpWidget.value : "linear";

        // Interpolation modes - display abbreviated versions
        const interpModes = ['linear', 'cardinal', 'basis', 'points'];
        const interpShortNames = ['linear', 'cardinal', 'basis', 'points'];
        const interpIndex = interpModes.indexOf(interpValue);
        const interpDisplayText = interpIndex >= 0 ? interpShortNames[interpIndex] : 'linear';

        // Label
        const interpLabel = "interpolation:";
        const maxLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText(interpLabel).width
        );

        // Calculate interpolation text width
        const interpTextWidth = Math.max(
            ctx.measureText("cardinal").width,
            ctx.measureText("linear").width,
            ctx.measureText("basis").width,
            ctx.measureText("points").width
        ) + 20; // Add padding

        const arrowWidth = 9;
        const innerMargin2 = 3;
        const totalWidth = maxLabelWidth + innerMargin + arrowWidth + innerMargin2 + interpTextWidth + innerMargin2 + arrowWidth;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "interpolation:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(interpLabel, posX + maxLabelWidth, midY);
        posX += maxLabelWidth + innerMargin;

        // Left arrow bounds
        this.hitAreas.interpDec.bounds = [posX, arrowWidth];
        ctx.textAlign = "center";
        ctx.fillText("?", posX + arrowWidth / 2, midY);
        posX += arrowWidth + innerMargin2;

        // Text bounds
        this.hitAreas.interpVal.bounds = [posX, interpTextWidth];
        ctx.fillText(interpDisplayText, posX + interpTextWidth / 2, midY);
        posX += interpTextWidth + innerMargin2;

        // Right arrow bounds
        this.hitAreas.interpInc.bounds = [posX, arrowWidth];
        ctx.fillText("?", posX + arrowWidth / 2, midY);

        // Combined bounds for all interp controls
        this.hitAreas.interpAny.bounds = [this.hitAreas.interpDec.bounds[0], arrowWidth + innerMargin2 + interpTextWidth + innerMargin2 + arrowWidth];
        this.hitAreas.interpDec.onClick = () => this.stepInterp(node, -1);
        this.hitAreas.interpInc.onClick = () => this.stepInterp(node, 1);
        this.hitAreas.interpVal.onClick = () => this.cycleInterp(node);

        ctx.restore();
    }

    stepInterp(node, step) {
        const widget = node.widgets?.find(w => w.name === "interpolation");
        if (widget) {
            const modes = ['linear', 'cardinal', 'basis', 'points'];
            const currentIndex = modes.indexOf(widget.value);
            const newIndex = (currentIndex + step + modes.length) % modes.length;
            widget.value = modes[newIndex];
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }

    cycleInterp(node) {
        // Clicking the text cycles through modes
        this.stepInterp(node, 1);
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === DRIVER ROTATION & D_SCALE WIDGET (Combined driver_rotation and driver_d_scale) ===
export class DriverRotationDScaleWidget extends QQBaseWidget {
    constructor(name = "DriverRotationDScaleWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            rotationDec: { bounds: [0, 0] },
            rotationVal: { bounds: [0, 0] },
            rotationInc: { bounds: [0, 0] },
            rotationAny: { bounds: [0, 0] },
            dScaleDec: { bounds: [0, 0] },
            dScaleVal: { bounds: [0, 0] },
            dScaleInc: { bounds: [0, 0] },
            dScaleAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20;
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const rotationWidget = node.widgets?.find(w => w.name === "driver_rotation");
        const rotationValue = rotationWidget ? rotationWidget.value : 0;
        const dScaleWidget = node.widgets?.find(w => w.name === "driver_d_scale");
        const dScaleValue = dScaleWidget ? dScaleWidget.value : 1.0;

        // Labels
        const rotationLabel = "driver_rotation:";
        const dScaleLabel = "driver_d_scale:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("driver_rotation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("driver_d_scale:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "driver_rotation:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(rotationLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw rotation control (with ? suffix)
        const [rLeftArrow, rText, rRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: rotationValue,
            direction: 1,
            suffix: "?"
        });

        this.hitAreas.rotationDec.bounds = rLeftArrow;
        this.hitAreas.rotationVal.bounds = rText;
        this.hitAreas.rotationInc.bounds = rRightArrow;
        this.hitAreas.rotationAny.bounds = [rLeftArrow[0], rRightArrow[0] + rRightArrow[1] - rLeftArrow[0]];
        this.hitAreas.rotationDec.onClick = () => this.stepRotation(node, -15);
        this.hitAreas.rotationInc.onClick = () => this.stepRotation(node, 15);
        this.hitAreas.rotationVal.onClick = () => this.promptRotation(node);
        this.hitAreas.rotationAny.onMove = (event) => this.dragRotation(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "driver_d_scale:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(dScaleLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw d_scale control
        const [sLeftArrow, sText, sRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: dScaleValue,
            direction: 1,
            precision: 2
        });

        this.hitAreas.dScaleDec.bounds = sLeftArrow;
        this.hitAreas.dScaleVal.bounds = sText;
        this.hitAreas.dScaleInc.bounds = sRightArrow;
        this.hitAreas.dScaleAny.bounds = [sLeftArrow[0], sRightArrow[0] + sRightArrow[1] - sLeftArrow[0]];
        this.hitAreas.dScaleDec.onClick = () => this.stepDScale(node, -0.01);
        this.hitAreas.dScaleInc.onClick = () => this.stepDScale(node, 0.01);
        this.hitAreas.dScaleVal.onClick = () => this.promptDScale(node);
        this.hitAreas.dScaleAny.onMove = (event) => this.dragDScale(node, event);

        ctx.restore();
    }

    stepRotation(node, step) {
        const widget = node.widgets?.find(w => w.name === "driver_rotation");
        if (widget) {
            widget.value = Math.max(-360, Math.min(360, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptRotation(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "driver_rotation");
        if (widget) {
            app.canvas.prompt("driver_rotation", widget.value, (v) => {
                widget.value = Math.max(-360, Math.min(360, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragRotation(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "driver_rotation");
            if (widget) {
                widget.value = Math.max(-360, Math.min(360, widget.value + event.deltaX));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepDScale(node, step) {
        const widget = node.widgets?.find(w => w.name === "driver_d_scale");
        if (widget) {
            widget.value = Math.max(0.0, Math.min(1.0, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptDScale(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "driver_d_scale");
        if (widget) {
            app.canvas.prompt("driver_d_scale", widget.value, (v) => {
                widget.value = Math.max(0.0, Math.min(1.0, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragDScale(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "driver_d_scale");
            if (widget) {
                widget.value = Math.max(0.0, Math.min(1.0, widget.value + event.deltaX * 0.01)); // Scale for float precision
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === PAUSE WIDGET (Combined start_pause and end_pause) ===
export class PauseWidget extends QQBaseWidget {
    constructor(name = "PauseWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            startPauseDec: { bounds: [0, 0] },
            startPauseVal: { bounds: [0, 0] },
            startPauseInc: { bounds: [0, 0] },
            startPauseAny: { bounds: [0, 0] },
            endPauseDec: { bounds: [0, 0] },
            endPauseVal: { bounds: [0, 0] },
            endPauseInc: { bounds: [0, 0] },
            endPauseAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20; // Space between start_pause and end_pause
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const startPauseWidget = node.widgets?.find(w => w.name === "start_pause");
        const startPauseValue = startPauseWidget ? startPauseWidget.value : 0;
        const endPauseWidget = node.widgets?.find(w => w.name === "end_pause");
        const endPauseValue = endPauseWidget ? endPauseWidget.value : 0;

        // Labels
        const startLabel = "start_pause:";
        const endLabel = "end_pause:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText("interpolation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("end_pause:").width,
            ctx.measureText("repeat:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "start_pause:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(startLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw start_pause control
        const [spLeftArrow, spText, spRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: startPauseValue,
            direction: 1,
        });

        this.hitAreas.startPauseDec.bounds = spLeftArrow;
        this.hitAreas.startPauseVal.bounds = spText;
        this.hitAreas.startPauseInc.bounds = spRightArrow;
        this.hitAreas.startPauseAny.bounds = [spLeftArrow[0], spRightArrow[0] + spRightArrow[1] - spLeftArrow[0]];
        this.hitAreas.startPauseDec.onClick = () => this.stepStartPause(node, -1);
        this.hitAreas.startPauseInc.onClick = () => this.stepStartPause(node, 1);
        this.hitAreas.startPauseVal.onClick = () => this.promptStartPause(node);
        this.hitAreas.startPauseAny.onMove = (event) => this.dragStartPause(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "end_pause:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(endLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw end_pause control
        const [epLeftArrow, epText, epRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: endPauseValue,
            direction: 1,
        });

        this.hitAreas.endPauseDec.bounds = epLeftArrow;
        this.hitAreas.endPauseVal.bounds = epText;
        this.hitAreas.endPauseInc.bounds = epRightArrow;
        this.hitAreas.endPauseAny.bounds = [epLeftArrow[0], epRightArrow[0] + epRightArrow[1] - epLeftArrow[0]];
        this.hitAreas.endPauseDec.onClick = () => this.stepEndPause(node, -1);
        this.hitAreas.endPauseInc.onClick = () => this.stepEndPause(node, 1);
        this.hitAreas.endPauseVal.onClick = () => this.promptEndPause(node);
        this.hitAreas.endPauseAny.onMove = (event) => this.dragEndPause(node, event);

        ctx.restore();
    }

    stepStartPause(node, step) {
        const widget = node.widgets?.find(w => w.name === "start_pause");
        if (widget) {
            widget.value = Math.max(0, widget.value + step);
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptStartPause(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "start_pause");
        if (widget) {
            app.canvas.prompt("start_pause", widget.value, (v) => {
                widget.value = Math.max(0, Number(v));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragStartPause(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "start_pause");
            if (widget) {
                widget.value = Math.max(0, widget.value + event.deltaX);
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepEndPause(node, step) {
        const widget = node.widgets?.find(w => w.name === "end_pause");
        if (widget) {
            widget.value = Math.max(0, widget.value + step);
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptEndPause(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "end_pause");
        if (widget) {
            app.canvas.prompt("end_pause", widget.value, (v) => {
                widget.value = Math.max(0, Number(v));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragEndPause(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "end_pause");
            if (widget) {
                widget.value = Math.max(0, widget.value + event.deltaX);
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// === OFFSET REPEAT WIDGET (Combined offset and repeat) ===
export class OffsetRepeatWidget extends QQBaseWidget {
    constructor(name = "OffsetRepeatWidget") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.hitAreas = {
            offsetDec: { bounds: [0, 0] },
            offsetVal: { bounds: [0, 0] },
            offsetInc: { bounds: [0, 0] },
            offsetAny: { bounds: [0, 0] },
            repeatDec: { bounds: [0, 0] },
            repeatVal: { bounds: [0, 0] },
            repeatInc: { bounds: [0, 0] },
            repeatAny: { bounds: [0, 0] },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 40;
        const innerMargin = 10;
        const spacingBetweenGroups = 20; // Space between offset and repeat
        const midY = posY + height * 0.5;

        ctx.save();
        drawRoundedRectangle(ctx, { pos: [margin, posY], size: [node.size[0] - margin * 2, height] });

        if (isLowQuality()) {
            ctx.restore();
            return;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";

        const offsetWidget = node.widgets?.find(w => w.name === "offset");
        const offsetValue = offsetWidget ? offsetWidget.value : 0;
        const repeatWidget = node.widgets?.find(w => w.name === "repeat");
        const repeatValue = repeatWidget ? repeatWidget.value : 1;

        // Labels
        const offsetLabel = "offset:";
        const repeatLabel = "repeat:";
        const maxLeftLabelWidth = Math.max(
            ctx.measureText("width:").width,
            ctx.measureText("start_pause:").width,
            ctx.measureText("offset:").width,
            ctx.measureText("interpolation:").width
        );
        const maxRightLabelWidth = Math.max(
            ctx.measureText("height:").width,
            ctx.measureText("end_pause:").width,
            ctx.measureText("repeat:").width
        );

        // Total width: left label + controls + spacing + right label + controls
        const totalWidth = maxLeftLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL +
                          spacingBetweenGroups +
                          maxRightLabelWidth + innerMargin +
                          drawNumberWidgetPart.WIDTH_TOTAL;

        const startX = (node.size[0] - totalWidth) / 2;
        let posX = startX;

        // Draw "offset:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(offsetLabel, posX + maxLeftLabelWidth, midY);
        posX += maxLeftLabelWidth + innerMargin;

        // Draw offset control
        const [oLeftArrow, oText, oRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: offsetValue,
            direction: 1,
        });

        this.hitAreas.offsetDec.bounds = oLeftArrow;
        this.hitAreas.offsetVal.bounds = oText;
        this.hitAreas.offsetInc.bounds = oRightArrow;
        this.hitAreas.offsetAny.bounds = [oLeftArrow[0], oRightArrow[0] + oRightArrow[1] - oLeftArrow[0]];
        this.hitAreas.offsetDec.onClick = () => this.stepOffset(node, -1);
        this.hitAreas.offsetInc.onClick = () => this.stepOffset(node, 1);
        this.hitAreas.offsetVal.onClick = () => this.promptOffset(node);
        this.hitAreas.offsetAny.onMove = (event) => this.dragOffset(node, event);

        posX += drawNumberWidgetPart.WIDTH_TOTAL + spacingBetweenGroups;

        // Draw "repeat:" label (right-aligned)
        ctx.textAlign = "right";
        ctx.fillText(repeatLabel, posX + maxRightLabelWidth, midY);
        posX += maxRightLabelWidth + innerMargin;

        // Draw repeat control
        const [rLeftArrow, rText, rRightArrow] = drawNumberWidgetPart(ctx, {
            posX: posX,
            posY,
            height,
            value: repeatValue,
            direction: 1,
        });

        this.hitAreas.repeatDec.bounds = rLeftArrow;
        this.hitAreas.repeatVal.bounds = rText;
        this.hitAreas.repeatInc.bounds = rRightArrow;
        this.hitAreas.repeatAny.bounds = [rLeftArrow[0], rRightArrow[0] + rRightArrow[1] - rLeftArrow[0]];
        this.hitAreas.repeatDec.onClick = () => this.stepRepeat(node, -1);
        this.hitAreas.repeatInc.onClick = () => this.stepRepeat(node, 1);
        this.hitAreas.repeatVal.onClick = () => this.promptRepeat(node);
        this.hitAreas.repeatAny.onMove = (event) => this.dragRepeat(node, event);

        ctx.restore();
    }

    stepOffset(node, step) {
        const widget = node.widgets?.find(w => w.name === "offset");
        if (widget) {
            widget.value = Math.max(-100, Math.min(100, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptOffset(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "offset");
        if (widget) {
            app.canvas.prompt("offset", widget.value, (v) => {
                widget.value = Math.max(-100, Math.min(100, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragOffset(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "offset");
            if (widget) {
                widget.value = Math.max(-100, Math.min(100, widget.value + event.deltaX));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    stepRepeat(node, step) {
        const widget = node.widgets?.find(w => w.name === "repeat");
        if (widget) {
            widget.value = Math.max(1, Math.min(20, widget.value + step));
            if (widget.callback) widget.callback(widget.value);
            node.setDirtyCanvas(true, true);
        }
    }
    promptRepeat(node) {
        if (this.haveMouseMovedValue) return;
        const widget = node.widgets?.find(w => w.name === "repeat");
        if (widget) {
            app.canvas.prompt("repeat", widget.value, (v) => {
                widget.value = Math.max(1, Math.min(20, Number(v)));
                if (widget.callback) widget.callback(widget.value);
            });
        }
    }
    dragRepeat(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const widget = node.widgets?.find(w => w.name === "repeat");
            if (widget) {
                widget.value = Math.max(1, Math.min(20, widget.value + Math.round(event.deltaX / 10)));
                if (widget.callback) widget.callback(widget.value);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
