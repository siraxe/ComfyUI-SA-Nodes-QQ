
import { app } from "../../../scripts/app.js";
import { loraPatternMatcher } from "./lora_pattern_matcher.js";

// From rgthree/src_web/comfyui/utils_canvas.ts

export function fitString(ctx, str, maxWidth) {
    let width = ctx.measureText(str).width;
    const ellipsis = "…";
    const ellipsisWidth = ctx.measureText(ellipsis).width;
    if (width <= maxWidth || width <= ellipsisWidth) {
        return str;
    }
    let len = str.length;
    while (width >= maxWidth - ellipsisWidth && len-- > 0) {
        str = str.substring(0, len);
        width = ctx.measureText(str).width;
    }
    return str + ellipsis;
}

export function isLowQuality() {
    return app.canvas.ds.scale <= 0.5;
}

export function drawRoundedRectangle(ctx, pos, size, borderRadius) {
    const lowQuality = isLowQuality();
    ctx.save();
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
    ctx.beginPath();
    ctx.roundRect(pos[0], pos[1], size[0], size[1], lowQuality ? [0] : [borderRadius]);
    ctx.fill();
    if (!lowQuality) {
        ctx.stroke();
    }
    ctx.restore();
}

export function drawTogglePart(ctx, pos, height, value) {
    const lowQuality = isLowQuality();
    ctx.save();

    const toggleRadius = height * 0.36;
    const toggleBgWidth = height * 1.5;

    if (!lowQuality) {
        ctx.beginPath();
        ctx.roundRect(pos[0] + 4, pos[1] + 4, toggleBgWidth - 8, height - 8, [height * 0.5]);
        ctx.globalAlpha = app.canvas.editor_alpha * 0.25;
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fill();
        ctx.globalAlpha = app.canvas.editor_alpha;
    }

    ctx.fillStyle = value === true ? "#89B" : "#888";
    const toggleX = lowQuality || value === false ? pos[0] + height * 0.5 : value === true ? pos[0] + height : pos[0] + height * 0.75;
    ctx.beginPath();
    ctx.arc(toggleX, pos[1] + height * 0.5, toggleRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    return [pos[0], toggleBgWidth];
}

export function drawWidgetButton(ctx, pos, size, text, isMouseDownedAndOver) {
    const borderRadius = isLowQuality() ? 0 : 4;
    ctx.save();

    if (!isLowQuality() && !isMouseDownedAndOver) {
        drawRoundedRectangle(ctx, [pos[0] + 1, pos[1] + 1], [size[0] - 2, size[1]], borderRadius);
    }

    drawRoundedRectangle(ctx, [pos[0], pos[1] + (isMouseDownedAndOver ? 1 : 0)], size, borderRadius);

    if (!isLowQuality()) {
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(text, pos[0] + size[0] / 2, pos[1] + size[1] / 2 + (isMouseDownedAndOver ? 1 : 0));
    }
    ctx.restore();
}

// From rgthree/src_web/comfyui/utils_widgets.ts

export class RgthreeBaseWidget {
    constructor(name) {
        this.name = name;
        this.type = "custom";
        this.options = {};
        this.y = 0;
        this.last_y = 0;
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.hitAreas = {};
        this.downedHitAreasForMove = [];
        this.downedHitAreasForClick = [];
    }

    serializeValue(node, index) {
        return this.value;
    }

    clickWasWithinBounds(pos, bounds) {
        let xStart = bounds[0];
        let xEnd = xStart + (bounds.length > 2 ? bounds[2] : bounds[1]);
        const clickedX = pos[0] >= xStart && pos[0] <= xEnd;
        if (bounds.length === 2) {
            return clickedX;
        }
        return clickedX && pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3];
    }

    mouse(event, pos, node) {
        if (event.type == "pointerdown") {
            this.mouseDowned = [...pos];
            this.isMouseDownedAndOver = true;
            this.downedHitAreasForMove.length = 0;
            this.downedHitAreasForClick.length = 0;
            let anyHandled = false;
            for (const part of Object.values(this.hitAreas)) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    if (part.onMove) {
                        this.downedHitAreasForMove.push(part);
                    }
                    if (part.onClick) {
                        this.downedHitAreasForClick.push(part);
                    }
                    if (part.onDown) {
                        const thisHandled = part.onDown.apply(this, [event, pos, node, part]);
                        anyHandled = anyHandled || thisHandled == true;
                    }
                    part.wasMouseClickedAndIsOver = true;
                }
            }
            return this.onMouseDown(event, pos, node) || anyHandled;
        }
        if (event.type == "pointerup") {
            if (!this.mouseDowned) return true;
            this.downedHitAreasForMove.length = 0;
            const wasMouseDownedAndOver = this.isMouseDownedAndOver;
            this.cancelMouseDown();
            let anyHandled = false;
            for (const part of Object.values(this.hitAreas)) {
                if (part.onUp && this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onUp.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
                part.wasMouseClickedAndIsOver = false;
            }
            for (const part of this.downedHitAreasForClick) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    const thisHandled = part.onClick.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled == true;
                }
            }
            this.downedHitAreasForClick.length = 0;
            if (wasMouseDownedAndOver) {
                const thisHandled = this.onMouseClick(event, pos, node);
                anyHandled = anyHandled || thisHandled == true;
            }
            return this.onMouseUp(event, pos, node) || anyHandled;
        }
        if (event.type == "pointermove") {
            this.isMouseDownedAndOver = !!this.mouseDowned;
            if (this.mouseDowned && (pos[0] < 15 || pos[0] > node.size[0] - 15 || pos[1] < this.last_y || pos[1] > this.last_y + LiteGraph.NODE_WIDGET_HEIGHT)) {
                this.isMouseDownedAndOver = false;
            }
            for (const part of Object.values(this.hitAreas)) {
                if (this.downedHitAreasForMove.includes(part)) {
                    part.onMove.apply(this, [event, pos, node, part]);
                }
                if (this.downedHitAreasForClick.includes(part)) {
                    part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
                }
            }
            // Always call onMouseMove for hover detection
            this.onMouseMove(event, pos, node);
            return true;
        }
        return false;
    }

    cancelMouseDown() {
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.downedHitAreasForMove.length = 0;
    }

    onMouseDown(event, pos, node) { return false; }
    onMouseUp(event, pos, node) { return false; }
    onMouseClick(event, pos, node) { return false; }
    onMouseMove(event, pos, node) { return true; }
}

export class RgthreeBetterButtonWidget extends RgthreeBaseWidget {
    constructor(name, callback, label) {
        super(name);
        this.callback = callback;
        this.label = label || name;
        this.value = "";
    }

    draw(ctx, node, width, y, height) {
        drawWidgetButton(ctx, [15, y], [width - 30, height], this.label, this.isMouseDownedAndOver);
    }

    onMouseClick(event, pos, node) {
        return this.callback(event, pos, node);
    }
}

export class RgthreeDividerWidget extends RgthreeBaseWidget {
    constructor(options) {
        super("divider");
        this.value = {};
        this.options = { serialize: false };
        this.widgetOptions = {
            marginTop: 7,
            marginBottom: 7,
            marginLeft: 15,
            marginRight: 15,
            color: LiteGraph.WIDGET_OUTLINE_COLOR,
            thickness: 1,
            ...(options || {}),
        };
    }

    draw(ctx, node, width, y, h) {
        if (this.widgetOptions.thickness) {
            ctx.strokeStyle = this.widgetOptions.color;
            const x = this.widgetOptions.marginLeft;
            const y2 = y + this.widgetOptions.marginTop;
            const w = width - this.widgetOptions.marginLeft - this.widgetOptions.marginRight;
            ctx.stroke(new Path2D(`M ${x} ${y2} h ${w}`));
        }
    }

    computeSize(width) {
        return [width, this.widgetOptions.marginTop + this.widgetOptions.marginBottom + this.widgetOptions.thickness];
    }
}

const STRENGTH_WIDTH = 60;
const ICON_WIDTH = 20;
const MARGIN = 10;

export class StrengthCopyWidget extends RgthreeBaseWidget {
    constructor(showOutputBoth = true, showCopyButtons = true) {
        super("StrengthCopyWidget");
        this.showOutputBoth = showOutputBoth;
        this.showCopyButtons = showCopyButtons;
        this.value = {};
        this.hitAreas = {
            output_both_toggle: { bounds: [0, 0] },
            high_to_low_button: { bounds: [0, 0] },
            low_to_high_button: { bounds: [0, 0] },
        };
        this.highToLowPressed = false;
        this.lowToHighPressed = false;
    }

    draw(ctx, node, w, posY, height) {
        // Ensure property exists (off by default)
        if (!node.properties) node.properties = {};
        if (node.properties['output_both'] === undefined) node.properties['output_both'] = false;

        // Constants
        const margin = 20;
        const buttonWidth = 25;
        const buttonHeight = height;
        const buttonSpacing = 36;
        const rightOffset = 25;
        const innerMargin = 8;
        const toggleSpacing = 15; // Extra spacing between toggle and buttons

        // Calculated values
        const midY = posY + height * 0.5;
        const totalButtonsWidth = this.showCopyButtons ? (buttonWidth * 2) + buttonSpacing : 0;

        ctx.save();
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;

        // Draw ">" button (high to low) and "<" button (low to high)
        if (this.showCopyButtons) {
            const rightX = w - margin - totalButtonsWidth - rightOffset;
            const highToLowX = rightX;
            drawWidgetButton(ctx, [highToLowX, posY], [buttonWidth, buttonHeight], ">", this.highToLowPressed);
            this.hitAreas['high_to_low_button'].bounds = [highToLowX, buttonWidth];

            const lowToHighX = rightX + buttonWidth + buttonSpacing;
            drawWidgetButton(ctx, [lowToHighX, posY], [buttonWidth, buttonHeight], "<", this.lowToHighPressed);
            this.hitAreas['low_to_high_button'].bounds = [lowToHighX, buttonWidth];
        } else {
            this.hitAreas['high_to_low_button'].bounds = [0, 0];
            this.hitAreas['low_to_high_button'].bounds = [0, 0];
        }

        // Draw "Output both" toggle
        if (this.showOutputBoth) {
            let posX = w - margin - totalButtonsWidth - rightOffset - toggleSpacing;
            const outputBothValue = node.properties['output_both'] || false;
            // Draw label and toggle from right to left
            const toggleBounds = drawTogglePart(ctx, [posX - height * 1.5, posY], height, outputBothValue);
            this.hitAreas['output_both_toggle'].bounds = toggleBounds;
            const labelText = "Output both";
            ctx.fillText(labelText, posX - height * 1.5 - ctx.measureText(labelText).width - innerMargin, midY);
        } else {
            this.hitAreas['output_both_toggle'].bounds = [0, 0];
        }

        ctx.restore();
    }

    onMouseDown(event, pos, node) {
        // Ensure property exists
        if (!node.properties) node.properties = {};
        if (node.properties['output_both'] === undefined) node.properties['output_both'] = false;

        if (this.clickWasWithinBounds(pos, this.hitAreas.output_both_toggle.bounds)) {
            node.properties['output_both'] = !node.properties['output_both'];
            // Also sync to hidden widget for Python to read
            const outputBothWidget = node.widgets.find(w => w.name === "output_both");
            if (outputBothWidget) {
                outputBothWidget.value = node.properties['output_both'];
            }
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        }
        if (this.clickWasWithinBounds(pos, this.hitAreas.high_to_low_button.bounds)) {
            this.highToLowPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        }
        if (this.clickWasWithinBounds(pos, this.hitAreas.low_to_high_button.bounds)) {
            this.lowToHighPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        }
        return false;
    }

    onMouseUp(event, pos, node) {
        if (this.highToLowPressed && this.clickWasWithinBounds(pos, this.hitAreas.high_to_low_button.bounds)) {
            this.copyHighToLowStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
        }
        if (this.lowToHighPressed && this.clickWasWithinBounds(pos, this.hitAreas.low_to_high_button.bounds)) {
            this.copyLowToHighStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
        }
        this.highToLowPressed = false;
        this.lowToHighPressed = false;
        return super.onMouseUp(event, pos, node);
    }

    copyHighToLowStrengths(node) {
        // Copy high strength values to low strength values (> button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.low_strength = widget.value.strength || 1;
            }
        }
    }

    copyLowToHighStrengths(node) {
        // Copy low strength values to high strength values (< button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.strength = widget.value.low_strength || 1;
                // Also update strengthTwo if in model/clip mode
                if (widget.showModelAndClip && widget.value.strengthTwo !== undefined) {
                    widget.value.strengthTwo = widget.value.low_strength || 1;
                }
            }
        }
    }

    serializeValue(node, index) {
        // Ensure output_both property exists and is synchronized
        if (!node.properties) node.properties = {};
        if (node.properties['output_both'] === undefined) node.properties['output_both'] = false;
        // Return the value to ensure it's serialized
        node.properties['output_both'] = node.properties['output_both'] || false;
        return {};
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

export class CombinedOptionsWidget extends RgthreeBaseWidget {
    constructor() {
        super("CombinedOptionsWidget");
        this.value = {};
        this.optionsHitAreas = {
            low_mem_toggle: { bounds: [0, 0] },
            merge_loras_toggle: { bounds: [0, 0] },
            overwrite_toggle: { bounds: [0, 0] },
        };
        this.copyHitAreas = {
            high_to_low_button: { bounds: [0, 0] },
            low_to_high_button: { bounds: [0, 0] },
        };
        this.highToLowPressed = false;
        this.lowToHighPressed = false;
    }

    serializeValue(node, index) {
        if (!node.properties) node.properties = {};
        if (node.properties['low_mem_load'] === undefined) node.properties['low_mem_load'] = true;
        if (node.properties['merge_loras'] === undefined) node.properties['merge_loras'] = false;
        if (node.properties['overwrite_duplicates'] === undefined) node.properties['overwrite_duplicates'] = false;

        const value = {
            low_mem_load: node.properties['low_mem_load'] || false,
            merge_loras: node.properties['merge_loras'] === true ? true : false,
            overwrite_duplicates: node.properties['overwrite_duplicates'] || false
        };
        
        // Update node properties to ensure they're in sync
        node.properties['low_mem_load'] = value.low_mem_load;
        node.properties['merge_loras'] = value.merge_loras;
        node.properties['overwrite_duplicates'] = value.overwrite_duplicates;
        
        return value;
    }

    draw(ctx, node, w, posY, height) {
        // Ensure properties exist
        if (!node.properties) node.properties = {};
        if (node.properties['low_mem_load'] === undefined) node.properties['low_mem_load'] = true;
        if (node.properties['merge_loras'] === undefined) node.properties['merge_loras'] = false;
        if (node.properties['overwrite_duplicates'] === undefined) node.properties['overwrite_duplicates'] = false;

        // Calculate column widths
        const optionsWidth = w * 0.65;
        const copyWidth = w * 0.35;
        
        // Draw divider between columns
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.moveTo(optionsWidth, posY);
        ctx.lineTo(optionsWidth, posY + height);
        ctx.stroke();

        // Draw OptionsWidget on the left (70% width)
        this.drawOptionsSection(ctx, node, optionsWidth, posY, height);
        
        // Draw StrengthCopyWidget on the right (30% width)
        this.drawCopySection(ctx, node, optionsWidth, copyWidth, posY, height);
    }

    drawOptionsSection(ctx, node, w, posY, height) {
        // Constants
        const margin = 20;
        const innerMargin = margin * 0.33;
        let posX = 10;

        // Calculated values
        const midY = posY + height * 0.5;

        // Widget state
        const lowMemValue = node.properties['low_mem_load'] || false;
        const mergeValue = node.properties['merge_loras'] === true ? true : false;
        const overwriteValue = node.properties['overwrite_duplicates'] || false;

        ctx.save();
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;

        // Draw Low Mem toggle
        ctx.fillText("Low Mem", posX, midY);
        posX += ctx.measureText("Low Mem").width + innerMargin;
        let bounds = drawTogglePart(ctx, [posX, posY], height, lowMemValue);
        this.optionsHitAreas['low_mem_toggle'].bounds = bounds;
        posX += bounds[1] + innerMargin * 3;

        // Draw Merge toggle
        ctx.fillText("Merge", posX, midY);
        posX += ctx.measureText("Merge").width + innerMargin;
        bounds = drawTogglePart(ctx, [posX, posY], height, mergeValue);
        this.optionsHitAreas['merge_loras_toggle'].bounds = bounds;
        posX += bounds[1] + innerMargin * 3;

        // Draw Overwrite toggle
        ctx.fillText("Overwrite", posX, midY);
        posX += ctx.measureText("Overwrite").width + innerMargin;
        bounds = drawTogglePart(ctx, [posX, posY], height, overwriteValue);
        this.optionsHitAreas['overwrite_toggle'].bounds = bounds;

        ctx.restore();
    }

    drawCopySection(ctx, node, xOffset, w, posY, height) {
        // Constants
        const margin = 20;
        const buttonWidth = 25;
        const buttonHeight = height;
        const buttonSpacing = 36;
        const rightOffset = 25;

        // Calculated values
        const midY = posY + height * 0.5;
        const totalButtonsWidth = (buttonWidth * 2) + buttonSpacing;
        const rightX = xOffset + w - margin - rightOffset;

        ctx.save();

        // Draw ">" button (high to low)
        const highToLowX = rightX - totalButtonsWidth;
        drawWidgetButton(ctx, [highToLowX, posY], [buttonWidth, buttonHeight], ">", this.highToLowPressed);
        this.copyHitAreas['high_to_low_button'].bounds = [highToLowX, buttonWidth];

        // Draw "<" button (low to high)
        const lowToHighX = rightX - totalButtonsWidth + buttonWidth + buttonSpacing;
        drawWidgetButton(ctx, [lowToHighX, posY], [buttonWidth, buttonHeight], "<", this.lowToHighPressed);
        this.copyHitAreas['low_to_high_button'].bounds = [lowToHighX, buttonWidth];

        ctx.restore();
    }

    onMouseDown(event, pos, node) {
        // Check options toggles
        if (this.clickWasWithinBounds(pos, this.optionsHitAreas.low_mem_toggle.bounds)) {
            node.properties['low_mem_load'] = !node.properties['low_mem_load'];
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        }
        if (this.clickWasWithinBounds(pos, this.optionsHitAreas.merge_loras_toggle.bounds)) {
            // Properly toggle the merge_loras property
            const currentValue = node.properties['merge_loras'];
            node.properties['merge_loras'] = currentValue === false ? true : false;
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        }
        if (this.clickWasWithinBounds(pos, this.optionsHitAreas.overwrite_toggle.bounds)) {
            node.properties['overwrite_duplicates'] = !node.properties['overwrite_duplicates'];
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
            return true;
        }
        
        // Check copy buttons
        if (this.clickWasWithinBounds(pos, this.copyHitAreas.high_to_low_button.bounds)) {
            this.highToLowPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        }
        if (this.clickWasWithinBounds(pos, this.copyHitAreas.low_to_high_button.bounds)) {
            this.lowToHighPressed = true;
            node.setDirtyCanvas(true, true);
            return true;
        }
        return false;
    }

    onMouseUp(event, pos, node) {
        if (this.highToLowPressed && this.clickWasWithinBounds(pos, this.copyHitAreas.high_to_low_button.bounds)) {
            this.copyHighToLowStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
        }
        if (this.lowToHighPressed && this.clickWasWithinBounds(pos, this.copyHitAreas.low_to_high_button.bounds)) {
            this.copyLowToHighStrengths(node);
            this.cancelMouseDown();
            node.setDirtyCanvas(true, true);
        }
        this.highToLowPressed = false;
        this.lowToHighPressed = false;
        return super.onMouseUp(event, pos, node);
    }

    copyHighToLowStrengths(node) {
        // Copy high strength values to low strength values (> button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.low_strength = widget.value.strength || 1;
            }
        }
    }

    copyLowToHighStrengths(node) {
        // Copy low strength values to high strength values (< button)
        for (const widget of node.widgets || []) {
            if (widget.name?.startsWith("lora_") && widget.value) {
                widget.value.strength = widget.value.low_strength || 1;
                // Also update strengthTwo if in model/clip mode
                if (widget.showModelAndClip && widget.value.strengthTwo !== undefined) {
                    widget.value.strengthTwo = widget.value.low_strength || 1;
                }
            }
        }
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT * 0.7];
    }
}

export class PowerLoraLoaderHeaderWidget extends RgthreeBaseWidget {
    constructor() {
        super("PowerLoraLoaderHeaderWidget");
        this.value = { type: "PowerLoraLoaderHeaderWidget" };
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
        };
    }

    draw(ctx, node, w, y, h) {
        const allLoraState = node.allLorasState();
        let posX = MARGIN;
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, [posX, y], h, allLoraState);
        posX += this.hitAreas.toggle.bounds[1] + MARGIN;

        ctx.textAlign = "left";
        ctx.fillStyle = "white";
        ctx.textBaseline = "middle";
        ctx.fillText("Toggle All", posX, y + h / 2);

        ctx.textAlign = "right";
        let rposX = w - MARGIN;
        ctx.fillText("*", rposX - ICON_WIDTH / 2, y + h / 2);
        rposX -= ICON_WIDTH + MARGIN;
        ctx.fillText("Low", rposX, y + h / 2);  // Changed from centered to right-aligned
        rposX -= STRENGTH_WIDTH + MARGIN;
        ctx.fillText("High", rposX, y + h / 2);  // Changed from centered to right-aligned
    }

    onToggleDown(event, pos, node) {
        node.toggleAllLoras();
        this.cancelMouseDown();
        return true;
    }
}

export class PowerLoraLoaderWidget extends RgthreeBaseWidget {
    constructor(name, showLoraChooser) {
        super(name);
        this.showLoraChooser = showLoraChooser;
        this.value = { on: true, lora: "None", strength: 1, low_strength: 1, is_low: false, low_active: true, use_for_both: false, low_only: false, high_only: false };
        this.haveMouseMovedStrength = false;
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
            lora: { bounds: [0, 0], onClick: this.onLoraClick },
            strength: { bounds: [0, 0], onClick: this.onStrengthClick, onMove: this.onStrengthAnyMove },
            low_strength: { bounds: [0, 0], onClick: this.onLowStrengthClick, onMove: this.onLowStrengthAnyMove },
            low_variant_icon: { bounds: [0, 0] },
        };
    }

    set value(v) {
        this._value = v;
        if (typeof this._value !== "object") {
            this._value = { on: true, lora: "None", strength: 1, low_strength: 1, is_low: false, low_active: true };
        }
        // Ensure low_strength is always initialized
        if (this._value.low_strength === undefined) {
            this._value.low_strength = 1;
        }

        // Ensure low_active is always initialized (default to true for backward compatibility)
        if (this._value.low_active === undefined) {
            this._value.low_active = true;
        }

        // Ensure use_for_both is always initialized (default to false)
        if (this._value.use_for_both === undefined) {
            this._value.use_for_both = false;
        }

        // Ensure low_only is always initialized (default to false)
        if (this._value.low_only === undefined) {
            this._value.low_only = false;
        }

        // Ensure high_only is always initialized (default to false)
        if (this._value.high_only === undefined) {
            this._value.high_only = false;
        }
    }

    get value() {
        return this._value;
    }

    draw(ctx, node, w, y, h) {
        drawRoundedRectangle(ctx, [MARGIN, y], [w - MARGIN * 2, h], h * 0.5);

        if (!this.value.on) {
            ctx.globalAlpha = 0.5;
        }

        let posX = MARGIN;
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, [posX, y], h, this.value.on);
        posX += this.hitAreas.toggle.bounds[1] + MARGIN;

        let rposX = w - MARGIN;
        if (this.value.use_for_both) {
            ctx.fillStyle = "#9370DB"; // Purple for "both" state
        } else if (this.value.low_only) {
            ctx.fillStyle = "#4169E1"; // Blue for "low only" state
        } else if (this.value.high_only) {
            ctx.fillStyle = "#DC143C"; // Red for "high only" state
        } else if (this.value.is_low) {
            ctx.fillStyle = this.value.low_active ? "lime" : "orange";
        } else {
            ctx.fillStyle = "#555";
        }
        ctx.beginPath();
        ctx.arc(rposX - ICON_WIDTH / 2, y + h / 2, h * 0.2, 0, Math.PI * 2);
        ctx.fill();
        
        // Store the bounds for the low variant icon
        this.hitAreas.low_variant_icon.bounds = [
            rposX - ICON_WIDTH,
            y,
            ICON_WIDTH,
            h
        ];
        
        rposX -= ICON_WIDTH + MARGIN;

        this.hitAreas.low_strength.bounds = [rposX - STRENGTH_WIDTH, STRENGTH_WIDTH];
        ctx.textAlign = "right";
        ctx.fillStyle = "white";
        ctx.textBaseline = "middle";
        ctx.fillText(this.value.low_strength.toFixed(2), rposX, y + h / 2);
        rposX -= STRENGTH_WIDTH + MARGIN;

        this.hitAreas.strength.bounds = [rposX - STRENGTH_WIDTH, STRENGTH_WIDTH];
        ctx.fillText(this.value.strength.toFixed(2), rposX, y + h / 2);
        rposX -= STRENGTH_WIDTH + MARGIN;

        const loraWidth = rposX - posX;
        this.hitAreas.lora.bounds = [posX, loraWidth];
        ctx.textAlign = "left";
        ctx.fillText(fitString(ctx, this.value.lora, loraWidth), posX, y + h / 2);

        ctx.globalAlpha = 1;
    }

    onToggleDown(event, pos, node) {
        this.value.on = !this.value.on;
        this.cancelMouseDown();
        node.setDirtyCanvas(true, true);
        return true;
    }

    setLora(lora) {
        // Store the original lora path/name as received from the picker
        this.value.lora = lora;
        // Reset all flags when a new LoRA is selected
        this.value.use_for_both = false;
        this.value.low_only = false;
        this.value.high_only = false;
        this.checkLowLoraVariant(lora);
    }

    checkLowLoraVariant(loraName) {
        if (!loraName || loraName === "None") {
            this.value.is_low = false;
            this.value.low_variant_name = null;
            return;
        }

        const allLoras = this.parent.lorasCache || [];
        if (!allLoras.length) {
            return;
        }

        // Use the full loraName for pattern matching
        // The pattern matcher now handles full paths properly
        const result = loraPatternMatcher.checkLowLoraVariant(loraName, allLoras);
        
        this.value.is_low = result.found;
        this.value.low_variant_name = result.variantName;
    }

    onLoraClick(event, pos, node) {
        this.showLoraChooser(event, (lora) => {
            if (lora) {
                this.setLora(lora);
            }
        }, node);
    }

    onStrengthClick(event, pos, node) {
        if (this.haveMouseMovedStrength) return;
        const canvas = app.canvas;
        canvas.prompt("Enter high strength", this.value.strength, (v) => {
            this.value.strength = parseFloat(v);
        }, event);
    }

    onLowStrengthClick(event, pos, node) {
        if (this.haveMouseMovedStrength) return;
        const canvas = app.canvas;
        canvas.prompt("Enter low strength", this.value.low_strength, (v) => {
            this.value.low_strength = parseFloat(v);
        }, event);
    }

    onStrengthAnyMove(event, pos, node) {
        this.haveMouseMovedStrength = true;
        this.value.strength += event.deltaX * 0.01;
    }

    onLowStrengthAnyMove(event, pos, node) {
        this.haveMouseMovedStrength = true;
        this.value.low_strength += event.deltaX * 0.01;
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedStrength = false;
    }

    showLoraInfoDialog(loraType = 'auto') {
        // Determine which LoRA to show info for based on loraType parameter
        let loraToShow = this.value.lora;
        
        if (loraType === 'auto') {
            // Auto-detect: show low variant if it exists, otherwise show main LoRA
            loraToShow = this.value.is_low && this.value.low_variant_name ?
                        this.value.low_variant_name : this.value.lora;
        } else if (loraType === 'low' && this.value.is_low && this.value.low_variant_name) {
            // Explicitly show low variant
            loraToShow = this.value.low_variant_name;
        } else if (loraType === 'high') {
            // Explicitly show high variant (main LoRA)
            loraToShow = this.value.lora;
        }
        
        // Import and show the LoRA info dialog
        import("./dialog_info.js").then(({ WanLoraInfoDialog }) => {
            const infoDialog = new WanLoraInfoDialog(loraToShow).show();
            // Store the item type for use in preview generation (this is for LoRA widgets)
            infoDialog.itemType = 'loras';
            console.log(`[Widgets Debug] Created LoRA widget dialog with itemType: ${infoDialog.itemType}`);
            infoDialog.addEventListener("close", ((e) => {
                if (e.detail.dirty) {
                    // Dialog was modified, could trigger refresh if needed
                    console.log("LoRA info was modified");
                }
            }));
        }).catch(error => {
            // Fallback to simple alert if dialog fails to load
            console.error("Failed to load LoRA info dialog:", error);
            const loraInfo = `LoRA Information:

File: ${loraToShow}`;
            alert(loraInfo);
        });
    }

    serializeValue(node, index) {
        const v = { ...this.value };

        // Ensure low_strength is always included
        if (v.low_strength === undefined) {
            v.low_strength = 1;
        }

        // Ensure is_low and low_variant_name are preserved
        v.is_low = this.value.is_low || false;
        v.low_variant_name = this.value.low_variant_name || null;

        // Ensure low_active is preserved (default to true for backward compatibility)
        v.low_active = this.value.low_active !== undefined ? this.value.low_active : true;

        return v;
    }
}

export function moveArrayItem(arr, itemOrFrom, to) {
    const from = typeof itemOrFrom === "number" ? itemOrFrom : arr.indexOf(itemOrFrom);
    if (from === -1 || to < 0 || to >= arr.length || from === to) return;
    const item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
}

export function removeArrayItem(arr, itemOrIndex) {
    const index = typeof itemOrIndex === "number" ? itemOrIndex : arr.indexOf(itemOrIndex);
    if (index !== -1) {
        arr.splice(index, 1);
    }
}

