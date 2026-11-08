/**
 * Shared factory for the Power Lora Loader family of nodes
 * (power_lora_loader_v2.js / power_lora_loader_simple.js).
 *
 * Eliminates code duplication across the loaders: the extension logic, LoRA
 * picker wiring, UI-state persistence and the row/header widgets live here and
 * are configured per node via `createPowerLoraLoaderExtension(config)`.
 *
 * Config options:
 *   extensionName      - unique extension name for app.registerExtension
 *   nodeNames          - array of node class names this extension hooks
 *   logTag             - prefix used in console messages
 *   strengthSplit      - true: Low + High strength columns (v2 style)
 *                        false: single united Strength column (simple style)
 *   copyButtons        - draw the "<" / ">" strength copy buttons
 *   outputBoth         - draw the "Output both" toggle + hidden output_both widget
 *   localStoragePrefix - prefix for UI state localStorage keys
 */

import { app } from "../../../scripts/app.js";
import {
    RgthreeBaseWidget, RgthreeBetterButtonWidget, RgthreeDividerWidget,
    StrengthCopyWidget, PowerLoraLoaderHeaderWidget, PowerLoraLoaderWidget,
    fitString, drawTogglePart, drawRoundedRectangle,
} from "./widgets.js";
import { LoraPickerDialog } from "./lora_picker_dialog.js";
import { getLoraSlotInPosition, getLoraSlotMenuOptions } from "./lora_context_menu.js";
import { modelDataManager, UIManager } from "./pull_info.js";

const MINIMUM_NODE_WIDTH = 480;
const STRENGTH_WIDTH = 60;
const ICON_WIDTH = 20;
const MARGIN = 10;

// Unified data fetching using pull_info.js
async function getLoras(forceRefresh = false) {
    return modelDataManager.getItems('loras', forceRefresh);
}

// Functions to persist favorites using pull_info.js
function saveFavorites(favorites) {
    UIManager.saveFavorites(favorites, 'loras');
}

function loadFavorites() {
    return UIManager.loadFavorites('loras');
}

// Functions to persist UI state using pull_info.js
function saveFoldersVisible(foldersVisible) {
    UIManager.saveUIProperty('foldersVisible', foldersVisible, 'loras');
}

function loadFoldersVisible() {
    return UIManager.loadUIProperty('foldersVisible', 'loras', false);
}

function saveSelectedFolder(selectedFolder) {
    UIManager.saveUIProperty('selectedFolder', selectedFolder, 'loras');
}

function loadSelectedFolder() {
    return UIManager.loadUIProperty('selectedFolder', 'loras', null);
}

function saveEyeRefreshState(eyeRefreshState) {
    UIManager.saveUIProperty('eyeRefreshState', eyeRefreshState, 'loras');
}

function loadEyeRefreshState() {
    return UIManager.loadUIProperty('eyeRefreshState', 'loras', false);
}

function showLoraPicker(event, callback, node = null, logTag = "PowerLoraLoader") {
    getLoras().then(loras => {
        const savedFavorites = loadFavorites();

        // Load UI state from localStorage or node properties
        let foldersVisible = loadFoldersVisible();
        let eyeRefreshState = loadEyeRefreshState();
        let selectedFolder = loadSelectedFolder();

        if (node && node.widgets) {
            const uiStateWidget = node.widgets.find(w => w.name === "ui_state");
            if (uiStateWidget && uiStateWidget.value) {
                try {
                    const uiState = JSON.parse(uiStateWidget.value);
                    if (uiState.foldersVisible !== undefined) foldersVisible = uiState.foldersVisible;
                    if (uiState.eyeRefreshState !== undefined) eyeRefreshState = uiState.eyeRefreshState;
                    if (uiState.selectedFolder !== undefined) selectedFolder = uiState.selectedFolder;
                } catch (e) {
                    console.warn(`[${logTag}] Failed to parse UI state from widget:`, e);
                }
            }
        }

        const dialog = new LoraPickerDialog(loras, {
            parentNode: node,
            callback: callback,
            sort: "Latest",
            favorites: savedFavorites,
            favoritesOnly: false,
            itemType: 'loras', // Explicitly set item type for unified system
            onFavoriteToggle: (loraName) => {
                const index = savedFavorites.indexOf(loraName);
                if (index !== -1) {
                    // Remove from favorites
                    savedFavorites.splice(index, 1);
                } else {
                    // Add to favorites
                    savedFavorites.push(loraName);
                }
                // Save to localStorage using unified system
                saveFavorites(savedFavorites);
                // Update dialog's favorites
                dialog.options.favorites = savedFavorites;
                // Re-render the list to update star colors
                dialog.renderList();
            },
            foldersVisible: foldersVisible,
            refreshCallback: async () => {
                // Perform actual refresh of the LoRA list using unified system
                try {
                    const freshLoras = await getLoras(true);
                    dialog.updateLoras(freshLoras);

                    // Also refresh preview availability for blue dots using unified system
                    await modelDataManager.getPreviewAvailability('loras');

                    // Re-render the list to show updated blue dots
                    dialog.renderList();
                } catch (error) {
                    console.error(`[${logTag}] Error refreshing LoRA list:`, error);
                }
            }
        });

        // Initialize dialog's UI state
        dialog.eyeRefreshState = eyeRefreshState;
        dialog.selectedFolder = selectedFolder;

        dialog.show();
    });
}

// Header: "Toggle All" + either "Low"/"High" column labels (strengthSplit)
// or a single "Strength" column label.
export class PowerLoraLoaderHeaderWidgetEx extends PowerLoraLoaderHeaderWidget {
    constructor(strengthSplit) {
        super();
        this.strengthSplit = strengthSplit;
    }

    draw(ctx, node, w, y, h) {
        if (this.strengthSplit) {
            super.draw(ctx, node, w, y, h);
            return;
        }

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
        ctx.fillText("Strength", rposX, y + h / 2);
    }
}

// One row per LoRA. With strengthSplit = true it behaves exactly like the v2
// widget (Low + High strengths). With strengthSplit = false the Low column is
// hidden and the row shows a single united Strength value.
export class PowerLoraLoaderWidgetEx extends PowerLoraLoaderWidget {
    constructor(name, showLoraChooser, strengthSplit) {
        super(name, showLoraChooser);
        this.strengthSplit = strengthSplit;
        if (!strengthSplit) {
            // Single-strength mode: no Low strength hit area / interactions
            delete this.hitAreas.low_strength;
        }
    }

    draw(ctx, node, w, y, h) {
        if (this.strengthSplit) {
            super.draw(ctx, node, w, y, h);
            return;
        }

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

        this.hitAreas.strength.bounds = [rposX - STRENGTH_WIDTH, STRENGTH_WIDTH];
        ctx.textAlign = "right";
        ctx.fillStyle = "white";
        ctx.textBaseline = "middle";
        ctx.fillText(this.value.strength.toFixed(2), rposX, y + h / 2);
        rposX -= STRENGTH_WIDTH + MARGIN;

        const loraWidth = rposX - posX;
        this.hitAreas.lora.bounds = [posX, loraWidth];
        ctx.textAlign = "left";
        ctx.fillText(fitString(ctx, this.value.lora, loraWidth), posX, y + h / 2);

        ctx.globalAlpha = 1;
    }
}

/**
 * Builds and registers a full extension for one (or more) power lora loader
 * node types. See the module docblock for the available config options.
 */
export function createPowerLoraLoaderExtension(config) {
    const {
        extensionName,
        nodeNames = [],
        logTag = "PowerLoraLoader",
        strengthSplit = true,
        copyButtons = true,
        outputBoth = true,
        localStoragePrefix = "powerLoraLoader",
    } = config;

    const nodeSet = new Set(nodeNames);

    function showPicker(event, callback, node = null) {
        return showLoraPicker(event, callback, node, logTag);
    }

    app.registerExtension({
        name: extensionName,
        async beforeRegisterNodeDef(nodeType, nodeData, app) {
            if (!nodeSet.has(nodeData.name)) {
                return;
            }

            nodeType.prototype.lorasCache = [];

            nodeType.prototype.addCustomWidget = function(widget) {
                if (!this.widgets) {
                    this.widgets = [];
                }
                widget.parent = this;
                this.widgets.push(widget);
                return widget;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                this.serialize_widgets = true;
                this.loraWidgetsCounter = 0;
                this.hasClip = false; // Initialize clip connection state
                this.properties = this.properties || {};
                if (outputBoth) {
                    this.properties['Show Strengths'] = "Single Strength";
                    this.properties['output_both'] = false;
                }
                this.addNonLoraWidgets();

                // Ensure minimum size
                const computed = this.computeSize();
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
                this.size[1] = Math.max(this.size[1], computed[1]);
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                onConfigure?.apply(this, arguments);
                this.loraWidgetsCounter = 0;

                // Restore hasClip state if it exists
                if (info.hasClip !== undefined) {
                    this.hasClip = info.hasClip;
                }

                if (this.widgets) {
                    const widgets_to_remove = [...this.widgets];
                    for (const widget of widgets_to_remove) {
                        this.removeWidget(widget);
                    }
                }

                this.addNonLoraWidgets();

                if (info.widgets_values) {
                    for (const widgetValue of info.widgets_values) {
                        if (widgetValue && widgetValue.lora !== undefined) {
                            const widget = this.addNewLoraWidget();
                            widget.value = { ...widgetValue };
                        }
                    }
                }
                getLoras().then((loras) => {
                    this.lorasCache = loras;
                    for (const widget of this.widgets) {
                        if (widget.name?.startsWith("lora_")) {
                            widget.checkLowLoraVariant(widget.value.lora);
                        }
                    }
                });

                // Restore UI state from widget if it exists
                if (this.properties.uiState) {
                    const uiStateWidget = this.widgets.find(w => w.name === "ui_state");
                    if (uiStateWidget) {
                        uiStateWidget.value = this.properties.uiState;
                    }
                }
                // Also check if there is a ui_state value directly in the widget_values
                if (info.widgets_values) {
                    for (let i = 0; i < info.widgets_values.length; i++) {
                        const widgetValue = info.widgets_values[i];
                        if (widgetValue && typeof widgetValue === 'string') {
                            try {
                                const parsed = JSON.parse(widgetValue);
                                if (parsed && typeof parsed === 'object' && !parsed.lora) {
                                    // This looks like UI state data, update the widget
                                    const uiStateWidget = this.widgets.find(w => w.name === "ui_state");
                                    if (uiStateWidget) {
                                        uiStateWidget.value = widgetValue;
                                    }
                                    break;
                                }
                            } catch (e) {
                                // Not valid JSON, skip
                            }
                        }
                    }
                }

                // Sync output_both property to widget
                if (outputBoth) {
                    const outputBothWidget = this.widgets.find(w => w.name === "output_both");
                    if (outputBothWidget && this.properties.output_both !== undefined) {
                        outputBothWidget.value = this.properties.output_both;
                    }
                }
            };

            nodeType.prototype.addNewLoraWidget = function () {
                this.loraWidgetsCounter++;
                const widget = new PowerLoraLoaderWidgetEx("lora_" + this.loraWidgetsCounter, showPicker, strengthSplit);
                this.addCustomWidget(widget);
                if (this.widgetButtonSpacer) {
                    const index = this.widgets.indexOf(this.widgetButtonSpacer);
                    this.widgets.splice(index, 0, this.widgets.pop());
                }
                return widget;
            };

            nodeType.prototype.addNonLoraWidgets = function () {
                // Optional strength-copy row: "Output both" toggle + "<"/">" buttons
                if (outputBoth || copyButtons) {
                    this.addCustomWidget(new StrengthCopyWidget(outputBoth, copyButtons));
                }
                this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new PowerLoraLoaderHeaderWidgetEx(strengthSplit));
                this.widgetButtonSpacer = this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new RgthreeBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
                    showPicker(event, (lora) => {
                        if (lora) {
                            this.addNewLoraWidget().setLora(lora);
                        }
                    }, node);
                }));

                // Add hidden widget for UI state persistence
                const uiStateWidget = this.addWidget("string", "ui_state", "{}", () => {},
                    { serialize: true });
                uiStateWidget.type = "hidden";
                // Keep serialize: true to ensure UI state is saved in workflow JSON

                // Add hidden widget for output_both toggle state
                if (outputBoth) {
                    const outputBothValue = this.properties.output_both || false;
                    const outputBothWidget = this.addWidget("boolean", "output_both", outputBothValue, () => {},
                        { serialize: true });
                    outputBothWidget.type = "hidden";
                }
            };

            nodeType.prototype.allLorasState = function() {
                let allOn = true;
                let allOff = true;
                for (const widget of this.widgets) {
                    if (widget.name?.startsWith("lora_")) {
                        const on = widget.value?.on;
                        allOn = allOn && on === true;
                        allOff = allOff && on === false;
                        if (!allOn && !allOff) {
                            return null;
                        }
                    }
                }
                return allOn ? true : (allOff ? false : null);
            };

            nodeType.prototype.toggleAllLoras = function() {
                const allOn = this.allLorasState();
                const toggledTo = !allOn;
                for (const widget of this.widgets) {
                    if (widget.name?.startsWith("lora_") && widget.value?.on != null) {
                        widget.value.on = toggledTo;
                    }
                }
            };

            // Add width locking mechanism to prevent shrinking below minimum width
            nodeType.prototype.onResize = function(size) {
                // Enforce minimum width constraint
                if (size && size[0] < MINIMUM_NODE_WIDTH) {
                    size[0] = MINIMUM_NODE_WIDTH;
                }

                // Call the original onResize if it exists
                if (LGraphNode.prototype.onResize) {
                    return LGraphNode.prototype.onResize.call(this, size);
                }

                return size;
            };

            // Add method to compute size properly
            nodeType.prototype.computeSize = function(width) {
                const minWidth = MINIMUM_NODE_WIDTH;
                const minHeight = 100; // Base height
                let computedHeight = minHeight;

                // Calculate height based on number of lora widgets
                if (this.widgets) {
                    const loraWidgets = this.widgets.filter(w => w.name?.startsWith("lora_"));
                    if (loraWidgets.length > 0) {
                        computedHeight += loraWidgets.length * LiteGraph.NODE_WIDGET_HEIGHT;
                    }
                }

                // Account for other widgets too
                if (this.widgets) {
                    // Count non-lora widgets that contribute to height
                    const nonLoraWidgets = this.widgets.filter(w => !w.name?.startsWith("lora_") &&
                                                                  !(w.computeSize === undefined));
                    if (nonLoraWidgets.length > 0) {
                        for (const widget of nonLoraWidgets) {
                            if (widget.computeSize) {
                                const widgetSize = widget.computeSize(width || this.size[0]);
                                if (widgetSize && widgetSize[1]) {
                                    computedHeight += widgetSize[1];
                                } else {
                                    computedHeight += LiteGraph.NODE_WIDGET_HEIGHT;
                                }
                            } else {
                                computedHeight += LiteGraph.NODE_WIDGET_HEIGHT;
                            }
                        }
                    } else {
                        // If there are no special computeSize widgets, just add base amount for non-lora widgets
                        const otherWidgetsCount = this.widgets.length - (this.widgets.filter(w => w.name?.startsWith("lora_")).length);
                        computedHeight += otherWidgetsCount * LiteGraph.NODE_WIDGET_HEIGHT;
                    }
                }

                return [minWidth, computedHeight];
            };

            nodeType.prototype.getSlotInPosition = getLoraSlotInPosition;
            nodeType.prototype.getSlotMenuOptions = getLoraSlotMenuOptions;

            // Store clip connection state for Python code to check
            const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function(type, slotIndex, isConnected, link_info, ioSlot) {
                originalOnConnectionsChange?.apply(this, arguments);

                // Store the clip connection state (by input name, not slot index)
                if (type === LiteGraph.INPUT && ioSlot && ioSlot.name === "clip") {
                    this.hasClip = isConnected;
                    this.setDirtyCanvas(true, true);
                }
            };

            // Override serialize to include hasClip state
            const originalOnSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function() {
                const data = originalOnSerialize?.apply(this, arguments) || {};
                data.hasClip = this.hasClip;
                return data;
            };

            // Add onSerialize method to persist UI state
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                onSerialize?.apply(this, arguments);

                let uiState = null;
                const uiStateWidget = this.widgets.find(w => w.name === "ui_state");

                if (uiStateWidget && uiStateWidget.value) {
                    try {
                        uiState = JSON.parse(uiStateWidget.value);
                    } catch (e) {
                        console.warn(`[${logTag}] Failed to parse existing widget value:`, e);
                    }
                }

                if (!uiState) {
                    // Try to get from localStorage with per-loader keys
                    const foldersVisible = localStorage.getItem(`${localStoragePrefix}.foldersVisible`);
                    const eyeRefreshState = localStorage.getItem(`${localStoragePrefix}.eyeRefreshState`);
                    const selectedFolder = localStorage.getItem(`${localStoragePrefix}.selectedFolder`);

                    uiState = {
                        foldersVisible: foldersVisible ? JSON.parse(foldersVisible) : false,
                        eyeRefreshState: eyeRefreshState ? JSON.parse(eyeRefreshState) : false,
                        selectedFolder: selectedFolder ? JSON.parse(selectedFolder) : null,
                    };
                }

                this.properties.uiState = JSON.stringify(uiState);

                if (uiStateWidget) {
                    uiStateWidget.value = JSON.stringify(uiState);
                }
            };

            // Pre-load loras
            getLoras().then(loras => {
                nodeType.prototype.lorasCache = loras;
            });

            // Add refreshComboInNode method to handle R key press for reloading definitions
            nodeType.prototype.refreshComboInNode = function(defs) {
                // Use unified system to refresh the LoRA list
                modelDataManager.clearCaches('loras');

                // Fetch fresh loras and update cache
                getLoras(true).then((lorasDetails) => {
                    nodeType.prototype.lorasCache = lorasDetails;

                    // Update all nodes of this type
                    app.graph._nodes.forEach(node => {
                        if (nodeSet.has(node.type)) {
                            // Update any existing widgets that might need the fresh data
                            for (const widget of node.widgets || []) {
                                if (widget.name?.startsWith("lora_")) {
                                    // Update the widget's parent reference to this node
                                    widget.parent = node;

                                    // Refresh low variant detection for existing LoRAs with new cache
                                    if (widget.value?.lora && widget.value.lora !== "None") {
                                        const oldIsLow = widget.value.is_low;
                                        const oldVariantName = widget.value.low_variant_name;

                                        // Re-run the low variant check with updated cache
                                        widget.checkLowLoraVariant(widget.value.lora);

                                        // Log changes in low variant detection
                                        if (oldIsLow !== widget.value.is_low || oldVariantName !== widget.value.low_variant_name) {
                                            console.log(`[${logTag}] Low variant status changed for '${widget.value.lora}': ` +
                                                      `${oldIsLow} -> ${widget.value.is_low}, ` +
                                                      `variant: '${oldVariantName}' -> '${widget.value.low_variant_name}'`);
                                        }
                                    }

                                    // Trigger a value change to update the UI
                                    if (widget.callback && typeof widget.callback === 'function') {
                                        widget.callback(widget.value);
                                    }
                                }
                            }

                            // Trigger a redraw to update the green low icons
                            node.setDirtyCanvas(true, true);
                        }
                    });

                    console.log(`[${logTag}] LoRA definitions refreshed - individual LoRA info available in dialogs`);
                }).catch(error => {
                    console.error(`[${logTag}] Error refreshing LoRA list:`, error);
                });
            };
        }
    });
}