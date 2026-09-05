/**
 * Compare Row Widget for Power Compare Video
 *
 * Row above the playback area: three mode buttons on the left
 * (slide-compare / B-on-right / B-on-bottom, canvas-drawn icons), then two
 * pick buttons (A/B - which video the images output returns), and an fps
 * stepper on the right (same look as PowerLoadVideo's top row).
 * The active compare mode lives on the node (node.compareMode) and is
 * persisted via node.properties.compare_mode; the output pick lives on
 * node.outputPick and is persisted via node.properties.output_pick plus the
 * hidden output_pick combo widget.
 */
import { app } from '../../../scripts/app.js';
import { RgthreeBaseWidget } from '../power_spline_editor/drawing_utils.js';

export class PowerCompareRowWidget extends RgthreeBaseWidget {
    constructor(name = "PowerCompareRow") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.fpsValue = 24;
        this.haveMouseMovedValue = false;

        // Persistent hit area objects (bounds updated during draw)
        this.hitAreas = {
            modeSlide: { bounds: [0, 0, 0, 0] },
            modeRight: { bounds: [0, 0, 0, 0] },
            modeBottom: { bounds: [0, 0, 0, 0] },
            pickA: { bounds: [0, 0, 0, 0] },
            pickB: { bounds: [0, 0, 0, 0] },
            fpsDec: { bounds: [0, 0, 0, 0] },
            fpsVal: { bounds: [0, 0, 0, 0] },
            fpsInc: { bounds: [0, 0, 0, 0] },
            fpsAny: { bounds: [0, 0, 0, 0] },
        };
    }

    draw(ctx, node) {
        const margin = 15;
        const spacing = 8;
        const rowY = this.y + 2;
        const rowH = 28;
        const midY = rowY + rowH / 2;

        ctx.save();
        ctx.textBaseline = "middle";

        // === Mode buttons (left side) ===
        const btnW = 34;
        const btnH = 28;
        const modes = [
            ["modeSlide", "slide"],
            ["modeRight", "right"],
            ["modeBottom", "bottom"],
        ];
        modes.forEach(([key, mode], i) => {
            const bx = margin + i * (btnW + spacing);
            const active = (node.compareMode || "slide") === mode;
            this.drawModeButton(ctx, bx, rowY, btnW, btnH, mode, active);
            const area = this.hitAreas[key];
            area.bounds = [bx, rowY, btnW, btnH];
            if (!area.onClick) {
                area.onClick = (_e, _pos, n) => this.setMode(n, mode);
            }
        });

        // === Pick A/B buttons (after a small gap) ===
        const groupGap = 14;
        const picks = [
            ["pickA", "A"],
            ["pickB", "B"],
        ];
        const pickBaseX = margin + modes.length * (btnW + spacing) + groupGap - spacing;
        picks.forEach(([key, pick], i) => {
            const bx = pickBaseX + i * (btnW + spacing);
            const active = (node.outputPick || "A") === pick;
            this.drawPickButton(ctx, bx, rowY, btnW, btnH, pick, active);
            const area = this.hitAreas[key];
            area.bounds = [bx, rowY, btnW, btnH];
            if (!area.onClick) {
                area.onClick = (_e, _pos, n) => this.setPick(n, pick);
            }
        });

        // === FPS stepper (right side) ===
        const arrowW = 12;
        const textW = 26;
        const spinnerW = arrowW * 2 + textW;
        const spinnerX = node.size[0] - margin - spinnerW;

        ctx.font = "12px Sans-Serif";
        ctx.textAlign = "left";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText("fps:", spinnerX - ctx.measureText("fps:").width - 8, midY);

        ctx.textAlign = "center";
        ctx.fillText("◄", spinnerX + arrowW * 0.5, midY);
        ctx.fillText(String(this.fpsValue), spinnerX + arrowW + textW * 0.5, midY);
        ctx.fillText("▶", spinnerX + arrowW + textW + arrowW * 0.5, midY);

        this.hitAreas.fpsDec.bounds = [spinnerX, rowY, arrowW, rowH];
        this.hitAreas.fpsVal.bounds = [spinnerX + arrowW, rowY, textW, rowH];
        this.hitAreas.fpsInc.bounds = [spinnerX + arrowW + textW, rowY, arrowW, rowH];
        this.hitAreas.fpsAny.bounds = [spinnerX, rowY, spinnerW, rowH];
        if (!this.hitAreas.fpsDec.onClick) this.hitAreas.fpsDec.onClick = () => this.stepFps(node, -1);
        if (!this.hitAreas.fpsInc.onClick) this.hitAreas.fpsInc.onClick = () => this.stepFps(node, 1);
        if (!this.hitAreas.fpsVal.onClick) this.hitAreas.fpsVal.onClick = () => this.promptFps(node);
        if (!this.hitAreas.fpsAny.onMove) this.hitAreas.fpsAny.onMove = (event) => this.dragFps(node, event);

        ctx.restore();
    }

    drawModeButton(ctx, x, y, w, h, mode, active) {
        ctx.save();

        // Rounded button background (active = cyan, PowerLoadVideo style)
        ctx.fillStyle = active ? "#0d3b4a" : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = active ? "#2cc6ff" : LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, w, h, [6]);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.fill();
        ctx.stroke();

        // Icon inside (letterboxed to the button interior)
        const padX = 7;
        const padY = 7;
        const bx = x + padX;
        const by = y + padY;
        const bw = w - padX * 2;
        const bh = h - padY * 2;
        const ic = active ? "#2cc6ff" : "#9a9a9a";
        ctx.strokeStyle = ic;
        ctx.fillStyle = ic;
        ctx.lineWidth = 1.5;

        if (mode === "slide") {
            // Rectangle + center divider + round handle (slide compare)
            ctx.beginPath();
            ctx.rect(bx, by, bw, bh);
            ctx.stroke();
            ctx.save();
            ctx.globalAlpha = 0.25;
            ctx.fillRect(bx, by, bw / 2, bh);
            ctx.restore();
            ctx.beginPath();
            ctx.moveTo(bx + bw / 2, by);
            ctx.lineTo(bx + bw / 2, by + bh);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(bx + bw / 2, by + bh / 2, 2.5, 0, Math.PI * 2);
            ctx.fill();
        } else if (mode === "right") {
            // Two panes side by side (B pane on the right, tinted)
            const gap = 3;
            const pw = (bw - gap) / 2;
            ctx.strokeRect(bx, by, pw, bh);
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.fillRect(bx + pw + gap, by, pw, bh);
            ctx.restore();
            ctx.strokeRect(bx + pw + gap, by, pw, bh);
        } else {
            // bottom: two stacked panes (B pane below, tinted)
            const gap = 3;
            const ph = (bh - gap) / 2;
            ctx.strokeRect(bx, by, bw, ph);
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.fillRect(bx, by + ph + gap, bw, ph);
            ctx.restore();
            ctx.strokeRect(bx, by + ph + gap, bw, ph);
        }

        ctx.restore();
    }

    drawPickButton(ctx, x, y, w, h, letter, active) {
        ctx.save();

        // Same rounded background as the mode buttons
        ctx.fillStyle = active ? "#0d3b4a" : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = active ? "#2cc6ff" : LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, w, h, [6]);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.fill();
        ctx.stroke();

        // Bold A/B letter, centered
        ctx.font = "bold 14px Sans-Serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = active ? "#2cc6ff" : "#9a9a9a";
        ctx.fillText(letter, x + w / 2, y + h / 2 + 0.5);

        ctx.restore();
    }

    setPick(node, pick) {
        node.outputPick = pick;
        node.properties = node.properties || {};
        node.properties.output_pick = pick;
        // Keep the hidden backend widget in sync (serialization + next run)
        const w = node.widgets?.find((w) => w.name === "output_pick");
        if (w) w.value = pick;
        node.setDirtyCanvas(true, true);
    }

    setMode(node, mode) {
        node.compareMode = mode;
        node.properties = node.properties || {};
        node.properties.compare_mode = mode;
        if (typeof node.updateDisplayCanvas === "function") {
            node.updateDisplayCanvas(node.timelineWidget?.value?.currentFrame || 1);
        }
        node.setDirtyCanvas(true, true);
    }

    applyFps(node, value) {
        let v = Math.round(Number(value));
        if (isNaN(v)) return;
        v = Math.max(1, Math.min(120, v));
        this.fpsValue = v;
        // Keep the hidden backend widget in sync (serialization + next run)
        const w = node.widgets?.find((w) => w.name === "fps");
        if (w) w.value = v;
        // Live playback speed
        if (node.timelineWidget) {
            node.timelineWidget.value.fps = v;
            if (node.timelineWidget.value.isPlaying) {
                // Restart loop so it picks up the new frame interval
                node.timelineWidget.startPlayback(node);
            }
        }
        node.setDirtyCanvas(true, true);
    }

    stepFps(node, step) {
        this.applyFps(node, this.fpsValue + step);
    }

    promptFps(node) {
        if (this.haveMouseMovedValue) return;
        app.canvas.prompt("FPS", this.fpsValue, (v) => this.applyFps(node, v));
    }

    dragFps(node, event) {
        if (event.deltaX) {
            this.haveMouseMovedValue = true;
            this.stepFps(node, Math.sign(event.deltaX));
        }
    }

    onMouseUp(event, pos, node) {
        if (super.onMouseUp) {
            super.onMouseUp(event, pos, node);
        }
        this.haveMouseMovedValue = false;
    }

    computeSize(width) {
        return [width, 32];
    }
}
