// Simple reference layer widget
import { QQBaseWidget, drawRoundedRectangle } from './drawing_utils.js';
import { app } from '../../../scripts/app.js';

export class RefLayerWidget extends QQBaseWidget {
    constructor(name) {
        super(name);
        this.type = "custom";
        this.options = { serialize: true };
        this._value = {
            on: true,
            name: "ref_1",
            lassoShape: {
                additivePaths: [],
                subtractivePaths: []
            },
        };
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown.bind(this) },
            name: { bounds: [0, 0], onClick: this.onNameClick.bind(this) },
            delete: { bounds: [0, 0], onClick: this.onDeleteClick.bind(this) },
        };
    }

    set value(v) {
        this._value = { ...this._value, ...(typeof v === 'object' && v !== null ? v : {}) };
    }

    get value() {
        return this._value;
    }

    onToggleDown() {
        this._value.on = !this._value.on;
        app.canvas.setDirty(true);
    }

    onNameClick() {
        // Could implement rename in future
    }

    onDeleteClick() {
        if (this.node && this.node.removeRefLayer) {
            this.node.removeRefLayer(this);
        }
    }

    draw(ctx, node, w, posY, height) {
        ctx.save();
        const margin = 10;
        const innerMargin = margin * 0.33;
        const midY = posY + height * 0.5;
        let posX = margin;

        // Highlight if active
        if (node.layerManager && node.layerManager.getActiveWidget() === this) {
            drawRoundedRectangle(ctx, {
                pos: [posX, posY],
                size: [node.size[0] - margin * 2, height],
                colorStroke: "#ff6b6b",
                colorBackground: "#1a0000E6"
            });
        } else {
            drawRoundedRectangle(ctx, { pos: [posX, posY], size: [node.size[0] - margin * 2, height], colorBackground: "#222222CC" });
        }

        // Draw toggle (enable/disable)
        const toggleSize = 16;
        const toggleX = posX + innerMargin;
        const toggleY = midY - toggleSize / 2;
        ctx.fillStyle = this._value.on ? "#ff6b6b" : "#555555";
        ctx.fillRect(toggleX, toggleY, toggleSize, toggleSize);
        ctx.strokeStyle = "#888888";
        ctx.lineWidth = 1;
        ctx.strokeRect(toggleX, toggleY, toggleSize, toggleSize);
        this.hitAreas.toggle.bounds = [toggleX, toggleSize];
        posX += toggleSize + innerMargin * 2;

        if (!this._value.on) {
            ctx.globalAlpha = app.canvas.editor_alpha * 0.4;
        }

        // Draw name
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textBaseline = "middle";
        ctx.font = `12px Arial`;
        ctx.textAlign = "left";
        const nameWidth = 80;
        ctx.fillText(this._value.name, posX, midY);
        this.hitAreas.name.bounds = [posX, nameWidth];

        // Draw delete button on the right (red X)
        const deleteSize = 14;
        const deleteX = node.size[0] - margin - deleteSize - innerMargin;
        const deleteY = midY - deleteSize / 2;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ff6b6b";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(deleteX, deleteY);
        ctx.lineTo(deleteX + deleteSize, deleteY + deleteSize);
        ctx.moveTo(deleteX + deleteSize, deleteY);
        ctx.lineTo(deleteX, deleteY + deleteSize);
        ctx.stroke();
        this.hitAreas.delete.bounds = [deleteX - 5, deleteSize + 10];

        ctx.restore();
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
