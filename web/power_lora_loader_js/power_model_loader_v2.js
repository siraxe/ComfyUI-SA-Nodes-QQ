import { app } from "../../../scripts/app.js";
import { rgthree } from "../rgthree/common/rgthree.js";
import { RgthreeBetterButtonWidget, RgthreeDividerWidget, RgthreeBaseWidget } from "./widgets.js";
import { drawRoundedRectangle, drawTogglePart, drawWidgetButton, fitString, isLowQuality } from "./widgets.js";
import { LoraPickerDialog } from "./lora_picker_dialog.js";
import { WanLoraInfoDialog } from "./dialog_info.js";
import { CHECKPOINT_INFO_SERVICE } from "./model_info_service.js";
import { modelDataManager, UIManager } from "./pull_info.js";

const MINIMUM_NODE_WIDTH = 300;
const MARGIN = 10;
//const ICON_WIDTH = 24;

// Unified data fetching using pull_info.js
async function getModels(forceRefresh = false) {
    return modelDataManager.getItems('checkpoints', forceRefresh);
}

// Functions to persist favorites using pull_info.js
function saveFavorites(favorites) {
    UIManager.saveFavorites(favorites, 'checkpoints');
}

function loadFavorites() {
    return UIManager.loadFavorites('checkpoints');
}

// Functions to persist UI state using pull_info.js
function saveFoldersVisible(foldersVisible) {
    UIManager.saveUIProperty('foldersVisible', foldersVisible, 'checkpoints');
}

function loadFoldersVisible() {
    return UIManager.loadUIProperty('foldersVisible', 'checkpoints', false);
}

function saveSelectedFolder(selectedFolder) {
    UIManager.saveUIProperty('selectedFolder', selectedFolder, 'checkpoints');
}

function loadSelectedFolder() {
    return UIManager.loadUIProperty('selectedFolder', 'checkpoints', null);
}

function saveEyeRefreshState(eyeRefreshState) {
    UIManager.saveUIProperty('eyeRefreshState', eyeRefreshState, 'checkpoints');
}

function loadEyeRefreshState() {
    return UIManager.loadUIProperty('eyeRefreshState', 'checkpoints', false);
}


// Custom widget for model selection
class PowerModelLoaderWidget extends RgthreeBaseWidget {
    constructor(name, showModelChooser) {
        super(name);
        this.showModelChooser = showModelChooser;
        this.value = { on: true, model: "None" };
        this.options = {};
        this.y = 0;
        this.last_y = 0;
        this.hitAreas = {
            model: { bounds: [0, 0], onClick: this.onModelClick },
        };
    }

    set value(v) {
        this._value = v;
        if (typeof this._value !== "object") {
            this._value = { on: true, model: "None" };
        }
    }

    get value() {
        return this._value;
    }

    draw(ctx, node, w, y, h) {
        drawRoundedRectangle(ctx, [MARGIN, y], [w - MARGIN * 2, h], h * 0.5);

        let posX = MARGIN + 10; // Add 10px offset from left

        // Model name with bullet point
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = "14px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const displayText = this.value.model || "None";
        const displayTextWithBullet = "• " + displayText;
        const fittedText = fitString(ctx, displayTextWithBullet, w - posX - MARGIN * 2);
        ctx.fillText(fittedText, posX, y + h / 2);

        // Store hit area bounds for model selection
        this.hitAreas.model.bounds = [posX, y, w - posX - MARGIN * 2, h];
    }

    onModelClick = (event, pos, node) => {
        this.showModelChooser(event, (model) => {
            if (model) {
                this.setModel(model);
            }
        }, node);
        return true;
    }

    setModel(model) {
        this.value.model = model;
        if (this.callback) {
            this.callback(this.value);
        }
    }

    clickWasWithinBounds(pos, bounds) {
        if (!bounds) return false;
        return pos[0] >= bounds[0] && pos[0] <= bounds[0] + bounds[2] &&
               pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3];
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}

// Slot detection function for model widgets
function getModelSlotInPosition(canvasX, canvasY) {
    const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
    if (!slot) {
        // Check if click is on a model widget
        for (const widget of this.widgets || []) {
            if (!widget.last_y) continue;

            // Check if click Y is within this widget's bounds
            const widgetTop = this.pos[1] + widget.last_y;
            const widgetBottom = widgetTop + LiteGraph.NODE_WIDGET_HEIGHT;

            if (canvasY >= widgetTop && canvasY <= widgetBottom) {
                // Found the widget at this position
                if (widget.name?.startsWith("model_")) {
                    // Return a virtual slot for the model widget
                    return {
                        input: null,
                        output: {
                            type: "MODEL_WIDGET",
                            name: widget.name,
                            widget: widget
                        },
                        pos: [this.pos[0], widgetTop],
                        slot_index: -1 // Virtual slot
                    };
                }
            }
        }
    }
    return slot;
}

// Slot menu options for model widgets
function getModelSlotMenuOptions(slot, event) {
    // Check if this is our model widget virtual slot
    if (slot?.output?.type === "MODEL_WIDGET") {
        const widget = slot.output.widget;
        const modelName = widget.value.model;

        return [
            {
                content: "Show Info",
                callback: () => {
                    showModelInfoDialog(modelName);
                }
            }
        ];
    }
    return null; // Return empty array to prevent default menu
}

// Function to show model info dialog using WanLoraInfoDialog
function showModelInfoDialog(modelName) {
    if (!modelName || modelName === "None") {
        app.ui.dialog.show("No model selected");
        return;
    }

    // Create a model-specific info dialog by extending WanLoraInfoDialog
    class WanModelInfoDialog extends WanLoraInfoDialog {
        constructor(file) {
            super(file);
            // Set itemType to 'checkpoints' for correct preview generation
            this.itemType = 'checkpoints';
        }

        async getModelInfo(file) {
            try {
                const info = await CHECKPOINT_INFO_SERVICE.getInfo(file, false, false);
                return info;
            } catch (error) {
                // Fallback to basic info
                return {
                    file: file,
                    name: file,
                    info: {},
                    mtime: Date.now() / 1000
                };
            }
        }

        // Override refreshModelInfo to use CHECKPOINT_INFO_SERVICE instead of LORA_INFO_SERVICE
        async refreshModelInfo(file) {
            try {
                const info = await CHECKPOINT_INFO_SERVICE.refreshInfo(file);
                return info;
            } catch (error) {
                // Return existing info on error instead of failing
                return this.modelInfo || {
                    file: file,
                    name: file,
                    info: {},
                    mtime: Date.now() / 1000
                };
            }
        }
    }

    // Create and show the dialog
    const dialog = new WanModelInfoDialog(modelName);
    dialog.show();
}

// Function to show model in Windows Explorer
function showModelInExplorer(modelName) {
    // Use the ComfyUI API to open Explorer for the model file
    fetch('/wanvideo_wrapper/open_explorer', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lora_name: modelName }) // API expects lora_name but works for models too
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Explorer opened successfully
        } else {
            // Failed to open explorer
        }
    })
    .catch(error => {
        // Error opening explorer
    });
}

function showModelPicker(event, callback, node = null) {
    getModels().then(models => {
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
                    // Failed to parse UI state from widget
                }
            }
        }

        // Use existing LoraPickerDialog for model selection
        const dialog = new LoraPickerDialog(models, {
            parentNode: node,
            callback: callback,
            sort: "Latest",
            favorites: savedFavorites,
            favoritesOnly: false,
            isModelMode: true, // Flag to indicate this is model mode, not LoRA mode
            itemType: 'checkpoints', // Explicitly set item type for unified system
            onFavoriteToggle: (modelName) => {
                const index = savedFavorites.indexOf(modelName);
                if (index !== -1) {
                    // Remove from favorites
                    savedFavorites.splice(index, 1);
                } else {
                    // Add to favorites
                    savedFavorites.push(modelName);
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
                // Perform actual refresh of the model list using unified system
                try {
                    const freshModels = await getModels(true);
                    dialog.updateLoras(freshModels);
                    await modelDataManager.getPreviewAvailability('checkpoints');

                    // Re-render the list to show updated blue dots
                    dialog.renderList();
                } catch (error) {
                    // Error refreshing model list
                }
            }
        });

        // Override dialog styling to remove height limits
        const originalShow = dialog.show.bind(dialog);
        dialog.show = function() {
            originalShow();
            // Remove height restrictions from dialog
            setTimeout(() => {
                const dialogContent = this.element.querySelector('.litegraph.litecontextmenu.litemenubar-panel');
                if (dialogContent) {
                    dialogContent.style.maxHeight = 'none';
                    dialogContent.style.height = 'auto';
                }
                // Also remove max-height from any scrollable content
                const scrollableContent = this.element.querySelector('[style*="max-height"]');
                if (scrollableContent) {
                    scrollableContent.style.maxHeight = 'none';
                    scrollableContent.style.height = 'auto';
                }
            }, 50);
        };

        // Initialize dialog's UI state
        dialog.eyeRefreshState = eyeRefreshState;
        dialog.selectedFolder = selectedFolder;

        dialog.show();
    });
}


app.registerExtension({
    name: "WanVideo.PowerModelLoaderV2",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "CheckpointLoader_v2") {
            nodeType.prototype.modelsCache = [];

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
                this.modelWidgetsCounter = 0;
                this.properties = this.properties || {};
                this.addNonModelWidgets();

                // Always create a single model widget by default
                this.addNewModelWidget().setModel("None");

                // Ensure minimum size
                const computed = this.computeSize();
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(MINIMUM_NODE_WIDTH, this.size[0], computed[0]);
                this.size[1] = Math.max(this.size[1], computed[1]);
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                onConfigure?.apply(this, arguments);
                this.modelWidgetsCounter = 0;

                if (this.widgets) {
                    const widgets_to_remove = [...this.widgets];
                    for (const widget of widgets_to_remove) {
                        this.removeWidget(widget);
                    }
                }

                this.addNonModelWidgets();

                if (info.widgets_values) {
                    for (const widgetValue of info.widgets_values) {
                        if (widgetValue && widgetValue.model !== undefined) {
                            const widget = this.addNewModelWidget();
                            widget.value = { ...widgetValue };
                        }
                    }
                }
                getModels().then((models) => {
                    this.modelsCache = models;
                });
            };

            nodeType.prototype.addNewModelWidget = function () {
                this.modelWidgetsCounter++;
                const widget = new PowerModelLoaderWidget("model_" + this.modelWidgetsCounter, showModelPicker);
                widget.callback = (value) => {
                    // Trigger node execution when value changes
                    if (this.onWidgetChanged) {
                        this.onWidgetChanged(widget.name, value, widget.value, widget);
                    }
                };
                this.addCustomWidget(widget);
                if (this.widgetButtonSpacer) {
                    const index = this.widgets.indexOf(this.widgetButtonSpacer);
                    this.widgets.splice(index, 0, this.widgets.pop());
                }
                return widget;
            };

            nodeType.prototype.addNonModelWidgets = function () {
                this.addCustomWidget(new RgthreeDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));

                // Add hidden widget for UI state persistence
                const uiStateWidget = this.addWidget("string", "ui_state", "{}", () => {},
                    { serialize: true });
                uiStateWidget.type = "hidden";
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

                // Calculate height based on number of model widgets
                if (this.widgets) {
                    const modelWidgets = this.widgets.filter(w => w.name?.startsWith("model_"));
                    if (modelWidgets.length > 0) {
                        computedHeight += modelWidgets.length * LiteGraph.NODE_WIDGET_HEIGHT;
                    }
                }

                return [minWidth, computedHeight];
            };

            // Register slot detection functions for context menu
            nodeType.prototype.getSlotInPosition = getModelSlotInPosition;
            nodeType.prototype.getSlotMenuOptions = getModelSlotMenuOptions;

            // Pre-load models
            getModels().then(models => {
                nodeType.prototype.modelsCache = models;
            });

            // Add refreshComboInNode method to handle R key press for reloading definitions
            nodeType.prototype.refreshComboInNode = function(defs) {
                // Use unified system to refresh the model list
                modelDataManager.clearCaches('checkpoints');

                // Fetch fresh models and update cache
                getModels(true).then((modelsDetails) => {
                    nodeType.prototype.modelsCache = modelsDetails;

                    // Update all nodes of this type
                    app.graph._nodes.forEach(node => {
                        if (node.type === "CheckpointLoader_v2") {
                            // Update any existing widgets that might need the fresh data
                            for (const widget of node.widgets || []) {
                                if (widget.name?.startsWith("model_")) {
                                    // Update the widget's parent reference to this node
                                    widget.parent = node;

                                    // Trigger a value change to update the UI
                                    if (widget.callback && typeof widget.callback === 'function') {
                                        widget.callback(widget.value);
                                    }
                                }
                            }

                            // Trigger a redraw
                            node.setDirtyCanvas(true, true);
                        }
                    });

                }).catch(error => {
                    // Error refreshing model list
                });
            };
        }
    },
});
