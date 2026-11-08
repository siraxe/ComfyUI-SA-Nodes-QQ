// Button bar widget for adding layers (Add Spline, Add Keyframes, Draw, Duplicate)
import { QQBaseWidget, drawWidgetButton } from './drawing_utils.js';

/**
 * Creates a button bar widget with Add Spline, Add Keyframes, Draw, and Duplicate buttons
 * @returns {QQBaseWidget} The configured button bar widget
 */
export function createButtonBarWidget() {
    const buttonBarWidget = new QQBaseWidget("button_bar");
    buttonBarWidget.type = "custom";
    buttonBarWidget.serialize = false;

    // Track mouse state for button hover effects
    buttonBarWidget.addSplineMouseDown = false;
    buttonBarWidget.addBoxMouseDown = false;
    buttonBarWidget.drawMouseDown = false;
    buttonBarWidget.duplicateMouseDown = false;

    buttonBarWidget.computeSize = function(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    };

    buttonBarWidget.draw = function(ctx, node, width, posY, height) {
        const margin = 15;
        const gap = 5;
        const totalWidth = width - margin * 2 - gap * 3;
        const addSplineWidth = totalWidth * 0.30;
        const addBoxWidth = totalWidth * 0.30;
        const drawWidth = totalWidth * 0.20;
        const duplicateWidth = totalWidth * 0.20;
        const addSplineX = margin;
        const addBoxX = addSplineX + addSplineWidth + gap;
        const drawX = addBoxX + addBoxWidth + gap;
        const duplicateX = drawX + drawWidth + gap;

        // Draw Add Spline button (30% width)
        drawWidgetButton(
            ctx,
            { size: [addSplineWidth, height], pos: [addSplineX, posY] },
            "➕ Add Spline",
            this.addSplineMouseDown
        );

        // Draw Add Box button (30% width)
        drawWidgetButton(
            ctx,
            { size: [addBoxWidth, height], pos: [addBoxX, posY] },
            "🎥 Add Keyframes",
            this.addBoxMouseDown
        );

        // Draw button (20% width)
        drawWidgetButton(
            ctx,
            { size: [drawWidth, height], pos: [drawX, posY] },
            "✏️ Draw",
            this.drawMouseDown || (node?.editor?._handdrawMode === 'create')
        );

        // Draw Duplicate button (20% width)
        drawWidgetButton(
            ctx,
            { size: [duplicateWidth, height], pos: [duplicateX, posY] },
            "🧬 Duplicate",
            this.duplicateMouseDown
        );
    };

    buttonBarWidget.mouse = function(event, pos, node) {
        if (event.type === "pointerdown" || event.type === "mousedown") {
            const margin = 15;
            const gap = 5;
            const width = node.size[0];
            const totalWidth = width - margin * 2 - gap * 3;
            const addSplineWidth = totalWidth * 0.30;
            const addBoxWidth = totalWidth * 0.30;
            const drawWidth = totalWidth * 0.20;
            const duplicateWidth = totalWidth * 0.20;
            const addSplineLeft = margin;
            const addSplineRight = addSplineLeft + addSplineWidth;
            const addBoxLeft = addSplineRight + gap;
            const addBoxRight = addBoxLeft + addBoxWidth;
            const drawLeft = addBoxRight + gap;
            const drawRight = drawLeft + drawWidth;
            const duplicateLeft = drawRight + gap;
            const duplicateRight = duplicateLeft + duplicateWidth;

            if (pos[0] >= addSplineLeft && pos[0] <= addSplineRight) {
                this.addSplineMouseDown = true;
                node.setDirtyCanvas(true, false);
                return true;
            }
            else if (pos[0] >= addBoxLeft && pos[0] <= addBoxRight) {
                this.addBoxMouseDown = true;
                node.setDirtyCanvas(true, false);
                return true;
            }
            else if (pos[0] >= drawLeft && pos[0] <= drawRight) {
                this.drawMouseDown = true;
                node.setDirtyCanvas(true, false);
                return true;
            }
            else if (pos[0] >= duplicateLeft &&
                     pos[0] <= duplicateRight) {
                this.duplicateMouseDown = true;
                node.setDirtyCanvas(true, false);
                return true;
            }
        }
        else if (event.type === "pointerup" || event.type === "mouseup") {
            const margin = 15;
            const gap = 5;
            const width = node.size[0];
            const totalWidth = width - margin * 2 - gap * 3;
            const addSplineWidth = totalWidth * 0.30;
            const addBoxWidth = totalWidth * 0.30;
            const drawWidth = totalWidth * 0.20;
            const duplicateWidth = totalWidth * 0.20;
            const addSplineLeft = margin;
            const addSplineRight = addSplineLeft + addSplineWidth;
            const addBoxLeft = addSplineRight + gap;
            const addBoxRight = addBoxLeft + addBoxWidth;
            const drawLeft = addBoxRight + gap;
            const drawRight = drawLeft + drawWidth;
            const duplicateLeft = drawRight + gap;
            const duplicateRight = duplicateLeft + duplicateWidth;

            if (this.addSplineMouseDown &&
                pos[0] >= addSplineLeft && pos[0] <= addSplineRight) {
                if (node?.editor && node.editor._handdrawMode === 'create') {
                    node.editor.exitHanddrawMode?.(false);
                }
                node.layerManager.addNewSpline();
            }
            else if (this.addBoxMouseDown &&
                pos[0] >= addBoxLeft && pos[0] <= addBoxRight) {
                if (node?.editor && node.editor._handdrawMode === 'create') {
                    node.editor.exitHanddrawMode?.(false);
                }
                if (node.layerManager?.addNewBox) {
                    node.layerManager.addNewBox();
                }
            }
            else if (this.drawMouseDown &&
                pos[0] >= drawLeft && pos[0] <= drawRight) {
                if (node?.editor) {
                    if (node.editor._handdrawMode === 'create') {
                        node.editor.exitHanddrawMode?.(false);
                    } else {
                        node.editor.enterHanddrawMode?.('create');
                    }
                    node.setDirtyCanvas(true, true);
                }
            }
            else if (this.duplicateMouseDown &&
                pos[0] >= duplicateLeft && pos[0] <= duplicateRight) {
                if (node?.editor && node.editor._handdrawMode === 'create') {
                    node.editor.exitHanddrawMode?.(false);
                }
                const activeWidget = node.layerManager.getActiveWidget();
                if (activeWidget) {
                    node.layerManager.duplicateSpline(activeWidget);
                }
            }

            this.addSplineMouseDown = false;
            this.addBoxMouseDown = false;
            this.drawMouseDown = false;
            this.duplicateMouseDown = false;
            node.setDirtyCanvas(true, false);
            return true;
        }
        return false;
    };

    return buttonBarWidget;
}
