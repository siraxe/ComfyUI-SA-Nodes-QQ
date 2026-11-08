// Header widget that displays column labels for spline layers
import { app } from '../../../scripts/app.js';
import { isLowQuality, drawTogglePart, drawNumberWidgetPart, QQBaseWidget } from './drawing_utils.js';

export class PowerSplineHeaderWidget extends QQBaseWidget {
    constructor(name = "PowerSplineHeaderWidget") {
        super(name);
        this.value = { type: "PowerSplineHeaderWidget" };
        this.type = "custom";
        this.options = { serialize: false };
        this.hitAreas = {
            toggle: { bounds: [0, 0], onDown: this.onToggleDown },
        };
    }

    draw(ctx, node, w, posY, height) {
        const margin = 10;
        const innerMargin = margin * 0.33;
        const lowQuality = isLowQuality();
        const allSplineState = node.allSplinesState ? node.allSplinesState() : false;
        posY += 2;
        const midY = posY + height * 0.5;
        let posX = 10;
        ctx.save();
        this.hitAreas.toggle.bounds = drawTogglePart(ctx, { posX, posY, height, value: allSplineState });
        if (!lowQuality) {
            posX += this.hitAreas.toggle.bounds[1] + innerMargin;
            ctx.globalAlpha = app.canvas.editor_alpha * 0.55;
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("Toggle All", posX, midY);

            let rposX = node.size[0] - margin - innerMargin - innerMargin;
            ctx.textAlign = "center";

            // Match the widget layout exactly:
            // 1. Repeat control (far right) - drawNumberWidgetPart.WIDTH_TOTAL = 56
            const repeatWidth = drawNumberWidgetPart.WIDTH_TOTAL;
            ctx.fillText("Repeat", rposX - repeatWidth / 2, midY);
            rposX -= repeatWidth + 10;

            // 2. Interpolation selector - just text, no arrows (width = 70)
            const interpTextWidth = 70;
            ctx.fillText("Type", rposX - interpTextWidth / 2, midY);
            rposX -= interpTextWidth + 10;

            const numberWidth = drawNumberWidgetPart.WIDTH_TOTAL;
            ctx.fillText("Z-Pause", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            ctx.fillText("A-Pause", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
            ctx.fillText("Offset", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;

            // Easing column - same width as interpolation
            const easingTextWidth = 70;
            ctx.fillText("Easing", rposX - easingTextWidth / 2, midY);
            rposX -= easingTextWidth + 10;

            // Scale column
            ctx.fillText("Scale", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;

            // Driven column (moved after Scale)
            ctx.fillText("Driven", rposX - numberWidth / 2, midY);
            rposX -= numberWidth + 10;
        }
        ctx.restore();
    }

    onToggleDown(event, pos, node) {
        if (node.toggleAllSplines) {
            node.toggleAllSplines();
        }
        this.cancelMouseDown();
        return true;
    }
}
