import { QQBaseWidget, drawRoundedRectangle, drawTogglePart, drawNumberWidgetPart, fitString } from './drawing_utils.js';
import { initializeDrivenConfig, initializeEasingConfig, initializeScaleConfig, toggleDrivenState, prepareDrivenMenu } from './persistence.js';
import { showCustomEasingMenu, showCustomDrivenToggleMenu, showInterpolationMenu, showRefSelectionMenu } from './context_menu.js';
import { app } from '../../../scripts/app.js';

const BOX_TIMELINE_MAX_POINTS = 250;

export class BoxLayerWidget extends QQBaseWidget {
    constructor(name) {
        super(name);
        this.type = 'custom';
        this.options = { serialize: true };
        this.haveMouseMovedValue = false;
        this._refRestored = false;
        this.hitAreas = {
            toggle: { bounds: [0, 0, 0, 0], onDown: this.onToggleDown },
            name: { bounds: [0, 0, 0, 0] },
            keyButton: { bounds: [0, 0, 0, 0], onClick: this.onKeyClick },
            refSelect: { bounds: [0, 0, 0, 0], onClick: this.onRefSelectClick },
            timelinePlay: { bounds: [0, 0, 0, 0], onClick: this.onTimelinePlayClick, onRightDown: this.onTimelinePlayRightDown },
            deleteButton: { bounds: [0, 0, 0, 0], onClick: this.onDeleteClick },
            interpVal: { bounds: [0, 0, 0, 0], onClick: this.onInterpClick },
            repeatDec: { bounds: [0, 0, 0, 0], onClick: this.onRepeatDec },
            repeatVal: { bounds: [0, 0, 0, 0], onClick: this.onRepeatClick },
            repeatInc: { bounds: [0, 0, 0, 0], onClick: this.onRepeatInc },
            repeatAny: { bounds: [0, 0, 0, 0], onMove: this.onRepeatMove },
            easingVal: { bounds: [0, 0, 0, 0], onClick: this.onEasingClick, onRightDown: this.onEasingRightDown },
            drivenToggle: { bounds: [0, 0, 0, 0], onDown: this.onDrivenToggleDown, onRightDown: this.onDrivenToggleRightDown },
            scaleDec: { bounds: [0, 0, 0, 0], onClick: this.onScaleDec },
            scaleVal: { bounds: [0, 0, 0, 0], onClick: this.onScaleClick },
            scaleInc: { bounds: [0, 0, 0, 0], onClick: this.onScaleInc },
            scaleAny: { bounds: [0, 0, 0, 0], onMove: this.onScaleMove },
            timeline: { bounds: [0, 0, 0, 0], onDown: this.onTimelineDown, onMove: this.onTimelineMove },
        };
        this.value = {
            type: 'box_layer',
            on: true,
            name: 'Box Layer',
            repeat: 1,
            points_store: '[]',
            interpolation: 'box',
            box_interpolation: 'linear',
            box_timeline_point: 1,
            box_keys: [],
            easing: 'in_out',
            easingConfig: { path: 'full', strength: 1.0 },
            driven: false,
            _drivenConfig: { driver: '', rotate: 0, d_scale: 1.0 },
            scale: 1.00,
            ref_attachment: null,
            ref_selection: 'no_ref',
        };
        if (!Array.isArray(this.value.box_keys)) {
            this.value.box_keys = [];
        }
        initializeDrivenConfig(this.value, this.value);
        initializeEasingConfig(this.value, this.value);
        initializeScaleConfig(this.value, this.value);
        if (!this.value.ref_selection) {
            this.value.ref_selection = 'no_ref';
        }
        this._timelineBounds = null;
        this._timelineDragging = false;
        this._timelinePreviewMode = false;
        this._buttonPressTimes = {};
        this._buttonPressDurationMs = 140;
        this._playbackInterval = null;
        this._timelinePlayIcons = ['▶', '❚❚']; // fixed thick set
        // Keyframe drag state
        this._keyframeDragActive = false;
        this._keyframeDragStartFrame = null;
    }

    _getMaxFrames(node) {
        // Get max frames from editor if available, otherwise use default
        if (node && node.editor && node.editor._getMaxFrames) {
            return node.editor._getMaxFrames();
        }
        return BOX_TIMELINE_MAX_POINTS;
    }

    draw(ctx, node, w, posY, height) {
        // Lazy restore ref attachment from sessionStorage if missing
        if (!this.value.ref_attachment && node && !this._refRestored) {
            this._refRestored = true;
            try {
                const keyId = node.id ?? node.uuid;
                const key = keyId ? `spline-editor-boxref-${keyId}-${this.value.name || this.name || 'box'}` : null;
                const cached = sessionStorage.getItem(key);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    // New format stores { attachment, selection }
                    if (parsed && parsed.attachment) {
                        this.value.ref_attachment = parsed.attachment;
                        if (parsed.selection) {
                            this.value.ref_selection = parsed.selection;
                        }
                    } else if (parsed && (parsed.base64 || parsed.path || Array.isArray(parsed.entries))) {
                        // Legacy direct attachment cache (supports both base64 and path formats)
                        this.value.ref_attachment = parsed;
                    }
                }
            } catch (e) {
                console.warn('Failed to restore box ref attachment from session:', e);
            }
        }

        const margin = 10;
        const innerMargin = margin * 0.33;
        const baseRowHeight = LiteGraph.NODE_WIDGET_HEIGHT;
        const mainRowHeight = Math.min(baseRowHeight, height);
        let detailRowHeight = Math.max(0, height - mainRowHeight);
        if (detailRowHeight <= 0) {
            detailRowHeight = baseRowHeight;
        }
        const widgetHeight = mainRowHeight + detailRowHeight;
        const detailY = posY + mainRowHeight;
        let posX = margin;
        ctx.save();

        if (node.layerManager && node.layerManager.getActiveWidget() === this) {
            drawRoundedRectangle(ctx, {
                pos: [posX, posY],
                size: [node.size[0] - margin * 2, widgetHeight],
                colorStroke: '#2cc6ff',
                colorBackground: '#080808E6',
                borderRadius: 8,
            });
        } else {
            drawRoundedRectangle(ctx, {
                pos: [posX, posY],
                size: [node.size[0] - margin * 2, widgetHeight],
                colorBackground: '#222222CC',
                colorStroke: '#555555', // Explicit solid stroke for inactive state
                borderRadius: 8,
            });
        }

        const toggleBounds = drawTogglePart(ctx, { posX, posY, height: mainRowHeight, value: this.value.on });
        this.hitAreas.toggle.bounds = [toggleBounds[0], posY, toggleBounds[1], mainRowHeight];
        posX += toggleBounds[1] + innerMargin;

        if (!this.value.on) {
            ctx.globalAlpha = app.canvas.editor_alpha * 0.4;
        }

        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = 'middle';
        let rposX = node.size[0] - margin - innerMargin;
        const repeatParts = drawNumberWidgetPart(ctx, {
            posX: rposX,
            posY,
            height: mainRowHeight,
            value: this.value.repeat || 1,
            direction: -1,
        });
        this.hitAreas.repeatDec.bounds = [repeatParts[0][0], posY, repeatParts[0][1], mainRowHeight];
        this.hitAreas.repeatVal.bounds = [repeatParts[1][0], posY, repeatParts[1][1], mainRowHeight];
        this.hitAreas.repeatInc.bounds = [repeatParts[2][0], posY, repeatParts[2][1], mainRowHeight];
        this.hitAreas.repeatAny.bounds = [repeatParts[0][0], posY, repeatParts[2][0] + repeatParts[2][1] - repeatParts[0][0], mainRowHeight];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        // Interpolation dropdown (Type column) - matches Draw column width
        const interpWidth = 70;
        const interpModes = ['linear', 'basis'];
        const interpIndex = interpModes.indexOf(this.value.box_interpolation || 'linear');
        const interpDisplayText = interpIndex >= 0 ? interpModes[interpIndex] : 'linear';
        ctx.textAlign = 'center';
        ctx.fillText(interpDisplayText, rposX - interpWidth / 2, posY + mainRowHeight / 2);
        this.hitAreas.interpVal.bounds = [rposX - interpWidth, posY, interpWidth, mainRowHeight];
        rposX -= interpWidth + 10;

        const keySlotWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        const keySlotX = rposX - keySlotWidth;
        const keySlotY = posY + (mainRowHeight - mainRowHeight * 0.8) / 2;
        const keySlotHeight = mainRowHeight * 0.8;
        const keyPressed = this._isButtonPressed('key');
        this._drawButtonBackground(ctx, keySlotX, keySlotY, keySlotWidth, keySlotHeight, keyPressed);
        this._drawKeyGlyph(ctx, keySlotX, keySlotY, keySlotWidth, keySlotHeight, keyPressed);
        this.hitAreas.keyButton.bounds = [keySlotX, keySlotY, keySlotWidth, keySlotHeight];
        rposX -= keySlotWidth + 10;

        const actionWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        const actionHeight = keySlotHeight;
        const actionY = keySlotY;

        const deleteX = rposX - actionWidth;
        const deletePressed = this._isButtonPressed('delete');
        this._drawTextButton(ctx, deleteX, actionY, actionWidth, actionHeight, 'Delete', deletePressed);
        this.hitAreas.deleteButton.bounds = [deleteX, actionY, actionWidth, actionHeight];
        rposX -= actionWidth + 10;

        const refOptions = this._getRefOptions();
        const refWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        const currentRef = this.value.ref_selection || 'no_ref';
        const refDisplay = refOptions.includes(currentRef) ? currentRef : 'no_ref';
        ctx.textAlign = 'center';
        ctx.fillText(refDisplay, rposX - refWidth / 2, posY + mainRowHeight / 2);
        this.hitAreas.refSelect.bounds = [rposX - refWidth, posY, refWidth, mainRowHeight];
        rposX -= refWidth + 10;

        const easingWidth = 70;
        ctx.textAlign = 'center';
        const easingModes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const easingIndex = easingModes.indexOf(this.value.easing || 'in_out');
        const easingDisplayText = easingIndex >= 0 ? easingModes[easingIndex] : 'in_out';
        ctx.fillText(easingDisplayText, rposX - easingWidth / 2, posY + mainRowHeight / 2);
        this.hitAreas.easingVal.bounds = [rposX - easingWidth, posY, easingWidth, mainRowHeight];
        rposX -= easingWidth + 10;

        const scaleParts = drawNumberWidgetPart(ctx, {
            posX: rposX,
            posY,
            height: mainRowHeight,
            value: this.value.scale || 1.0,
            direction: -1,
            precision: 2,
        });
        this.hitAreas.scaleDec.bounds = [scaleParts[0][0], posY, scaleParts[0][1], mainRowHeight];
        this.hitAreas.scaleVal.bounds = [scaleParts[1][0], posY, scaleParts[1][1], mainRowHeight];
        this.hitAreas.scaleInc.bounds = [scaleParts[2][0], posY, scaleParts[2][1], mainRowHeight];
        this.hitAreas.scaleAny.bounds = [scaleParts[0][0], posY, scaleParts[2][0] + scaleParts[2][1] - scaleParts[0][0], mainRowHeight];
        rposX -= drawNumberWidgetPart.WIDTH_TOTAL + 10;

        ctx.textAlign = 'left';
        const numberWidth = drawNumberWidgetPart.WIDTH_TOTAL;
        const drivenPosX = rposX - numberWidth / 2 - 15; // Shift driven toggle a bit to the left (by 5 pixels)
        const drivenBounds = drawTogglePart(ctx, { posX: drivenPosX, posY, height: mainRowHeight, value: this.value.driven });
        this.hitAreas.drivenToggle.bounds = [drivenBounds[0], posY, drivenBounds[1], mainRowHeight];
        rposX -= numberWidth + 10;

        ctx.textAlign = 'left';
        ctx.font = `${Math.max(12, Math.min(16, mainRowHeight * 0.45))}px Sans-Serif`;
        const nameText = fitString(ctx, this.value.name || 'Box Layer', rposX - posX - innerMargin);
        ctx.fillText(nameText, posX + innerMargin, posY + mainRowHeight / 2);
        this.hitAreas.name.bounds = [posX, posY, rposX - posX, mainRowHeight];
        this.hitAreas.name.onDown = this._onNameDown.bind(this);
        this.hitAreas.name.onClick = () => true;

        this._drawTimelineRow(ctx, node, margin, detailY, node.size[0] - margin * 2, detailRowHeight);
        this._drawLayerReorderIndicator(ctx, node, posY, widgetHeight);
        ctx.restore();
    }

    _getRefOptions() {
        return ['no_ref', 'ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
    }

    _getSelectedRefAttachmentForWidget(widget, selectionOverride = null) {
        const ref = widget?.value?.ref_attachment;
        const selection = selectionOverride || widget?.value?.ref_selection || 'no_ref';
        if (!ref || selection === 'no_ref') return null;
        if (Array.isArray(ref.entries)) {
            const parts = selection.split('_');
            const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
            const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
            return ref.entries[arrayIndex] || null;
        }
        // Support both base64 (legacy) and path (new) formats
        if (ref.base64 || ref.path) return ref;
        return null;
    }

    _drawLayerReorderIndicator(ctx, node, posY, widgetHeight) {
        try {
            const lm = this.parent?.layerManager || node?.layerManager;
            const layers = lm?.getSplineWidgets?.() || [];
            const dragging = layers.find(w => w && w._reorderDragActive);
            if (dragging) {
                const target = dragging._reorderTargetIndex ?? -1;
                const myIndex = layers.indexOf(this);
                const isLast = myIndex === (layers.length - 1);
                const showTopLine = myIndex === target && target < layers.length;
                const showBottomLine = isLast && target === layers.length;
                if (showTopLine || showBottomLine) {
                    ctx.save();
                    ctx.strokeStyle = '#2cc6ff';
                    ctx.globalAlpha = app.canvas.editor_alpha;
                    ctx.lineWidth = 2;
                    const left = 10;
                    const right = node.size[0] - 10;
                    const y = showTopLine ? (posY - 1) : (posY + widgetHeight - 1);
                    ctx.beginPath();
                    ctx.moveTo(left, y);
                    ctx.lineTo(right, y);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        } catch {}
    }

    _drawTimelineRow(ctx, node, detailX, detailY, detailWidth, detailRowHeight) {
        if (detailRowHeight <= 0) {
            this._timelineBounds = null;
            this.hitAreas.timeline.bounds = [0, 0, 0, 0];
            return;
        }
        const padding = 16;
        const labelSpace = 60;
        const playSize = Math.min(22, detailRowHeight - 4);
        const playX = detailX + padding;
        const playY = detailY + (detailRowHeight - playSize) / 2;
        const playActive = this._isPlaybackRunning();
        const playPressed = this._isButtonPressed('timelinePlay');
        ctx.save();
        this._drawButtonBackground(ctx, playX, playY, playSize, playSize, playPressed || playActive);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = `${Math.max(12, playSize * 0.72)}px Sans-Serif`;
        const icon = playActive ? this._timelinePlayIcons[1] : this._timelinePlayIcons[0];
        ctx.fillText(icon, playX + playSize / 2, playY + playSize / 2 + (playPressed ? 1 : 0));
        ctx.restore();
        this.hitAreas.timelinePlay.bounds = [playX, playY, playSize, playSize];

        const spacer = 10;
        const timelineX = playX + playSize + spacer;
        const timelineWidth = Math.max(10, detailWidth - padding * 2 - labelSpace - playSize - spacer);
        const timelineMidY = detailY + detailRowHeight * 0.5;
        const sliderSteps = this._getMaxFrames(node);
        const sliderValue = this._getTimelinePoint(node);
        const sliderProgress = sliderSteps > 1 ? (sliderValue - 1) / (sliderSteps - 1) : 0;
        const sliderPosX = timelineX + sliderProgress * timelineWidth;
        const stepWidth = sliderSteps > 1 ? timelineWidth / (sliderSteps - 1) : 0;
        const timelineEnd = timelineX + timelineWidth;

        ctx.save();
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(timelineX, timelineMidY);
        ctx.lineTo(timelineEnd, timelineMidY);
        ctx.stroke();

        ctx.fillStyle = '#777';
        for (let i = 0; i < sliderSteps; i++) {
            const x = timelineX + stepWidth * i;
            ctx.beginPath();
            ctx.arc(x, timelineMidY, i % 5 === 0 ? 2 : 1, 0, Math.PI * 2);
            ctx.fill();
        }

        const boxKeys = Array.isArray(this.value.box_keys)
            ? this.value.box_keys.slice().sort((a, b) => (a.frame || 0) - (b.frame || 0))
            : [];
        if (boxKeys.length) {
            ctx.save();
            const denom = sliderSteps > 1 ? (sliderSteps - 1) : 1;
            const currentFrame = sliderValue;
            for (const key of boxKeys) {
                const keyFrame = Math.max(1, Math.min(sliderSteps, Math.round(key.frame || 1)));
                const progress = (keyFrame - 1) / denom;
                const keyX = timelineX + progress * timelineWidth;

                // Highlight keyframe being dragged
                const isDraggingKeyframe = this._keyframeDragActive && this._keyframeDragStartFrame === keyFrame;

                if (isDraggingKeyframe) {
                    ctx.fillStyle = '#2cc6ff'; // Blue for dragged keyframe
                    ctx.strokeStyle = '#ffffff';
                    const radius = 7; // Larger radius for dragged keyframe
                    ctx.beginPath();
                    ctx.arc(keyX, timelineMidY, radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.stroke();
                } else {
                    ctx.fillStyle = '#ff8c00';
                    ctx.strokeStyle = '#ffffff';
                    const radius = currentFrame === keyFrame ? 5 : 4;
                    ctx.beginPath();
                    ctx.arc(keyX, timelineMidY, radius, 0, Math.PI * 2);
                    ctx.fill();
                    if (currentFrame === keyFrame) {
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                }
            }
            ctx.restore();
        }

        const isSliderOnKey = boxKeys.some(key => {
            const keyFrame = Math.max(1, Math.min(sliderSteps, Math.round(key.frame || 1)));
            return keyFrame === sliderValue;
        });
        ctx.fillStyle = '#2cc6ff';
        ctx.strokeStyle = isSliderOnKey ? '#2cc6ff' : '#000';
        ctx.lineWidth = 2;
        if (isSliderOnKey) {
            const sliderRadius = Math.max(5, detailRowHeight * 0.22);
            ctx.beginPath();
            ctx.arc(sliderPosX, timelineMidY, sliderRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            const innerRadius = Math.max(3, sliderRadius * 0.6);
            ctx.fillStyle = '#ff8c00';
            ctx.strokeStyle = '#2cc6ff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sliderPosX, timelineMidY, innerRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        } else {
            const sliderHalfWidth = Math.max(3, detailRowHeight * 0.12);
            const sliderHalfHeight = Math.max(8, detailRowHeight * 0.35);
            ctx.beginPath();
            ctx.rect(sliderPosX - sliderHalfWidth, timelineMidY - sliderHalfHeight, sliderHalfWidth * 2, sliderHalfHeight * 2);
            ctx.fill();
            ctx.stroke();
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        const maxLabelX = detailX + detailWidth - padding;
        const labelX = Math.min(maxLabelX, timelineEnd + padding);
        ctx.fillText(`${sliderValue}/${sliderSteps}`, labelX, timelineMidY);
        ctx.restore();

        const boundsHeight = Math.max(16, detailRowHeight - padding);
        const boundsTop = timelineMidY - boundsHeight / 2;
        this._timelineBounds = { left: timelineX, width: timelineWidth };
        this.hitAreas.timeline.bounds = [timelineX, boundsTop, timelineWidth, boundsHeight];
    }

    _drawTextButton(ctx, x, y, width, height, label, pressed = false) {
        ctx.save();
        this._drawButtonBackground(ctx, x, y, width, height, pressed);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = `${Math.max(10, Math.min(14, height * 0.4))}px Sans-Serif`;
        const yOffset = pressed ? 1.5 : 0.5;
        ctx.fillText(label, x + width / 2, y + height / 2 + yOffset);
        ctx.restore();
    }

    _drawButtonBackground(ctx, x, y, width, height, active) {
        ctx.save();
        ctx.fillStyle = active ? '#0d3b4a' : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = active ? '#2cc6ff' : LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, [6]);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    _drawKeyGlyph(ctx, x, y, width, height, pressed = false) {
        const label = '🗝';
        ctx.save();
        ctx.fillStyle = '#f1c40f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fontSize = Math.max(16, Math.min(width, height) * 0.65);
        ctx.font = `${fontSize}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
        const yOffset = pressed ? 2 : 1;
        ctx.fillText(label, x + width / 2, y + height / 2 + yOffset);
        ctx.restore();
    }

    onMouseDown(event, pos, node) {
        return super.onMouseDown?.(event, pos, node);
    }

    onMouseUp(event, pos, node) {
        // Finalize keyframe drag if active
        if (this._keyframeDragActive && this._keyframeDragStartFrame !== null) {
            const editor = node?.editor;
            const targetFrame = this._calculateTimelinePoint(node, pos[0]);

            if (targetFrame != null && editor?.moveBoxLayerKey) {
                // Move the keyframe (this will overwrite any existing keyframe at target)
                editor.moveBoxLayerKey(this, this._keyframeDragStartFrame, targetFrame);
            }

            // Reset drag state
            this._keyframeDragActive = false;
            this._keyframeDragStartFrame = null;

            if (node?.editor?.clearBoxTimelinePreview) {
                node.editor.clearBoxTimelinePreview(this);
            }
            node?.setDirtyCanvas?.(true, true);
        }

        if (node?.editor?.clearBoxTimelinePreview) {
            node.editor.clearBoxTimelinePreview(this);
        }
        this._timelineDragging = false;
        this._timelinePreviewMode = false;
        return super.onMouseUp?.(event, pos, node);
    }

    onToggleDown(event, pos, node) {
        this.value.on = !this.value.on;
        this.cancelMouseDown();
        node.setDirtyCanvas(true, true);
        return true;
    }

    onRepeatDec() {
        this.value.repeat = Math.max(1, (this.value.repeat || 1) - 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onRepeatInc() {
        this.value.repeat = Math.min(20, (this.value.repeat || 1) + 1);
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onRepeatClick() {
        const canvas = app.canvas;
        canvas.prompt('Repeat', this.value.repeat || 1, (v) => {
            this.value.repeat = Math.max(1, Math.min(20, Number(v)));
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }
    onRepeatMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.repeat = Math.max(1, Math.min(20, (this.value.repeat || 1) + Math.round(event.deltaX / 10)));
            node.setDirtyCanvas(true, true);
        }
    }

    onEasingClick() {
        const modes = ['linear', 'in', 'out', 'in_out', 'out_in'];
        const currentIndex = modes.indexOf(this.value.easing || 'in_out');
        const newIndex = (currentIndex + 1) % modes.length;
        this.value.easing = modes[newIndex];
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onEasingRightDown(event, pos, node) {
        showCustomEasingMenu(event, this, { x: event?.clientX ?? pos[0], y: event?.clientY ?? pos[1] });
        return true;
    }

    onDrivenToggleDown(event, pos, node) {
        toggleDrivenState(this);
        node.setDirtyCanvas(true, true);
        return true;
    }
    onDrivenToggleRightDown(event, pos, node) {
        prepareDrivenMenu(this);
        showCustomDrivenToggleMenu(event, this, { x: pos[0], y: pos[1] });
        return true;
    }

    onScaleDec() {
        this.value.scale = Math.max(0.01, parseFloat((this.value.scale || 1.00) - 0.01).toFixed(2));
        this._updatePointsStoreWithCurrentScale();
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onScaleInc() {
        this.value.scale = Math.min(8.00, parseFloat((this.value.scale || 1.00) + 0.01).toFixed(2));
        this._updatePointsStoreWithCurrentScale();
        this.parent.setDirtyCanvas(true, true);
        return true;
    }
    onScaleClick() {
        const canvas = app.canvas;
        canvas.prompt('Scale', this.value.scale || 1.00, (v) => {
            this.value.scale = Math.max(0.01, Math.min(8.00, parseFloat(Number(v).toFixed(2))));
            this._updatePointsStoreWithCurrentScale();
            this.parent.setDirtyCanvas(true, true);
        });
        return true;
    }
    onScaleMove(event, pos, node) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.value.scale = Math.max(0.01, Math.min(8.00, parseFloat(((this.value.scale || 1.00) + (event.deltaX / 1000)).toFixed(2))));
            this._updatePointsStoreWithCurrentScale();
            node.setDirtyCanvas(true, true);
        }
    }

    _updatePointsStoreWithCurrentScale() {
        // Update points_store with the current scale value so keyframes use the latest scale
        try {
            let points = [];
            try {
                points = JSON.parse(this.value.points_store || '[]');
            } catch {
                points = [];
            }

            if (points && points.length > 0) {
                // Update all scale fields in points_store with current scale value
                const currentScale = parseFloat(this.value.scale || 1.00);
                points.forEach(point => {
                    point.scale = currentScale;
                    point.boxScale = currentScale;
                    point.pointScale = currentScale;
                });
                this.value.points_store = JSON.stringify(points);
            }
        } catch (e) {
            console.warn('Failed to update points_store with current scale:', e);
        }
    }

    onKeyClick(event, pos, node) {
        this._triggerButtonPress('key', node);
        this._activateLayer(node);
        if (node?.editor?.addBoxLayerKey) {
            node.editor.addBoxLayerKey(this, this._getTimelinePoint(node));
            node?.setDirtyCanvas?.(true, true);
        } else {
            console.warn('BoxLayer key operation not wired yet.');
        }
        return true;
    }

    onInterpClick(event, pos, node) {
        const x = event?.clientX ?? 100;
        const y = event?.clientY ?? 100;
        showInterpolationMenu(event, this, { x, y });
        return true;
    }

    onClearAllClick(event, pos, node) {
        this._activateLayer(node);
        if (node?.editor?.clearBoxLayerKeys) {
            node.editor.clearBoxLayerKeys(this);
        } else {
            console.warn('BoxLayer clear all not wired yet.');
        }
        return true;
    }

    onDeleteClick(event, pos, node) {
        this._triggerButtonPress('delete', node);
        this._activateLayer(node);
        if (node?.editor?.deleteBoxLayerKey) {
            const removed = node.editor.deleteBoxLayerKey(this, this._getTimelinePoint(node));
            if (!removed) {
                console.warn('No box key exists at this frame to delete.');
            }
        } else {
            console.warn('BoxLayer delete not wired yet.');
        }
        return true;
    }

    onRefSelectClick(event, pos, node) {
        const host = node || this.parent;
        if (!host) return true;
        const x = event?.clientX ?? 100;
        const y = event?.clientY ?? 100;
        showRefSelectionMenu(event, this, { x, y }, async (selection) => {
            const next = selection || 'no_ref';
            this.value.ref_selection = next;

            // Activate this layer first so the attachment goes to the correct widget
            this._activateLayer(host);

            // Clear ref image cache to force reload with new data
            host.editor?.layerRenderer?.clearRefImageCache?.();

            if (next === 'no_ref') {
                host.refImageManager?.clearRefImageFromActiveBoxLayer?.();
            } else {
                // Always refresh images from connected node to pick up any changes
                await host.refImageManager?.attachRefImageToActiveBoxLayer?.(next);
            }
            try {
                const keyId = host.id ?? host.uuid;
                const key = keyId ? `spline-editor-boxref-${keyId}-${this.value.name || this.name || 'box'}` : null;
                if (key) {
                    sessionStorage.setItem(key, JSON.stringify({
                        attachment: this.value.ref_attachment,
                        selection: this.value.ref_selection,
                    }));
                }
            } catch {}
            host.editor?.layerRenderer?.render?.();
            host.setDirtyCanvas?.(true, true);
        });
        return true;
    }
    onTimelinePlayClick(event, pos, node) {
        this._triggerButtonPress('timelinePlay', node || this.parent);
        if (this._isPlaybackRunning()) {
            this.stopBoxPlayback(node);
        } else {
            this.startBoxPlayback(node);
        }
        return true;
    }

    onTimelineDown(event, pos, node) {
        if (!this._timelineBounds) return false;
        if (this._isPlaybackRunning()) {
            this.stopBoxPlayback(node);
        }
        this._activateLayer(node);
        const editor = node?.editor;

        if (event?.button === 0 && editor?.isShortcutActive?.('s')) {
            event.preventDefault?.();
            event.stopPropagation?.();
            const targetFrame = this._calculateTimelinePoint(node, pos[0]);
            if (targetFrame != null) {
                if (this._hasKeyAtFrame(node, targetFrame)) {
                    if (editor?.deleteBoxLayerKey) {
                        editor.deleteBoxLayerKey(this, targetFrame);
                    } else {
                        this._applyTimelineFrame(node, targetFrame);
                    }
                } else if (editor?.addBoxLayerKey) {
                    editor.addBoxLayerKey(this, targetFrame);
                } else {
                    this._applyTimelineFrame(node, targetFrame);
                }
                this._timelineDragging = false;
                this._timelinePreviewMode = false;
                editor?.clearBoxTimelinePreview?.(this);
                node?.setDirtyCanvas?.(true, true);
                return true;
            }
        }

        // D+Click: Start dragging a keyframe
        if (event?.button === 0 && editor?.isShortcutActive?.('d')) {
            event.preventDefault?.();
            event.stopPropagation?.();
            const targetFrame = this._calculateTimelinePoint(node, pos[0]);
            if (targetFrame != null && this._hasKeyAtFrame(node, targetFrame)) {
                // Start dragging this keyframe
                this._keyframeDragActive = true;
                this._keyframeDragStartFrame = targetFrame;
                this._timelineDragging = false;
                this._timelinePreviewMode = false;
                editor?.clearBoxTimelinePreview?.(this);
                node?.setDirtyCanvas?.(true, true);
                return true;
            }
            // If D+click but not on a keyframe, fall through to normal timeline behavior
        }

        if (event?.button === 2) {
            const targetFrame = this._getTimelinePoint(node);
            if (this._hasKeyAtFrame(node, targetFrame) && node?.editor?.deleteBoxLayerKey) {
                event.preventDefault?.();
                event.stopPropagation?.();
                node.editor.deleteBoxLayerKey(this, targetFrame);
                node?.setDirtyCanvas?.(true, true);
                return true;
            }
            return false;
        }

        this._timelineDragging = true;
        this._timelinePreviewMode = !!(event && event.button === 0 && event.shiftKey);
        if (!this._timelinePreviewMode && node?.editor?.clearBoxTimelinePreview) {
            node.editor.clearBoxTimelinePreview(this);
        }
        this._setTimelinePointFromPosition(pos[0], node, !this._timelinePreviewMode);
        return true;
    }

    onTimelineMove(event, pos, node) {
        // Handle keyframe dragging (D+drag)
        if (this._keyframeDragActive && this._keyframeDragStartFrame !== null) {
            const newFrame = this._calculateTimelinePoint(node, pos[0]);
            if (newFrame != null && newFrame !== this._keyframeDragStartFrame) {
                // Preview: update the keyframe position temporarily
                this._previewKeyframeMove(node, this._keyframeDragStartFrame, newFrame);
            }
            return true;
        }

        if (!this._timelineDragging) return false;
        this._setTimelinePointFromPosition(pos[0], node, !this._timelinePreviewMode);
        return true;
    }

    computeSize(width) {
        const baseHeight = LiteGraph.NODE_WIDGET_HEIGHT;
        return [width, baseHeight * 2];
    }

    serializeValue(node, index) {
        return JSON.parse(JSON.stringify(this.value));
    }

    _activateLayer(node) {
        if (node?.layerManager) {
            try { node.layerManager.setActiveWidget(this); } catch {}
        }
    }

    _applyTimelineFrame(node, frame) {
        const clamped = Math.max(1, Math.min(this._getMaxFrames(node), Math.round(frame || 1)));
        this.value.box_timeline_point = clamped;
        if (node?.editor?.applyBoxTimelineFrame) {
            node.editor.applyBoxTimelineFrame(this, clamped);
        }
        node?.setDirtyCanvas?.(true, true);
    }

    _getTimelinePoint(node) {
        const steps = this._getMaxFrames(node);
        const value = Number(this.value?.box_timeline_point) || 1;
        const clamped = Math.max(1, Math.min(steps, Math.round(value)));
        if (this.value.box_timeline_point !== clamped) {
            this.value.box_timeline_point = clamped;
        }
        return clamped;
    }

    _hasKeyAtFrame(node, frame) {
        if (!Array.isArray(this.value.box_keys)) {
            return false;
        }
        const target = Math.max(1, Math.min(this._getMaxFrames(node), Math.round(frame || 1)));
        return this.value.box_keys.some(key => {
            const keyFrame = Math.max(1, Math.min(this._getMaxFrames(node), Math.round(key?.frame || 1)));
            return keyFrame === target;
        });
    }

    _calculateTimelinePoint(node, posX) {
        if (!this._timelineBounds) return null;
        const { left, width } = this._timelineBounds;
        if (width <= 0) return null;
        const ratio = Math.min(1, Math.max(0, (posX - left) / width));
        const steps = this._getMaxFrames(node);
        return Math.round(ratio * (steps - 1)) + 1;
    }

    _setTimelinePointFromPosition(posX, node, shouldApply = true) {
        const newPoint = this._calculateTimelinePoint(node, posX);
        if (newPoint == null) return;
        if (shouldApply) {
            if (node?.editor?.clearBoxTimelinePreview) {
                node.editor.clearBoxTimelinePreview(this);
            }
            this._applyTimelineFrame(node, newPoint);
        } else {
            if (newPoint !== this.value.box_timeline_point) {
                this.value.box_timeline_point = newPoint;
                node?.setDirtyCanvas?.(true, true);
            }
            if (node?.editor?.setBoxTimelinePreview) {
                node.editor.setBoxTimelinePreview(this, newPoint);
            }
        }
    }

    _beginLayerReorderDrag(pointerDownEvent, node) {
        try { node.layerManager?.setActiveWidget(this); } catch {}
        const splines = node.layerManager?.getSplineWidgets?.() || [];
        const startIndex = splines.indexOf(this);
        if (startIndex < 0) return;

        this._reorderDragActive = true;
        this._reorderStartIndex = startIndex;
        this._reorderTargetIndex = startIndex;
        this._reorderStartClientY = pointerDownEvent.clientY;

        this._prevBodyCursor = document.body.style.cursor;
        document.body.style.cursor = 'grabbing';
        try { app.canvas.canvas.style.cursor = 'grabbing'; } catch {}

        const onMove = (e) => {
            if (!this._reorderDragActive) return;
            const dy = (e.clientY - this._reorderStartClientY) || 0;
            const step = Math.round(dy / (LiteGraph.NODE_WIDGET_HEIGHT || 24));
            let idx = this._reorderStartIndex + step;
            idx = Math.max(0, Math.min(splines.length, idx));
            if (idx !== this._reorderTargetIndex) {
                this._reorderTargetIndex = idx;
            }
            try { node.setDirtyCanvas(true, true); } catch {}
        };
        const onUp = (e) => {
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            try { app.canvas.canvas.style.cursor = ''; } catch {}
            document.body.style.cursor = this._prevBodyCursor || '';

            if (!this._reorderDragActive) return;
            this._reorderDragActive = false;

            const splinesNow = node.layerManager?.getSplineWidgets?.() || [];
            const from = splinesNow.indexOf(this);
            let to = this._reorderTargetIndex ?? from;
            if (from >= 0 && to >= 0 && from !== to) {
                const widgets = node.widgets;
                const before = to < splinesNow.length ? splinesNow[to] : undefined;
                const fromGlobal = widgets.indexOf(this);
                if (fromGlobal >= 0) {
                    widgets.splice(fromGlobal, 1);
                    if (before) {
                        const targetGlobal = widgets.indexOf(before);
                        if (targetGlobal >= 0) {
                            widgets.splice(targetGlobal, 0, this);
                        } else {
                            const afterRemovalSplines = node.layerManager?.getSplineWidgets?.() || [];
                            const last = afterRemovalSplines[afterRemovalSplines.length - 1];
                            const lastIdx = last ? widgets.indexOf(last) : -1;
                            const insertAfter = lastIdx >= 0 ? lastIdx + 1 : widgets.length;
                            widgets.splice(insertAfter, 0, this);
                        }
                    } else {
                        const afterRemovalSplines = node.layerManager?.getSplineWidgets?.() || [];
                        const last = afterRemovalSplines[afterRemovalSplines.length - 1];
                        const lastIdx = last ? widgets.indexOf(last) : -1;
                        const insertAfter = lastIdx >= 0 ? lastIdx + 1 : widgets.length;
                        widgets.splice(insertAfter, 0, this);
                    }
                    try { node.layerManager?.setActiveWidget(this); } catch {}
                    try { node.setDirtyCanvas(true, true); } catch {}
                }
            }
            this._reorderStartIndex = undefined;
            this._reorderTargetIndex = undefined;
            this._reorderStartClientY = undefined;
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
    }

    _onNameDown(event, boundsPos, node) {
        if (!node?.layerManager) return false;
        if (event?.button === 2) {
            this._showContextMenu(event, node);
            return true;
        }
        if (event && event.shiftKey && event.button === 0) {
            try {
                this._beginLayerReorderDrag(event, node);
                return true;
            } catch (e) {
                console.warn('Failed to start reorder drag', e);
            }
        }
        const current = node.layerManager.getActiveWidget?.();
        if (current === this) {
            node.layerManager.setActiveWidget(null);
        } else {
            node.layerManager.setActiveWidget(this);
        }
        return true;
    }

    _showContextMenu(event, node) {
        try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}
        const menuEl = node?.contextMenu;
        if (!menuEl) return;
        const activeWidget = node.layerManager?.getActiveWidget?.();
        const isHanddraw = !!(activeWidget && activeWidget.value && activeWidget.value.type === 'handdraw');
        const firstItem = node.menuItems && node.menuItems[0];
        const smoothItem = node.menuItems && node.menuItems[1];
        if (firstItem) {
            firstItem.textContent = isHanddraw ? 'Edit' : 'Invert point order';
        }
        if (smoothItem) {
            smoothItem.style.display = isHanddraw ? 'block' : 'none';
        }
        menuEl.style.display = 'block';
        menuEl.style.left = `${event?.clientX ?? 0}px`;
        menuEl.style.top = `${event?.clientY ?? 0}px`;
        menuEl.oncontextmenu = (evt) => { evt.preventDefault?.(); evt.stopPropagation?.(); };
        const hideOnOutside = (ev) => {
            const target = ev && ev.target;
            const withinDialog = target && (target.closest?.('.litegraph .dialog') || target.closest?.('.litegraph.liteprompt') || target.closest?.('.litedialog'));
            if (withinDialog) return;
            if (!menuEl.contains(target)) {
                menuEl.style.display = 'none';
                cleanup();
            }
        };
        const preventBrowserMenu = (ev) => { ev.preventDefault?.(); };
        const onEsc = (ev) => {
            if (ev.key === 'Escape') {
                menuEl.style.display = 'none';
                cleanup();
            }
        };
        const cleanup = () => {
            document.removeEventListener('mousedown', hideOnOutside, true);
            document.removeEventListener('contextmenu', hideOnOutside, true);
            document.removeEventListener('contextmenu', preventBrowserMenu, true);
            document.removeEventListener('keydown', onEsc, true);
            if (menuEl.contains(clearEntry)) {
                clearEntry.remove();
            }
        };
        const clearEntryId = 'box-layer-clear-entry';
        let clearEntry = menuEl.querySelector(`[data-box-clear]`);
        if (clearEntry) {
            clearEntry.remove();
        }
        clearEntry = document.createElement('a');
        clearEntry.href = '#';
        clearEntry.dataset.boxClear = '1';
        clearEntry.textContent = 'Clear All Keys';
        clearEntry.style.display = 'block';
        clearEntry.style.padding = '5px';
        clearEntry.style.color = '#FFF';
        clearEntry.style.fontFamily = 'Arial, sans-serif';
        clearEntry.style.fontSize = '14px';
        clearEntry.style.textDecoration = 'none';
        clearEntry.style.backgroundColor = '#1d1d1d';
        clearEntry.addEventListener('mouseenter', () => clearEntry.style.backgroundColor = '#303030');
        clearEntry.addEventListener('mouseleave', () => clearEntry.style.backgroundColor = '#1d1d1d');
        clearEntry.addEventListener('click', (evt) => {
            evt.preventDefault?.();
            this.onClearAllClick?.(event, null, node);
            menuEl.style.display = 'none';
            cleanup();
        });
        menuEl.appendChild(clearEntry);
        setTimeout(() => {
            document.addEventListener('mousedown', hideOnOutside, true);
            document.addEventListener('contextmenu', hideOnOutside, true);
            document.addEventListener('contextmenu', preventBrowserMenu, true);
            document.addEventListener('keydown', onEsc, true);
        }, 0);
    }

    _moveLayer(node, direction) {
        const manager = node?.layerManager;
        if (!manager || typeof manager.swapSplineWidgets !== 'function') return;
        try { manager.swapSplineWidgets(this, direction); } catch {}
    }

    _triggerButtonPress(name, node) {
        if (!name) return;
        this._buttonPressTimes[name] = performance.now();
        node?.setDirtyCanvas?.(true, true);
        const duration = this._buttonPressDurationMs;
        if (duration && duration > 0) {
            setTimeout(() => {
                node?.setDirtyCanvas?.(true, true);
            }, duration);
        }
    }

    _isButtonPressed(name) {
        if (!name) return false;
        const t = this._buttonPressTimes[name];
        if (!t) return false;
        return (performance.now() - t) < this._buttonPressDurationMs;
    }

    _isPlaybackRunning() {
        return !!this._playbackInterval;
    }

    startBoxPlayback(node) {
        if (this._playbackInterval) {
            this.stopBoxPlayback(node);
        }
        const editor = node?.editor;
        const fps = 25;
        const intervalMs = Math.max(10, Math.round(1000 / fps));
        const advanceFrame = () => {
            const max = this._getMaxFrames(node);
            const current = this._getTimelinePoint(node);
            const next = current >= max ? 1 : current + 1;
            editor?.applyBoxTimelineFrame?.(this, next);
            node?.setDirtyCanvas?.(true, true);
        };
        this._playbackInterval = setInterval(advanceFrame, intervalMs);
        node?.setDirtyCanvas?.(true, true);
    }

    stopBoxPlayback(node) {
        if (this._playbackInterval) {
            clearInterval(this._playbackInterval);
            this._playbackInterval = null;
            node?.setDirtyCanvas?.(true, true);
        }
    }

    _previewKeyframeMove(node, fromFrame, toFrame) {
        // Create a temporary preview of the keyframe at the new position
        // This updates the timeline point and shows what the move would look like
        const editor = node?.editor;
        if (!editor) return;

        const maxFrames = this._getMaxFrames(node);
        const toFrameClamped = Math.max(1, Math.min(maxFrames, Math.round(toFrame)));

        // Update timeline point to show preview
        this.value.box_timeline_point = toFrameClamped;

        // Use the preview system to show what the box would look like at the new frame
        if (editor?.setBoxTimelinePreview) {
            editor.setBoxTimelinePreview(this, toFrameClamped);
        }

        node?.setDirtyCanvas?.(true, true);
    }

}
