/**
 * Box Crop Widget for Power Load Video
 *
 * A simplified version of BoxLayerWidget adapted for crop functionality.
 * Provides a draggable/resizable box overlay on the video canvas with controls
 * for position, size, and rotation - without image insertion features.
 */

import { app } from '../../../scripts/app.js';
import { QQBaseWidget } from '../power_spline_editor/drawing_utils.js';

export class BoxCropWidget extends QQBaseWidget {
    constructor(name = "box_crop") {
        super(name);
        this.type = 'custom';
        this.options = { serialize: false };

        // Default box value - centered on video, covering full area
        this.value = {
            x: 0.5,      // Center X (normalized 0-1)
            y: 0.5,      // Center Y (normalized 0-1)
            width: 1.0,  // Width (normalized 0-1)
            height: 1.0, // Height (normalized 0-1)
            rotation: 0, // Rotation in degrees
            visible: false,
        };

        // Hit areas for controls
        this.hitAreas = {
            toggle: { bounds: [0, 0], onClick: null },
            xInput: { bounds: [0, 0], onClick: null },
            yInput: { bounds: [0, 0], onClick: null },
            widthInput: { bounds: [0, 0], onClick: null },
            heightInput: { bounds: [0, 0], onClick: null },
            rotationInput: { bounds: [0, 0], onClick: null },
        };

        // Mouse interaction state
        this.isDragging = false;
        this.dragType = null;    // 'move' or 'corner'
        this.dragCorner = null;  // 'topLeft', 'topRight', 'bottomRight', 'bottomLeft'
        this.dragStart = null;
        this.initialValue = null;
    }

    /**
     * Draw the widget UI row with controls
     */
    draw(ctx, node, w, posY, height) {
        // No-op: widget is hidden (computeSize returns [0, 0]).
        // Box overlay is drawn directly on displayCanvas via updateDisplayCanvas.
        // Toggle is handled by the Crop button in file_selector_widget.
    }

    /**
     * Draw the box overlay on the video canvas
     */
    drawBoxOverlay(ctx, node, canvasWidth, canvasHeight) {
        if (!this.value.visible) return;

        // Get video dimensions from node
        const videoEl = node.videoElement;
        if (!videoEl || videoEl.videoWidth === 0) return;

        const videoWidth = videoEl.videoWidth;
        const videoHeight = videoEl.videoHeight;

        // Calculate box position in canvas coordinates
        const left = (this.value.x - this.value.width / 2) * videoWidth;
        const top = (this.value.y - this.value.height / 2) * videoHeight;
        const right = left + this.value.width * videoWidth;
        const bottom = top + this.value.height * videoHeight;

        ctx.save();

        // Translate to center for rotation
        ctx.translate(
            this.value.x * videoWidth,
            this.value.y * videoHeight
        );
        ctx.rotate((this.value.rotation * Math.PI) / 180);

        // Draw box with semi-transparent fill
        ctx.fillStyle = 'rgba(0, 255, 100, 0.25)';
        ctx.strokeStyle = '#00ff64';
        ctx.lineWidth = 2;

        const halfW = (this.value.width * videoWidth) / 2;
        const halfH = (this.value.height * videoHeight) / 2;

        ctx.beginPath();
        ctx.rect(-halfW, -halfH, this.value.width * videoWidth, this.value.height * videoHeight);
        ctx.fill();
        ctx.stroke();

        // Draw corner handles
        const handleSize = 8;
        const corners = [
            [-halfW, -halfH],
            [halfW, -halfH],
            [halfW, halfH],
            [-halfW, halfH]
        ];

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;

        corners.forEach(([cx, cy]) => {
            ctx.beginPath();
            ctx.rect(cx - handleSize/2, cy - handleSize/2, handleSize, handleSize);
            ctx.fill();
            ctx.stroke();
        });

        // Draw center point
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Handle mouse events for dragging the box on canvas
     */
    handleCanvasMouse(event, pos, node) {
        if (!this.value.visible) return false;

        const videoEl = node.videoElement;
        if (!videoEl || videoEl.videoWidth === 0) return false;

        const displayCanvas = node.displayCanvas;
        if (!displayCanvas) return false;

        const canvasRect = displayCanvas.getBoundingClientRect();
        const relX = (event.clientX - canvasRect.left) / canvasRect.width * videoEl.videoWidth;
        const relY = (event.clientY - canvasRect.top) / canvasRect.height * videoEl.videoHeight;

        const videoW = videoEl.videoWidth;
        const videoH = videoEl.videoHeight;
        const centerX = this.value.x * videoW;
        const centerY = this.value.y * videoH;
        const halfW = (this.value.width * videoW) / 2;
        const halfH = (this.value.height * videoH) / 2;

        // Corner positions
        const corners = [
            { name: 'topLeft', x: centerX - halfW, y: centerY - halfH },
            { name: 'topRight', x: centerX + halfW, y: centerY - halfH },
            { name: 'bottomRight', x: centerX + halfW, y: centerY + halfH },
            { name: 'bottomLeft', x: centerX - halfW, y: centerY + halfH },
        ];

        if (event.type === 'mousedown') {
            // Check corners first (higher priority)
            for (const corner of corners) {
                const dist = Math.sqrt((relX - corner.x) ** 2 + (relY - corner.y) ** 2);
                if (dist < 15) {
                    this.isDragging = true;
                    this.dragType = 'corner';
                    this.dragCorner = corner.name;
                    this.dragStart = { x: relX, y: relY };
                    this.initialValue = { ...this.value };
                    return true;
                }
            }

            // Check if inside box body
            const isInside = relX >= centerX - halfW && relX <= centerX + halfW &&
                             relY >= centerY - halfH && relY <= centerY + halfH;
            if (isInside) {
                this.isDragging = true;
                this.dragType = 'move';
                this.dragCorner = null;
                this.dragStart = { x: relX, y: relY };
                this.initialValue = { ...this.value };
                return true;
            }
            return false;
        }

        if (event.type === 'mousemove' && this.isDragging) {
            if (this.dragType === 'move') {
                const dx = (relX - this.dragStart.x) / videoW;
                const dy = (relY - this.dragStart.y) / videoH;
                // Constrain so box edges stay within video area
                const halfW = this.value.width / 2;
                const halfH = this.value.height / 2;
                this.value.x = Math.max(halfW, Math.min(1 - halfW, this.initialValue.x + dx));
                this.value.y = Math.max(halfH, Math.min(1 - halfH, this.initialValue.y + dy));
            } else if (this.dragType === 'corner') {
                const iv = this.initialValue;
                const initHalfW = (iv.width * videoW) / 2;
                const initHalfH = (iv.height * videoH) / 2;
                const initCenterX = iv.x * videoW;
                const initCenterY = iv.y * videoH;

                // Opposite corner stays fixed
                let oppX, oppY;
                switch (this.dragCorner) {
                    case 'topLeft':     oppX = initCenterX + initHalfW; oppY = initCenterY + initHalfH; break;
                    case 'topRight':    oppX = initCenterX - initHalfW; oppY = initCenterY + initHalfH; break;
                    case 'bottomRight': oppX = initCenterX - initHalfW; oppY = initCenterY - initHalfH; break;
                    case 'bottomLeft':  oppX = initCenterX + initHalfW; oppY = initCenterY - initHalfH; break;
                }

                // Clamp dragged position to video bounds so box can't exceed edges
                const clampedRelX = Math.max(0, Math.min(videoW, relX));
                const clampedRelY = Math.max(0, Math.min(videoH, relY));

                // New center = midpoint between opposite corner and clamped mouse
                const newCenterX = (oppX + clampedRelX) / 2;
                const newCenterY = (oppY + clampedRelY) / 2;
                const newHalfW = Math.abs(clampedRelX - oppX) / 2;
                const newHalfH = Math.abs(clampedRelY - oppY) / 2;

                this.value.x = newCenterX / videoW;
                this.value.y = newCenterY / videoH;
                this.value.width = Math.max(0.05, Math.min(1, (newHalfW * 2) / videoW));
                this.value.height = Math.max(0.05, Math.min(1, (newHalfH * 2) / videoH));
            }

            // Redraw display canvas with updated overlay
            const currentFrame = node.timelineWidget?.value?.currentFrame || 1;
            if (typeof node.updateDisplayCanvas === 'function') {
                node.updateDisplayCanvas(currentFrame);
            }
            return true;
        }

        if (event.type === 'mouseup') {
            if (this.isDragging) {
                this.isDragging = false;
                this.dragType = null;
                this.dragCorner = null;
                this.dragStart = null;
                this.initialValue = null;
                // Sync crop values to hidden widgets for backend serialization
                if (typeof node.syncCropToWidgets === 'function') {
                    node.syncCropToWidgets();
                }
                return true;
            }
        }

        return false;
    }

    /**
     * Prompt user for a numeric value
     */
    promptValue(node, title, currentValue, callback) {
        const canvas = app.canvas;
        canvas.prompt(title, currentValue, (v) => {
            const numV = parseFloat(v);
            if (!isNaN(numV)) {
                callback(numV);
                node.setDirtyCanvas(true, true);
            }
        });
    }

    /**
     * Compute widget size - hidden (we only use canvas overlay)
     */
    computeSize(width) {
        return [0, 0]; // Hidden - controls are in Crop button row
    }
}
