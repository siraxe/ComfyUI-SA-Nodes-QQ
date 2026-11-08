import { app } from "../../scripts/app.js";

/**
 * "Latent Noise Mask with Curve" - curve editor widget.
 *
 * Lets the user draw a 2D curve (X: 0-100, Y: 0.00-1.00). The curve is
 * serialized as a JSON string into the "curve" widget value and used by the
 * python node to scale the noise mask along the latent batch.
 *
 * Interactions:
 *  - Drag points to move them
 *  - Click on empty plot area to add a point
 *  - Hold D + left-click a point to remove it (double-click also works)
 */

const WIDGET_NAME = "curve";
const EDITOR_HEIGHT = 150;
const MARGIN_L = 36;
const MARGIN_R = 10;
const MARGIN_T = 8;
const MARGIN_B = 18;

// Tracks whether "D" is held (D + left-click removes a point).
let dKeyHeld = false;
window.addEventListener("keydown", (e) => {
    if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        dKeyHeld = true;
        app.canvas.setDirty(true); // redraw so points show delete-mode tint
    }
});
window.addEventListener("keyup", (e) => {
    if (e.key === "d" || e.key === "D") {
        dKeyHeld = false;
        app.canvas.setDirty(true);
    }
});
window.addEventListener("blur", () => {
    dKeyHeld = false;
});

class CurveEditorWidget {
    constructor(name) {
        this.name = name;
        this.type = "curve_editor";
        this.value = "[[0,1.0],[100,1.0]]"; // JSON string of [[x,y], ...]
        this.options = {};
        this.y = 0;
        this.last_y = 0;
        this.height = EDITOR_HEIGHT;
        this.points = null; // lazily parsed from this.value
        this.dragIndex = -1;
        this.hoverIndex = -1;
        this.mouseDowned = false;
    }

    // ---- value <-> points -------------------------------------------------

    syncPoints() {
        if (this.points !== null) return;
        try {
            const parsed = JSON.parse(this.value);
            this.points = Array.isArray(parsed)
                ? parsed
                      .map((p) => [
                          Math.min(100, Math.max(0, Number(p[0]) || 0)),
                          Math.min(1, Math.max(0, Number(p[1]) || 0)),
                      ])
                      .sort((a, b) => a[0] - b[0])
                : null;
        } catch (e) {
            this.points = null;
        }
        if (!this.points || this.points.length < 2) {
            this.points = [
                [0, 1.0],
                [100, 1.0],
            ];
        }
    }

    serializeValue(node, index) {
        this.syncPoints();
        return JSON.stringify(this.points);
    }

    computeSize(width) {
        return [width, this.height];
    }

    // ---- coordinate helpers ----------------------------------------------

    plotRect(widgetWidth) {
        return {
            x: MARGIN_L,
            y: MARGIN_T,
            w: widgetWidth - MARGIN_L - MARGIN_R,
            h: this.height - MARGIN_T - MARGIN_B,
        };
    }

    toCanvasX(x, rect) {
        return rect.x + (x / 100) * rect.w;
    }

    toCanvasY(y, rect) {
        return rect.y + (1 - y) * rect.h;
    }

    fromCanvas(cx, cy, rect) {
        return [
            Math.min(100, Math.max(0, ((cx - rect.x) / rect.w) * 100)),
            Math.min(1, Math.max(0, 1 - (cy - rect.y) / rect.h)),
        ];
    }

    pointAt(cx, cy, rect) {
        for (let i = 0; i < this.points.length; i++) {
            const px = this.toCanvasX(this.points[i][0], rect);
            const py = this.toCanvasY(this.points[i][1], rect);
            const dx = cx - px;
            const dy = cy - py;
            if (dx * dx + dy * dy <= 81) return i; // 9px radius
        }
        return -1;
    }

    roundY(y) {
        return Math.round(y * 100) / 100;
    }

    // ---- drawing ----------------------------------------------------------

    draw(ctx, node, widgetWidth, widgetY, widgetHeight) {
        this.syncPoints();
        this.points.sort((a, b) => a[0] - b[0]);
        const rect = this.plotRect(widgetWidth);
        const colorBg = "#1b1b1f";
        const colorGrid = "#3a3a42";
        const colorAxis = "#666a75";
        const colorCurve = "#4db6e2";
        const colorFill = "rgba(77,182,226,0.10)";
        const colorPoint = "#ffffff";

        ctx.save();
        // Offset drawing to this widget's row (4th draw arg is the widget's
        // node-relative y, same value the draw loop stores in last_y)
        const oy = widgetY ?? this.last_y ?? 0;
        ctx.translate(0, oy);
        // background
        ctx.fillStyle = colorBg;
        ctx.beginPath();
        ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
        ctx.fill();

        // grid
        ctx.strokeStyle = colorGrid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let gx = 0; gx <= 100; gx += 25) {
            const cx = Math.round(this.toCanvasX(gx, rect)) + 0.5;
            ctx.moveTo(cx, rect.y);
            ctx.lineTo(cx, rect.y + rect.h);
        }
        for (let gy = 0; gy <= 1.001; gy += 0.25) {
            const cy = Math.round(this.toCanvasY(gy, rect)) + 0.5;
            ctx.moveTo(rect.x, cy);
            ctx.lineTo(rect.x + rect.w, cy);
        }
        ctx.stroke();

        // axes
        ctx.strokeStyle = colorAxis;
        ctx.beginPath();
        ctx.rect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
        ctx.stroke();

        // labels
        ctx.fillStyle = "#9aa0aa";
        ctx.font = "10px Arial";
        ctx.textAlign = "center";
        ctx.fillText("100", this.toCanvasX(100, rect), rect.y + rect.h + 13);
        ctx.fillText("50", this.toCanvasX(50, rect), rect.y + rect.h + 13);
        ctx.fillText("0", this.toCanvasX(0, rect), rect.y + rect.h + 13);
        ctx.textAlign = "right";
        ctx.fillText("1.0", rect.x - 4, this.toCanvasY(1, rect) + 3);
        ctx.fillText("0.5", rect.x - 4, this.toCanvasY(0.5, rect) + 3);
        ctx.fillText("0.0", rect.x - 4, this.toCanvasY(0, rect) + 3);

        // curve area fill (down to y=0)
        ctx.beginPath();
        ctx.moveTo(this.toCanvasX(this.points[0][0], rect), this.toCanvasY(0, rect));
        for (const p of this.points) {
            ctx.lineTo(this.toCanvasX(p[0], rect), this.toCanvasY(p[1], rect));
        }
        ctx.lineTo(this.toCanvasX(this.points[this.points.length - 1][0], rect), this.toCanvasY(0, rect));
        ctx.closePath();
        ctx.fillStyle = colorFill;
        ctx.fill();

        // curve line
        ctx.beginPath();
        ctx.moveTo(this.toCanvasX(this.points[0][0], rect), this.toCanvasY(this.points[0][1], rect));
        for (const p of this.points) {
            ctx.lineTo(this.toCanvasX(p[0], rect), this.toCanvasY(p[1], rect));
        }
        ctx.strokeStyle = colorCurve;
        ctx.lineWidth = 2;
        ctx.stroke();

        // points (tinted red while D is held = delete mode)
        const deleteMode = dKeyHeld;
        for (let i = 0; i < this.points.length; i++) {
            const px = this.toCanvasX(this.points[i][0], rect);
            const py = this.toCanvasY(this.points[i][1], rect);
            ctx.beginPath();
            ctx.arc(px, py, i === this.hoverIndex || i === this.dragIndex ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fillStyle = deleteMode ? "#e05555" : colorPoint;
            ctx.fill();
            if (deleteMode) {
                ctx.strokeStyle = "#a03030";
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            if (i === this.hoverIndex || i === this.dragIndex) {
                // tooltip-style value label
                ctx.fillStyle = "rgba(0,0,0,0.8)";
                const label = Math.round(this.points[i][0]) + " | " + this.points[i][1].toFixed(2);
                const tw = ctx.measureText(label).width + 8;
                let tx = px - tw / 2;
                tx = Math.max(rect.x, Math.min(rect.x + rect.w - tw, tx));
                let ty = py - 20;
                if (ty < rect.y) ty = py + 8;
                ctx.beginPath();
                ctx.roundRect(tx, ty, tw, 14, 3);
                ctx.fill();
                ctx.fillStyle = "#fff";
                ctx.textAlign = "left";
                ctx.fillText(label, tx + 4, ty + 11);
            }
        }

        ctx.restore();
    }

    // ---- interaction -------------------------------------------------------

    isClick(e) {
        return e.type === "pointerdown" || e.type === "mousedown";
    }

    isMove(e) {
        return e.type === "pointermove" || e.type === "mousemove";
    }

    isUp(e) {
        return e.type === "pointerup" || e.type === "mouseup" || e.type === "pointercancel";
    }

    mouse(event, pos, node) {
        const rect = this.plotRect(node.size[0]);
        // pos is relative to the node; subtract this widget's y offset
        // (last_y is set by the draw loop, y as fallback for older litegraph)
        const widgetY = this.last_y ?? this.y ?? 0;
        const cx = pos[0];
        const cy = pos[1] - widgetY;
        const insidePlot = cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
        const leftClick = event.button === 0;

        if (this.isClick(event)) {
            if (!insidePlot) return false;
            this.syncPoints();
            const hit = this.pointAt(cx, cy, rect);

            if (leftClick && dKeyHeld) {
                // D + left-click removes the clicked point (keep at least 2)
                if (hit >= 0 && this.points.length > 2) {
                    this.points.splice(hit, 1);
                    this.hoverIndex = -1;
                    this.markDirty(node);
                }
                return true; // consume click while in delete mode (no add/drag)
            }

            if (hit >= 0) {
                this.dragIndex = hit;
            } else {
                const [x, y] = this.fromCanvas(cx, cy, rect);
                this.points.push([Math.round(x), this.roundY(y)]);
                this.points.sort((a, b) => a[0] - b[0]);
                this.dragIndex = this.pointAt(cx, cy, rect);
                this.markDirty(node);
            }
            this.mouseDowned = true;
            return true;
        }

        if (this.isMove(event)) {
            const hit = insidePlot ? this.pointAt(cx, cy, rect) : -1;
            if (hit !== this.hoverIndex) {
                this.hoverIndex = hit;
                this.markDirty(node);
            }
            if (!this.mouseDowned || this.dragIndex < 0) {
                return this.hoverIndex >= 0;
            }
            const [x, y] = this.fromCanvas(cx, cy, rect);
            // clamp x so a point cannot cross its neighbours while dragging
            const minX = this.dragIndex === 0 ? 0 : this.points[this.dragIndex - 1][0];
            const maxX = this.dragIndex === this.points.length - 1 ? 100 : this.points[this.dragIndex + 1][0];
            const clampedX = Math.min(Math.max(Math.round(x), minX), maxX);
            this.points[this.dragIndex] = [clampedX, this.roundY(y)];
            this.markDirty(node);
            return true;
        }

        if (this.isUp(event)) {
            if (!this.mouseDowned) return false;
            this.mouseDowned = false;
            this.dragIndex = -1;
            this.markDirty(node);
            return true;
        }

        if (event.type === "dblclick" || event.type === "pointerdblclick") {
            if (insidePlot) {
                const hit = this.pointAt(cx, cy, rect);
                if (hit >= 0 && this.points.length > 2) {
                    this.points.splice(hit, 1);
                    this.markDirty(node);
                    return true;
                }
            }
            return false;
        }

        return false;
    }

    markDirty(node) {
        node.setDirtyCanvas?.(true, true);
        app.canvas.setDirty(true);
        node.graph?.change();
    }
}

app.registerExtension({
    name: "ComfyUI-SA-Nodes-QQ.LatentNoiseMaskWithCurve",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "LatentNoiseMaskWithCurve") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            const idx = this.widgets?.findIndex((w) => w.name === WIDGET_NAME);
            if (idx >= 0) {
                // Remove the plain string widget and put the curve editor at the
                // bottom of the node (this keeps widgets_values order stable,
                // since it is always moved to the end on node creation)
                this.widgets.splice(idx, 1);
                const editor = new CurveEditorWidget(WIDGET_NAME);
                if (typeof this.addCustomWidget === "function") {
                    this.addCustomWidget(editor);
                } else {
                    (this.widgets = this.widgets || []).push(editor);
                }
                // Grow the node so the editor is fully visible
                this.size[1] += editor.computeSize(this.size[0])[1];
            }
            return r;
        };
    },
});
