/**
 * Layer UI Main Widget - Unified container for all layer-related UI components
 *
 * This module provides a single entry point for the layer management UI,
 * orchestrating the button bar, header widgets, and layer manager in a clean, modular way.
 *
 * Architecture:
 * - SplineLayerManager: Manages layer widget lifecycle (add, remove, duplicate, activate)
 * - Manages the lifecycle of button bar and header widgets
 * - Provides a clean API for adding layer UI to the node
 * - Encapsulates all layer UI component initialization
 *
 * Usage:
 *   import { initializeLayerUI, SplineLayerManager } from './layer_ui_main_widget.js';
 *   node.layerManager = new SplineLayerManager(node);
 *   initializeLayerUI(node);
 */

import { PowerSplineHeaderWidget } from './layer_header.js';
import { createButtonBarWidget } from './layer_add_buttons.js';
import { PowerSplineWidget } from './layer_type_spline.js';
import { HandDrawLayerWidget } from './layer_type_draw.js';
import { BoxLayerWidget } from './layer_type_box.js';
import { hasBackgroundVideo, syncVideoToFrame } from './canvas/canvas_video_background.js';
import { getLayerWidgetType as getLayerWidgetValueType, isLayerWidget } from './layer_widget_identity.js';

/**
 * SplineLayerManager - Manages the lifecycle of all layer widgets
 * Handles adding, removing, duplicating, and switching between layers
 */
export class SplineLayerManager {
    constructor(node) {
        this.node = node;
        this.activeWidget = null;
        this.node.splineWidgetsCounter = 0;
        this._noActiveSelection = false;
    }

    setActiveWidget(widget) {
        if (this.activeWidget === widget) {
            return;
        }
        // Track explicit "no selection" state
        this._noActiveSelection = (widget == null);
        // If the editor is in handdraw create/edit mode, disarm it when switching layers
        // Exception: when switch is initiated by handdraw commit flow, one-shot suppress exit
        try {
            const ed = this.node?.editor;
            const suppressOnce = !!ed?._suppressHanddrawExitOnce;
            if (ed) ed._suppressHanddrawExitOnce = false; // always reset flag
            if (ed && ed._handdrawMode && ed._handdrawMode !== 'off' && !suppressOnce) {
                ed.exitHanddrawMode?.(false);
            }
        } catch {}

        // Sync video to box layer timeline position
        if (widget?.value?.type === 'box_layer') {
            const currentFrame = widget.value.box_timeline_point || 1;
            const editor = this.node?.editor;
            if (editor && hasBackgroundVideo(editor)) {
                syncVideoToFrame(editor, currentFrame);
            }
        }

        this.activeWidget = widget;
        if (this.node.editor) {
            this.node.editor.onActiveLayerChanged(); // Notify canvas
        }
        this.node.setDirtyCanvas(true, true);
    }

    getActiveWidget() {
        if (this.activeWidget && !this.node.widgets.includes(this.activeWidget)) {
            this.activeWidget = null;
        }
        if (!this.activeWidget) {
            if (this._noActiveSelection) return null;
            const splines = this.getSplineWidgets();
            if (splines.length > 0) {
                // Find the first visible/active spline widget, not just any spline
                const visibleSpline = splines.find(w => w.value.on);
                if (visibleSpline) {
                    this.activeWidget = visibleSpline;
                } else {
                    // If no visible splines, we should not set an active widget
                    // This prevents trying to work with hidden layers
                    this.activeWidget = null;
                }
            }
        }
        return this.activeWidget;
    }

    getSplineWidgets() {
        return this.node.widgets.filter(isLayerWidget);
    }

    addNewSpline(name) {
        try {
            this.node?.editor?.exitHanddrawMode?.(false);
        } catch {}
        this.node.splineWidgetsCounter++;
        const widget = new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter);

        const baseName = name || `Spline ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);
        widget.value.type = 'spline';
        widget.value.offset = 0;
        widget.value.a_pause = 0;
        widget.value.z_pause = 0;
        widget.value.easing = 'in_out'; // Start with in_out as default (using simple naming)
        widget.value.easingConfig = { path: "full", strength: 1.0 }; // Start with full path and strength 1.0
        widget.value.driven = false; // Start with driven off
        widget.value._drivenConfig = { driver: "", rotate: 0, d_scale: 1.0 }; // Preserved config

        // Initialize with two points in normalized coordinates (center and slightly right)
        // Two points prevent rendering issues and provide proper direction
        const widthWidget = this.node.widgets.find(w => w.name === "mask_width");
        const heightWidget = this.node.widgets.find(w => w.name === "mask_height");
        const width = widthWidget ? widthWidget.value : 512;
        const height = heightWidget ? heightWidget.value : 512;
        const newPoints = [
            { x: Math.random() * 0.3 + 0.1, y: Math.random() * 0.8 + 0.1, highlighted: false },
            { x: Math.random() * 0.3 + 0.6, y: Math.random() * 0.8 + 0.1, highlighted: false }
        ];
        widget.value.points_store = JSON.stringify(newPoints);

        // Insert spline widgets AFTER the header (not before button_bar)
        // This ensures order: canvas → button_bar → header → splines
        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            // Find the last layer widget (spline or handdraw) after the header
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (isLayerWidget(wi)) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(widget);
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }
        this.node.setDirtyCanvas(true, true);
        return widget;
    }

    addNewHanddraw(name, activate = true) {
        this.node.splineWidgetsCounter++;
        const widget = new HandDrawLayerWidget("spline_" + this.node.splineWidgetsCounter);

        const baseName = name || `Handdraw ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);

        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (isLayerWidget(wi)) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        if (activate) {
            this.setActiveWidget(widget);
            if (this.node.editor && this.node.editor.vis) {
                this.node.editor.vis.render();
            }
            this.node.setDirtyCanvas(true, true);
        }
        return widget;
    }

    addNewBox(name, activate = true) {
        this.node.splineWidgetsCounter++;
        const widget = new BoxLayerWidget("box_" + this.node.splineWidgetsCounter);

        const baseName = name || `Box ${this.node.splineWidgetsCounter}`;
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        widget.value.name = this.node.generateUniqueName(baseName, existingNames);
        widget.value.points_store = JSON.stringify([{
            x: 0.5,
            y: 0.5,
            highlighted: false,
            boxScale: 1,
            pointScale: 1,
            scale: 1,
            rotation: 0,
            boxRotation: 0,
        }]);
        widget.value.box_keys = [];
        widget.value.box_timeline_point = 1;
        widget.value.interpolation = 'box';

        const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
        if (headerIndex !== -1) {
            let insertIndex = headerIndex + 1;
            for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                const wi = this.node.widgets[i];
                if (isLayerWidget(wi)) {
                    insertIndex = i + 1;
                } else {
                    break;
                }
            }
            this.node.widgets.splice(insertIndex, 0, widget);
            widget.parent = this.node;
        } else {
            this.node.addCustomWidget(widget);
        }

        this.node.updateNodeHeight();
        if (activate) {
            this.setActiveWidget(widget);
            if (this.node.editor && this.node.editor.vis) {
                this.node.editor.vis.render();
            }
            this.node.setDirtyCanvas(true, true);
        }
        return widget;
    }

    removeSpline(widget) {
        const index = this.node.widgets.indexOf(widget);
        if (index > -1) {
            // Get all spline widgets before removal
            const allSplines = this.getSplineWidgets();
            console.log("[SplineLayerManager] removeSpline: removing", widget?.value?.name, "total splines:", allSplines.length);

            // Check if the widget being removed is the active widget
            const removingActiveWidget = (this.activeWidget === widget);
            if (removingActiveWidget) {
                console.log("[SplineLayerManager] removeSpline: target is active widget");
                // Select a new active widget BEFORE removing the current one
                let newActiveWidget = null;

                // Try to find a replacement widget
                if (allSplines.length > 1) {
                    // Prefer the next visible spline, or previous if this is the last one
                    const currentIndex = allSplines.indexOf(widget);

                    // Try next visible spline
                    for (let i = currentIndex + 1; i < allSplines.length; i++) {
                        if (allSplines[i].value.on) {
                            newActiveWidget = allSplines[i];
                            break;
                        }
                    }

                    // If no visible spline found after current, try before
                    if (!newActiveWidget) {
                        for (let i = currentIndex - 1; i >= 0; i--) {
                            if (allSplines[i].value.on) {
                                newActiveWidget = allSplines[i];
                                break;
                            }
                        }
                    }

                    // If still no visible spline, just take the next one (or previous)
                    if (!newActiveWidget) {
                        if (currentIndex + 1 < allSplines.length) {
                            newActiveWidget = allSplines[currentIndex + 1];
                        } else if (currentIndex - 1 >= 0) {
                            newActiveWidget = allSplines[currentIndex - 1];
                        }
                    }
                }

                // Set the new active widget (triggers editor sync)
                this.setActiveWidget(newActiveWidget);
                console.log("[SplineLayerManager] removeSpline: new active widget", newActiveWidget?.value?.name);

                // If no active widget remains, clear the editor state
                if (this.node.editor && !this.activeWidget) {
                    // No splines left - clear the editor's points
                    console.log("[SplineLayerManager] removeSpline: no active widget, clearing editor points");
                    this.node.editor.points = [];
                    if (this.node.editor.layerRenderer) {
                        this.node.editor.layerRenderer.render();
                    }
                }
            }

            // Now remove the widget
            this.node.widgets.splice(index, 1);
            this.node.updateNodeHeight();

            const editor = this.node.editor;
            if (editor) {
                console.log("[SplineLayerManager] removeSpline: refresh editor state. Active widget:", this.activeWidget?.value?.name);
                if (this.activeWidget) {
                    // Refresh editor state based on newly active widget
                    if (typeof editor.onActiveLayerChanged === "function") {
                        console.log("[SplineLayerManager] removeSpline: calling editor.onActiveLayerChanged()");
                        editor.onActiveLayerChanged();
                    }
                    editor.points = editor.getActivePoints();
                    if (editor.layerRenderer) {
                        console.log("[SplineLayerManager] removeSpline: re-rendering layers");
                        editor.layerRenderer.render();
                    }
                    console.log("[SplineLayerManager] removeSpline: updating path");
                    editor.updatePath();
                } else {
                    // No active spline remains
                    editor.points = [];
                    if (editor.layerRenderer) {
                        console.log("[SplineLayerManager] removeSpline: no layers left, rendering empty");
                        editor.layerRenderer.render();
                    }
                }
                if (editor.vis) {
                    console.log("[SplineLayerManager] removeSpline: rendering editor vis");
                    editor.vis.render();
                }
            }

            this.node.setDirtyCanvas(true, true);
        }
    }

    duplicateSpline(sourceWidget) {
        if (!sourceWidget) return;

        try {
            this.node?.editor?.exitHanddrawMode?.(false);
        } catch {}
        this.node.splineWidgetsCounter++;
        const sourceType = getLayerWidgetValueType(sourceWidget);
        const isHand = sourceType === 'handdraw';
        const isBox = sourceType === 'box_layer';
        const WidgetClass = isHand ? HandDrawLayerWidget : (isBox ? BoxLayerWidget : PowerSplineWidget);
        const widgetIdPrefix = isBox ? "box_" : "spline_";
        const newWidget = new WidgetClass(widgetIdPrefix + this.node.splineWidgetsCounter);

        // Deep copy of value.
        const sourceValue = sourceWidget.value;
        const newValue = JSON.parse(JSON.stringify(sourceValue));

        // Generate a unique name
        const existingNames = this.getSplineWidgets().map(w => w.value.name);
        newValue.name = this.node.generateUniqueName(sourceValue.name, existingNames);

        newWidget.value = newValue;

        // Insert it after the source widget
        const sourceIndex = this.node.widgets.indexOf(sourceWidget);
        if (sourceIndex !== -1) {
            this.node.widgets.splice(sourceIndex + 1, 0, newWidget);
            newWidget.parent = this.node;
        } else {
            // Fallback, should not happen if sourceWidget is valid
            // Insert after header (same logic as addNewSpline)
            const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
            if (headerIndex !== -1) {
                let insertIndex = headerIndex + 1;
                for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                    const wi = this.node.widgets[i];
                    if (isLayerWidget(wi)) {
                        insertIndex = i + 1;
                    } else {
                        break;
                    }
                }
                this.node.widgets.splice(insertIndex, 0, newWidget);
                newWidget.parent = this.node;
            } else {
                this.node.addCustomWidget(newWidget);
            }
        }

        this.node.updateNodeHeight();
        this.setActiveWidget(newWidget);
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }
        this.node.setDirtyCanvas(true, true);
        return newWidget;
    }

    removeAllSplines() {
        // Remove all spline widgets
        const splineWidgets = this.getSplineWidgets();
        splineWidgets.forEach(widget => {
            const index = this.node.widgets.indexOf(widget);
            if (index > -1) {
                this.node.widgets.splice(index, 1);
            }
        });

        // Clear active widget reference
        this.activeWidget = null;

        // Update node height
        this.node.updateNodeHeight();

        // Trigger re-render of all layers
        if (this.node.editor && this.node.editor.layerRenderer) {
            this.node.editor.layerRenderer.render();
        }
        // Force canvas to update after node height change
        if (this.node.editor && this.node.editor.vis) {
            this.node.editor.vis.render();
        }

        this.node.setDirtyCanvas(true, true);
    }

    recreateSplinesFromData(widgets_values) {
        this.node.widgets = this.node.widgets.filter(w => !isLayerWidget(w));

        // Create a map of widget data by name for safe, unambiguous lookup
        // This prevents any cross-contamination between widget values
        const widgetDataByName = new Map();
        for (const widgetValue of widgets_values || []) {
            if (widgetValue?.name && widgetValue.interpolation !== undefined) {
                widgetDataByName.set(widgetValue.name, widgetValue);
            }
        }

        // Recreate widgets using name-based lookup with explicit field assignment
        for (const [name, widgetValue] of widgetDataByName.entries()) {
            this.node.splineWidgetsCounter++;
            const isHand = widgetValue.type === 'handdraw';
            const isBox = widgetValue.type === 'box_layer';
            const widgetIdPrefix = isBox ? "box_" : "spline_";
            const widget = isHand
                ? new HandDrawLayerWidget("spline_" + this.node.splineWidgetsCounter)
                : (isBox ? new BoxLayerWidget(widgetIdPrefix + this.node.splineWidgetsCounter)
                         : new PowerSplineWidget("spline_" + this.node.splineWidgetsCounter));

            // Explicitly assign each field to ensure complete isolation
            // No spread operators that might share references
            widget.value = {
                on: widgetValue.on !== undefined ? widgetValue.on : true,
                name: widgetValue.name,
                type: isBox ? 'box_layer' : (isHand ? 'handdraw' : 'spline'),
                interpolation: widgetValue.interpolation,
                repeat: widgetValue.repeat || 1,
                offset: widgetValue.offset || 0,
                a_pause: widgetValue.a_pause || 0,
                z_pause: widgetValue.z_pause || 0,
                easing: widgetValue.easing || 'linear',
                easingConfig: widgetValue.easingConfig || { path: "full", strength: 1.0 },
                driven: widgetValue.driven || false,
                _drivenConfig: widgetValue._drivenConfig || (typeof widgetValue.driven === 'object' ? {...widgetValue.driven} : { driver: "", rotate: 0, d_scale: 1.0 }),
                scale: widgetValue.scale !== undefined ? widgetValue.scale : 1.00,
                points_store: widgetValue.points_store || "[]",
                coordinates: widgetValue.coordinates || "[]"
            };
            if (isBox) {
                widget.value.box_keys = widgetValue.box_keys || [];
                widget.value.box_timeline_point = widgetValue.box_timeline_point || 1;
                widget.value.box_interpolation = widgetValue.box_interpolation || 'linear'; // Restore box interpolation
            }

            // Insert spline widgets AFTER the header (same as addNewSpline logic)
            const headerIndex = this.node.widgets.findIndex(w => w.name === "spline_header");
            if (headerIndex !== -1) {
                // Find the last layer widget after the header
                let insertIndex = headerIndex + 1;
                for (let i = headerIndex + 1; i < this.node.widgets.length; i++) {
                    const wi = this.node.widgets[i];
                    if (isLayerWidget(wi)) {
                        insertIndex = i + 1;
                    } else {
                        break;
                    }
                }
                this.node.widgets.splice(insertIndex, 0, widget);
                widget.parent = this.node;
            } else {
                this.node.widgets.push(widget);
                widget.parent = this.node;
            }
        }

        // Reset active widget since all spline widgets are being recreated
        // This is critical to prevent stale references after node restoration
        const oldActiveWidget = this.activeWidget;
        this.activeWidget = null;

        // If there were widgets before recreation, we should try to set a new active widget
        if (this.node.widgets.length > 0) {
            const splineWidgets = this.getSplineWidgets();
            if (splineWidgets.length > 0) {
                // Find the first visible spline as the new active widget
                const visibleSpline = splineWidgets.find(w => w.value.on);
                if (visibleSpline) {
                    this.activeWidget = visibleSpline;
                } else {
                    // If no visible splines, select the first one (even if hidden)
                    this.activeWidget = splineWidgets[0];
                }
            }
        }
    }
}

/**
 * Initialize all layer UI components and add them to the node
 * This is the main entry point for setting up the layer management interface
 *
 * @param {Object} node - The LiteGraph node to add layer UI to
 * @returns {Object} An object containing references to created widgets
 */
export function initializeLayerUI(node) {
    if (!node || !node.addCustomWidget) {
        console.error('initializeLayerUI: Invalid node provided');
        return null;
    }

    // Create button bar widget (Add Spline, Add Keyframes, Draw, Duplicate)
    const buttonBarWidget = createButtonBarWidget();

    // Create header widget (column labels)
    const headerWidget = new PowerSplineHeaderWidget("spline_header");

    // Add widgets to node in the correct order
    // Order matters: buttons first, then header, then individual layers will follow
    node.addCustomWidget(buttonBarWidget);
    node.addCustomWidget(headerWidget);

    // Return references for potential future use
    return {
        buttonBar: buttonBarWidget,
        header: headerWidget,
    };
}

/**
 * Get all layer type classes for type checking
 * This is useful for identifying layer widgets vs other widget types
 *
 * @returns {Object} Object containing all layer widget classes
 */
export function getLayerWidgetClasses() {
    // Lazy import to avoid circular dependencies
    const { PowerSplineWidget } = require('./layer_type_spline.js');
    const { HandDrawLayerWidget } = require('./layer_type_draw.js');
    const { BoxLayerWidget } = require('./layer_type_box.js');

    return {
        PowerSplineWidget,
        HandDrawLayerWidget,
        BoxLayerWidget,
    };
}

/**
 * Check if a widget is a layer widget (any type)
 *
 * @param {Object} widget - The widget to check
 * @returns {boolean} True if widget is a layer widget
 */
export { isLayerWidget } from './layer_widget_identity.js';

/**
 * Get the type name of a layer widget
 *
 * @param {Object} widget - The layer widget
 * @returns {string|null} The type name ('spline', 'handdraw', 'box') or null
 */
export function getLayerWidgetType(widget) {
    const type = getLayerWidgetValueType(widget);
    return type === 'box_layer' ? 'box' : type;
}
