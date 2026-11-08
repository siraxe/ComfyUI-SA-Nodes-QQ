/**
 * Top Row Widget for Power Load Video
 * Similar to Power Spline Editor's top row with Refresh button and text inputs
 */
import { app } from '../../../scripts/app.js';
import { QQBaseWidget } from '../power_spline_editor/drawing_utils.js';

export class PowerLoadVideoTopRowWidget extends QQBaseWidget {
    constructor(name = "PowerLoadVideoTopRow") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {};
        this.haveMouseMovedValue = false;
        this.refreshButtonMouseDown = false;

        // Default values
        this.fpsValue = 24;
        this.sizeValue = "?x?";
        this.frameCountValue = "?f";
        this.forceFpsValue = "0";
        this.maxFpsValue = "0";

        this.hitAreas = {
            refreshButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
            fpsDec: { bounds: [0, 0], onClick: null },
            fpsVal: { bounds: [0, 0], onClick: null },
            fpsInc: { bounds: [0, 0], onClick: null },
            fpsAny: { bounds: [0, 0], onMove: null },
            sizeInput: { bounds: [0, 0], onClick: null },
            forceFpsInput: { bounds: [0, 0], onClick: null },
            maxFpsInput: { bounds: [0, 0], onClick: null },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 15;
        const spacing = 10;
        const midY = posY + height * 0.5;

        ctx.save();

        const assignBounds = (name, bounds) => {
            const area = this.hitAreas[name];
            if (!area) return;
            area.bounds = bounds;
            area.onClick = null;
            area.onDown = null;
            area.onUp = null;
            area.onMove = null;
        };

        // Calculate available width (no upload button - moved to file selector row)
        const availableWidth = node.size[0] - margin * 2 - spacing * 2;

        // Calculate component widths
        const refreshButtonWidth = availableWidth * 0.24;  // Narrower refresh button
        const fpsControlWidth = availableWidth * 0.22;
        const sizeInputWidth = availableWidth - (refreshButtonWidth + fpsControlWidth) - spacing * 2;

        const startX = margin;
        let posX = startX;

        // Draw Refresh button
        drawWidgetButton(
            ctx,
            { size: [refreshButtonWidth, height], pos: [posX, posY] },
            "🔄 Refresh",
            this.refreshButtonMouseDown
        );
        assignBounds("refreshButton", [posX, refreshButtonWidth]);
        posX += refreshButtonWidth + spacing;

        // Draw FPS control
        const fpsLabelWidth = 35;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText("fps:", posX, midY);

        const fpsControlX = posX + fpsLabelWidth;
        const [fpsLeftArrow, fpsText, fpsRightArrow] = drawNumberWidgetPart(ctx, {
            posX: fpsControlX,
            posY,
            height,
            value: this.fpsValue,
            direction: 1,
        });

        assignBounds("fpsDec", fpsLeftArrow);
        assignBounds("fpsVal", fpsText);
        assignBounds("fpsInc", fpsRightArrow);
        assignBounds("fpsAny", [fpsLeftArrow[0], fpsRightArrow[0] + fpsRightArrow[1] - fpsLeftArrow[0]]);
        posX += fpsLabelWidth + drawNumberWidgetPart.WIDTH_TOTAL + 20;

        // Draw size input (text field style with content-sized background)
        const sizeLabelWidth = 20;
        ctx.fillText("size:", posX, midY);

        const sizeInputX = posX + sizeLabelWidth;

        // Measure the actual text width and add padding
        ctx.textAlign = "left";
        ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
        const textSize = ctx.measureText(this.sizeValue);
        const textWidthActual = Math.ceil(textSize.width);
        const bgPadding = 12; // Padding on each side
        const bgWidth = textWidthActual + bgPadding * 2;
        const bgRadius = height * 0.5;

        // Draw rounded background only around the text content
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(sizeInputX, posY, bgWidth, height, [bgRadius]);
        ctx.fill();
        ctx.stroke();

        // Draw size text
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(this.sizeValue, sizeInputX + bgPadding, midY);

        assignBounds("sizeInput", [sizeInputX, bgWidth]);

        // Draw frame count text (read-only)
        ctx.textAlign = "left";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        posX = sizeInputX + bgWidth + spacing;
        ctx.fillText(this.frameCountValue, posX, midY);

        // Draw force fps label and input
        const forceLabelWidth = 45;
        posX += ctx.measureText(this.frameCountValue).width + 15;
        ctx.fillText("forcef:", posX, midY);

        const forceInputX = posX + forceLabelWidth;

        // Measure the actual text width and add padding
        ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
        const forceTextSize = ctx.measureText(this.forceFpsValue);
        const forceTextWidthActual = Math.ceil(forceTextSize.width);
        const forceBgPadding = 12; // Padding on each side
        const forceBgWidth = forceTextWidthActual + forceBgPadding * 2;
        const forceBgRadius = height * 0.5;

        // Draw rounded background only around the text content
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(forceInputX, posY, forceBgWidth, height, [forceBgRadius]);
        ctx.fill();
        ctx.stroke();

        // Draw force fps text
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(this.forceFpsValue, forceInputX + forceBgPadding, midY);

        assignBounds("forceFpsInput", [forceInputX, forceBgWidth]);

        // Draw max fps label and input (after force fps)
        const maxLabelWidth = 35;
        posX = forceInputX + forceBgWidth + 15;
        ctx.fillText("maxf:", posX, midY);

        const maxInputX = posX + maxLabelWidth;

        // Measure the actual text width and add padding
        ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
        const maxTextSize = ctx.measureText(this.maxFpsValue);
        const maxTextWidthActual = Math.ceil(maxTextSize.width);
        const maxBgPadding = 12; // Padding on each side
        const maxBgWidth = maxTextWidthActual + maxBgPadding * 2;
        const maxBgRadius = height * 0.5;

        // Draw rounded background only around the text content
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(maxInputX, posY, maxBgWidth, height, [maxBgRadius]);
        ctx.fill();
        ctx.stroke();

        // Draw max fps text
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(this.maxFpsValue, maxInputX + maxBgPadding, midY);

        assignBounds("maxFpsInput", [maxInputX, maxBgWidth]);

        // Setup event handlers
        this.hitAreas.refreshButton.onClick = async () => {
            if (node.timelineWidget) {
                // Stop current playback, reset to [ marker position
                node.timelineWidget.stopPlayback();
                node.timelineWidget.value.isPlaying = false;
                const startMarker = node.timelineWidget.startFrameMarker || 1;
                node.timelineWidget.value.currentFrame = startMarker;
                // Apply new FPS as playback rate
                node.timelineWidget.applyPlaybackRate();
            }
            if (node.videoElement && node.timelineWidget) {
                // Reset video to [ marker position
                const nativeFPS = node.timelineWidget.nativeFPS || 24;
                const startMarker = node.timelineWidget.startFrameMarker || 1;
                node.videoElement.currentTime = (startMarker - 1) / nativeFPS;
            }
            // Restart playback at the new FPS
            if (node.timelineWidget) {
                node.timelineWidget.startPlayback(node);
                node.timelineWidget.value.isPlaying = true;
            }
            node.setDirtyCanvas(true, true);
        };
        this.hitAreas.refreshButton.onDown = () => {
            this.refreshButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.refreshButton.onUp = () => {
            this.refreshButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        // FPS handlers
        this.hitAreas.fpsDec.onClick = () => this.stepFps(node, -1);
        this.hitAreas.fpsInc.onClick = () => this.stepFps(node, 1);
        this.hitAreas.fpsVal.onClick = () => this.promptFps(node);
        this.hitAreas.fpsAny.onMove = (event) => this.dragFps(node, event);

        // Size input handler
        this.hitAreas.sizeInput.onClick = () => this.promptSize(node);

        // Force fps input handler
        this.hitAreas.forceFpsInput.onClick = () => this.promptForceFps(node);

        // Max fps input handler
        this.hitAreas.maxFpsInput.onClick = () => this.promptMaxFps(node);

        ctx.restore();
    }

    stepFps(node, step) {
        this.fpsValue = Math.max(1, Math.min(60, this.fpsValue + step));
        if (node.timelineWidget) {
            node.timelineWidget.setFPS(node, this.fpsValue);
        }
        node.setDirtyCanvas(true, true);
    }

    promptFps(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("FPS", this.fpsValue, (v) => {
            const newValue = Math.max(1, Math.min(60, Number(v)));
            this.fpsValue = isNaN(newValue) ? this.fpsValue : newValue;
            if (node.timelineWidget) {
                node.timelineWidget.setFPS(node, this.fpsValue);
            }
        });
    }

    dragFps(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            const delta = Math.sign(event.deltaX);
            this.fpsValue = Math.max(1, Math.min(60, this.fpsValue + delta));
            if (node.timelineWidget) {
                node.timelineWidget.setFPS(node, this.fpsValue);
            }
            node.setDirtyCanvas(true, true);
        }
    }

    promptSize(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Size (WxH)", this.sizeValue, (v) => {
            this.sizeValue = String(v).trim() || "?x?";
            node.setDirtyCanvas(true, true);
        });
    }

    promptForceFps(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Force FPS", this.forceFpsValue, (v) => {
            this.forceFpsValue = String(v).trim() || "0";
            // Update the hidden backend widget value so it gets serialized to Python
            const forceFpsWidget = node.widgets.find(w => w.name === 'force_fps');
            if (forceFpsWidget) {
                forceFpsWidget.value = this.forceFpsValue === "0" ? 0 : parseFloat(this.forceFpsValue);
            }
            node.setDirtyCanvas(true, true);
        });
    }

    promptMaxFps(node) {
        if (this.haveMouseMovedValue) return;
        const canvas = app.canvas;
        canvas.prompt("Max Frames", this.maxFpsValue, (v) => {
            this.maxFpsValue = String(v).trim() || "0";
            // Update the hidden backend widget value so it gets serialized to Python
            const maxFpsWidget = node.widgets.find(w => w.name === 'max_fps');
            if (maxFpsWidget) {
                maxFpsWidget.value = this.maxFpsValue === "0" ? 0 : parseFloat(this.maxFpsValue);
            }
            node.setDirtyCanvas(true, true);
        });
    }

    // Restore from saved workflow JSON
    fromJSON(data, _widgetInfo, node) {
        if (data?.force_fps !== undefined && data.force_fps !== null) {
            this.forceFpsValue = String(data.force_fps);
        }
        if (data?.max_fps !== undefined && data.max_fps !== null) {
            this.maxFpsValue = String(data.max_fps);
        }
        return this;
    }

    // Serialize to workflow JSON
    toJSON(_node, widgetInfo) {
        return {
            force_fps: this.forceFpsValue === "0" ? 0 : parseFloat(this.forceFpsValue),
            max_fps: this.maxFpsValue === "0" ? 0 : parseFloat(this.maxFpsValue)
        };
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedValue = false;
        this.refreshButtonMouseDown = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// Import drawing utilities
function drawWidgetButton(ctx, rect, label, pressed = false) {
    const [x, y] = rect.pos;
    const [w, h] = rect.size;
    const midY = y + h * 0.5;

    ctx.save();

    // Button background (square border)
    ctx.fillStyle = pressed ? '#1a4a6a' : LiteGraph.WIDGET_BGCOLOR;
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();

    // Button text with emoji support
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.font = `${Math.max(12, h * 0.6)}px Sans-Serif`;
    ctx.fillText(label, x + w * 0.5, midY + (pressed ? 1 : 0));

    ctx.restore();
}

function drawNumberWidgetPart(ctx, { posX, posY, height, value, direction = 1 }) {
    const spacing = 0;  // No gap between elements
    const arrowWidth = 16;
    const textWidth = 32;
    const midY = posY + height * 0.5;

    // Left arrow (no background)
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
    const leftArrowChar = direction === 1 ? "\u25C4" : "\u25B6"; // Left triangle or right triangle
    ctx.fillText(leftArrowChar, posX + arrowWidth * 0.5, midY);

    // Text in the middle (no background)
    const textX = posX + arrowWidth + spacing;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
    ctx.fillText(String(value), textX + textWidth * 0.5, midY);

    // Right arrow (no background)
    const rightArrowX = textX + textWidth + spacing;
    const rightArrowChar = direction === 1 ? "\u25B6" : "\u25C4"; // Right triangle or left triangle
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
    ctx.fillText(rightArrowChar, rightArrowX + arrowWidth * 0.5, midY);

    // Return hit areas: [leftArrow, text, rightArrow] each as [x, y, w, h]
    return [
        [posX, posY, arrowWidth, height],
        [textX, posY, textWidth, height],
        [rightArrowX, posY, arrowWidth, height]
    ];
}

drawNumberWidgetPart.WIDTH_TOTAL = 16 + 0 + 32 + 0 + 16; // arrow + spacing + text + spacing + arrow
