import { app } from "../../../../scripts/app.js";
import { moveArrayItem, removeArrayItem } from "./widgets.js";
import { renameLoRAFiles } from "./rename_utils.js";

// Slot context menus for the Power Lora Loader family.
//
// Newer ComfyUI frontends call `new LiteGraph.ContextMenu(options, ...)`
// unconditionally with whatever `node.getSlotMenuOptions(slot)` returns, so
// these handlers MUST return a proper options array (returning false/undefined
// crashes with "t.some is not a function"). ComfyUI renders the menu itself.

const I_BLACK = '⚫';
const I_GREEN = '🟢';
const I_WHITE = '⚪';
const I_BLUE = '🔵';
const I_RED = '🔴';
const I_PURPLE = '🟣';
const I_INFO = 'ℹ️';
const I_UP = '⬆️';
const I_DOWN = '⬇️';
const I_PENCIL = '✏️';
const I_TRASH = '🗑️';
// Path separators without backslash literals (transport-safe)
const FWD_SLASH = String.fromCharCode(47);  // forward slash
const BACK_SLASH = String.fromCharCode(92); // back slash

function setDirty(node) {
    node.setDirtyCanvas(true, true);
}

function moveLoraWidget(node, widget, offset) {
    const loraWidgets = node.widgets.filter(w => w.name?.startsWith("lora_"));
    const index = loraWidgets.indexOf(widget);
    const other = loraWidgets[index + offset];
    if (!other) return;
    const otherIndex = node.widgets.indexOf(other);
    const myIndex = node.widgets.indexOf(widget);
    node.widgets[otherIndex] = widget;
    node.widgets[myIndex] = other;
    node.setDirtyCanvas(true, true);
}

// Builds the LiteGraph menu options for a lora slot (row right-click) or the
// low-variant icon right-click. Returns null when the slot is not one of ours.
function buildSlotMenuItems(slot, node) {
    const dirty = () => setDirty(node);

    // --- Low variant icon right-click menu ---
    if (slot?.output?.type === "LOW_VARIANT_ICON") {
        const widget = slot.widget;
        const hasLowVariant = widget.value.is_low && widget.value.low_variant_name;
        const isBothMode = widget.value.use_for_both;
        const isLowOnlyMode = widget.value.low_only;
        const isHighOnlyMode = widget.value.high_only;

        const setMode = (both, low, high) => () => {
            widget.value.use_for_both = both;
            widget.value.low_only = low;
            widget.value.high_only = high;
            dirty();
        };

        if (hasLowVariant || isBothMode || isLowOnlyMode || isHighOnlyMode) {
            let displayText;
            if (isBothMode) {
                displayText = widget.value.lora + " (both)";
            } else if (isLowOnlyMode) {
                displayText = widget.value.lora + " (low only)";
            } else if (isHighOnlyMode) {
                displayText = widget.value.lora + " (high only)";
            } else {
                displayText = widget.value.low_variant_name;
            }
            const pathSplit = new RegExp('[' + FWD_SLASH + BACK_SLASH + ']');
            const fileName = displayText.includes(FWD_SLASH) || displayText.includes(BACK_SLASH)
                ? displayText.split(pathSplit).pop()
                : displayText;

            const items = [{ content: fileName, disabled: true }, null];

            if (hasLowVariant) {
                items.push({
                    content: (widget.value.low_active ? I_BLACK : I_GREEN) + " Toggle " + (widget.value.low_active ? 'Off' : 'On'),
                    callback: () => {
                        widget.value.low_active = !widget.value.low_active;
                        dirty();
                    },
                }, null);
                items.push({ content: I_INFO + ' Show Info', callback: () => widget.showLoraInfoDialog('low') });
            } else if (isBothMode) {
                items.push(
                    { content: I_WHITE + ' Disable', callback: setMode(false, false, false) },
                    { content: I_BLUE + ' Switch to Low only', callback: setMode(false, true, false) },
                    { content: I_RED + ' Switch to High only', callback: setMode(false, false, true) },
                );
            } else if (isLowOnlyMode) {
                items.push(
                    { content: I_WHITE + ' Disable', callback: setMode(false, false, false) },
                    { content: I_PURPLE + ' Switch to Both', callback: setMode(true, false, false) },
                    { content: I_RED + ' Switch to High only', callback: setMode(false, false, true) },
                );
            } else if (isHighOnlyMode) {
                items.push(
                    { content: I_WHITE + ' Disable', callback: setMode(false, false, false) },
                    { content: I_PURPLE + ' Switch to Both', callback: setMode(true, false, false) },
                    { content: I_BLUE + ' Switch to Low only', callback: setMode(false, true, false) },
                );
            }
            return items;
        }

        // No low variant: show mode options
        return [
            { content: I_PURPLE + ' Enable for both', callback: setMode(true, false, false) },
            { content: I_BLUE + ' Low only', callback: setMode(false, true, false) },
            { content: I_RED + ' High only', callback: setMode(false, false, true) },
        ];
    }

    // --- LoRA row right-click menu ---
    if (slot?.output?.type === "LORA_WIDGET" || slot?.widget?.name?.startsWith("lora_")) {
        const widget = slot.widget;
        const loraWidgets = node.widgets.filter(w => w.name?.startsWith("lora_"));
        const index = loraWidgets.indexOf(widget);
        const canMoveUp = index > 0;
        const canMoveDown = index >= 0 && index < loraWidgets.length - 1;
        // The Simple loader (strengthSplit === false) has no toggle entry.
        const isV2 = widget.strengthSplit !== false;

        const items = [
            { content: I_INFO + ' Show Info', callback: () => widget.showLoraInfoDialog('high') },
            null,
        ];

        if (isV2) {
            items.push({
                content: (widget.value.on ? I_BLACK : I_GREEN) + " Toggle " + (widget.value.on ? 'Off' : 'On'),
                callback: () => {
                    widget.value.on = !widget.value.on;
                    dirty();
                },
            }, null);
        }

        items.push(
            { content: I_UP + ' Move Up', disabled: !canMoveUp, callback: () => moveLoraWidget(node, widget, -1) },
            { content: I_DOWN + ' Move Down', disabled: !canMoveDown, callback: () => moveLoraWidget(node, widget, 1) },
            {
                content: I_PENCIL + ' Rename',
                callback: () => renameLoRAFiles(widget.value.lora, 'high', null, null, node, widget),
            },
            {
                content: I_TRASH + ' Remove',
                callback: () => {
                    removeArrayItem(node.widgets, widget);
                    const computed = node.computeSize();
                    node.size[1] = Math.max(node._tempHeight || 15, computed[1]);
                    node.setDirtyCanvas(true, true);
                },
            },
        );
        return items;
    }

    return null;
}

export function getLoraSlotInPosition(canvasX, canvasY) {
    const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
    if (!slot) {
        // Check if click is on a LoRA widget
        for (const widget of this.widgets || []) {
            if (!widget.last_y) continue;

            // Check if click Y is within this widget's bounds
            const widgetTop = this.pos[1] + widget.last_y;
            const widgetBottom = widgetTop + LiteGraph.NODE_WIDGET_HEIGHT;

            if (canvasY >= widgetTop && canvasY <= widgetBottom) {
                // Found the widget at this position
                if (widget.name?.startsWith("lora_")) {
                    // Check if click is on the low variant icon (circle)
                    if (widget.hitAreas && widget.hitAreas.low_variant_icon) {
                        const iconBounds = widget.hitAreas.low_variant_icon.bounds;
                        const iconAbsXStart = this.pos[0] + iconBounds[0];
                        const iconAbsXEnd = iconAbsXStart + (iconBounds[1] || 20);
                        const iconAbsYStart = widgetTop;
                        const iconAbsYEnd = widgetBottom;

                        if (canvasX >= iconAbsXStart && canvasX <= iconAbsXEnd &&
                            canvasY >= iconAbsYStart && canvasY <= iconAbsYEnd) {
                            // Check if this widget has a low variant or is in "both" mode
                            if (widget.value.is_low && widget.value.low_variant_name) {
                                return { widget: widget, output: { type: "LOW_VARIANT_ICON" } };
                            }
                            // Check if widget is in "both" mode or has no low variant (gray icon)
                            if (!widget.value.is_low || widget.value.use_for_both) {
                                return { widget: widget, output: { type: "LOW_VARIANT_ICON" } };
                            }
                        }
                    }
                    // If click is on a LoRA widget, return it
                    return { widget: widget, output: { type: "LORA_WIDGET" } };
                }
            }
        }
    }
    return slot;
}

export function getLoraSlotMenuOptions(slot, event) {
    const items = buildSlotMenuItems(slot, this);
    if (items) {
        // Must return a real options array: newer ComfyUI frontends feed the
        // return value straight into new LiteGraph.ContextMenu(options, ...).
        return items;
    }
    return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
}
