
import { app } from "../../../scripts/app.js";
import { qq } from "../qq_lib/common/qq.js";
import { QQBetterButtonWidget, QQDividerWidget, CombinedOptionsWidget, PowerLoraLoaderHeaderWidget, PowerLoraLoaderWidget } from "./widgets.js";
import { LoraPickerDialog } from "./lora_picker_dialog.js";
import { getLoraSlotInPosition, getLoraSlotMenuOptions } from "./lora_context_menu.js";
import { modelDataManager, UIManager } from "./pull_info.js";

const MINIMUM_NODE_WIDTH = 480;

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

function showLoraPicker(event, callback, node = null) {
    getLoras().then(loras => {
        const savedFavorites = loadFavorites();
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
                    console.error('[WanVideoPowerLoraLoader] Error refreshing LoRA list:', error);
                }
            }
        });
        dialog.show();
    });
}

app.registerExtension({
    name: "WanVideo.PowerLoraLoader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "WanVideoPowerLoraLoader") {
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
                this.properties = this.properties || {};
                this.properties['low_mem_load'] = true;
                this.properties['merge_loras'] = false;  // Default to false to allow users to enable it
                this.properties['overwrite_duplicates'] = false;
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

                if (this.properties.uiState) {
                    const uiStateWidget = this.widgets.find(w => w.name === "pll_ui_state");
                    if (uiStateWidget) {
                        uiStateWidget.value = this.properties.uiState;
                    }
                }

              };

            nodeType.prototype.addNewLoraWidget = function () {
                this.loraWidgetsCounter++;
                const widget = new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter, showLoraPicker);
                this.addCustomWidget(widget);
                if (this.widgetButtonSpacer) {
                    const index = this.widgets.indexOf(this.widgetButtonSpacer);
                    this.widgets.splice(index, 0, this.widgets.pop());
                }
                return widget;
            };

            nodeType.prototype.addNonLoraWidgets = function () {
                this.addCustomWidget(new CombinedOptionsWidget());
                this.addCustomWidget(new QQDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new PowerLoraLoaderHeaderWidget());
                this.widgetButtonSpacer = this.addCustomWidget(new QQDividerWidget({ marginTop: 4, marginBottom: 0, thickness: 0 }));
                this.addCustomWidget(new QQBetterButtonWidget("➕ Add Lora", (event, pos, node) => {
                    showLoraPicker(event, (lora) => {
                        if (lora) {
                            this.addNewLoraWidget().setLora(lora);
                        }
                    }, node);
                }));

                // Add hidden widget for UI state persistence
                const uiStateWidget = this.addWidget("string", "pll_ui_state", "{}", () => {},
                    { serialize: true });
                uiStateWidget.type = "hidden";
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

            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                onSerialize?.apply(this, arguments);

                let uiState = null;
                const uiStateWidget = this.widgets.find(w => w.name === "pll_ui_state");

                if (uiStateWidget && uiStateWidget.value) {
                    try {
                        uiState = JSON.parse(uiStateWidget.value);
                    } catch (e) {
                        console.warn("[WanVideoPowerLoraLoader] Failed to parse existing widget value:", e);
                    }
                }

                if (!uiState) {
                    const foldersVisible = localStorage.getItem("wanVideoPowerLoraLoader.foldersVisible");
                    const eyeRefreshState = localStorage.getItem("wanVideoPowerLoraLoader.eyeRefreshState");
                    const selectedFolder = localStorage.getItem("wanVideoPowerLoraLoader.selectedFolder");

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
                        if (node.type === "WanVideoPowerLoraLoader") {
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

                }).catch(error => {
                    console.error('[WanVideoPowerLoraLoader] Error refreshing LoRA list:', error);
                });
            };
        }
    },
});
