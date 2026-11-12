/**
 * Audio Timeline Widget for Power Load Audio
 *
 * A single compact widget containing:
 *   1. An analysis lane (waveform / loudness dB / beat onsets) with a
 *      seconds ruler - the waveform compresses/stretches with speed so the
 *      user can see where drops land at what frame.
 *   2. A playback track row (play button, scrub track, [ ] crop markers,
 *      frame/seconds counter).
 *
 * Both rows share the exact same track x-range, so anything seen in the
 * analysis lane maps 1:1 onto the timeline below it.
 */
import { QQBaseWidget } from '../power_spline_editor/drawing_utils.js';

// Number of pre-computed peak/rms buckets over the full source duration
export const AUDIO_PEAK_BUCKETS = 1600;

// Shared layout constants so the lane and the track stay perfectly aligned
export const AUDIO_TRACK_GEO = {
    pad: 12,           // outer padding from node edge
    containerPad: 8,   // padding inside the rounded container
    playSize: 20,      // play button size
    spacer: 10,
};

export function audioTrackGeometry(nodeWidth) {
    const containerX = AUDIO_TRACK_GEO.pad;
    const containerWidth = Math.max(40, nodeWidth - AUDIO_TRACK_GEO.pad * 2);
    const trackX = containerX + AUDIO_TRACK_GEO.containerPad + AUDIO_TRACK_GEO.playSize + AUDIO_TRACK_GEO.spacer;
    // Full width: the frame/time counter moved to the stats row below
    const trackWidth = Math.max(20, containerWidth - AUDIO_TRACK_GEO.containerPad * 2
        - AUDIO_TRACK_GEO.playSize - AUDIO_TRACK_GEO.spacer);
    return { containerX, containerWidth, trackX, trackWidth };
}

function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, [r]);
        return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, Math.PI * 1.5, Math.PI * 2);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI * 0.5);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI * 0.5, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
}

function fmtTime(t) {
    t = Math.max(0, t);
    if (t < 60) return `${t.toFixed(1)}s`;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function levelColor(l) {
    // quiet steel-blue -> loud orange
    const r = Math.round(40 + 215 * l);
    const g = Math.round(198 - 86 * l);
    const b = Math.round(255 - 188 * l);
    return `rgb(${r},${g},${b})`;
}

export const AUDIO_VIEWS = ['WAVE', 'dB', 'BEATS'];

const SPINNER_TOTAL = 16 + 32 + 16; // arrows + text

function drawSpinner(ctx, posX, posY, height, text) {
    const arrowW = 16;
    const textW = 32;
    const midY = posY + height * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.font = '12px Sans-Serif';
    ctx.fillText('◄', posX + arrowW / 2, midY);
    ctx.fillText(text, posX + arrowW + textW / 2, midY);
    ctx.fillText('►', posX + arrowW + textW + arrowW / 2, midY);
    return [
        [posX, posY, arrowW, height],
        [posX + arrowW, posY, textW, height],
        [posX + arrowW + textW, posY, arrowW, height],
    ];
}

export class PowerAudioTimelineWidget extends QQBaseWidget {
    constructor(name = "PowerAudioTimeline") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {
            isPlaying: false,
            currentFrame: 1,
            totalFrames: 1,
            fps: 24,
        };

        this.viewIndex = 0; // which analysis view is shown (cycles AUDIO_VIEWS)

        this.hitAreas = {
            laneTrack: { bounds: [0, 0, 0, 0], onClick: null, onMove: null },
            viewLabel: { bounds: [0, 0], onClick: null },
            playButton: { bounds: [0, 0, 0, 0], onClick: null },
            track: { bounds: [0, 0, 0, 0], onClick: null, onMove: null },
            startMarker: { bounds: [0, 0, 0, 0], onDown: null, onMove: null },
            endMarker: { bounds: [0, 0, 0, 0], onDown: null, onMove: null },
            fpsDec: { bounds: [0, 0, 0, 0], onClick: null },
            fpsVal: { bounds: [0, 0, 0, 0], onClick: null },
            fpsInc: { bounds: [0, 0, 0, 0], onClick: null },
            fpsAny: { bounds: [0, 0, 0, 0], onMove: null },
            spdDec: { bounds: [0, 0, 0, 0], onClick: null },
            spdVal: { bounds: [0, 0, 0, 0], onClick: null },
            spdInc: { bounds: [0, 0, 0, 0], onClick: null },
            spdAny: { bounds: [0, 0, 0, 0], onMove: null },
            viewDec: { bounds: [0, 0, 0, 0], onClick: null },
            viewVal: { bounds: [0, 0, 0, 0], onClick: null },
            viewInc: { bounds: [0, 0, 0, 0], onClick: null },
            viewAny: { bounds: [0, 0, 0, 0], onMove: null },
        };
        this.haveMouseMovedValue = false;
        this._press = null;          // our own press state (see mouse())
        this._markerDragLastX = null;

        // Frame crop markers (source-frame numbers, 1-based) - same semantics
        // as the Power Load Video timeline markers
        this.startFrameMarker = 1;
        this.endFrameMarker = 1;
        this.markerSize = 16;
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;
    }

    ensureValueInitialized() {
        if (typeof this.value !== 'object' || this.value === null || Array.isArray(this.value)) {
            this.value = { isPlaying: false, currentFrame: 1, totalFrames: 1, fps: 24 };
        }
    }

    setTotalFrames(node, totalFrames) {
        this.ensureValueInitialized();
        if (totalFrames && totalFrames > 0) {
            this.value.totalFrames = totalFrames;
            this.value.currentFrame = Math.max(1, Math.min(this.value.currentFrame, totalFrames));
            if (this.endFrameMarker === null || this.endFrameMarker > totalFrames) {
                this.setEndFrame(totalFrames, node);
            }
            node?.setDirtyCanvas?.(true, true);
        }
    }

    setStartFrame(frame, node) {
        this.startFrameMarker = Math.max(1, frame || 1);
        if (node) {
            const w = node.widgets.find(w => w.name === 'start_frame');
            if (w) w.value = this.startFrameMarker;
        }
    }

    setEndFrame(frame, node) {
        this.endFrameMarker = (frame !== null && frame !== undefined) ? Math.max(1, frame) : null;
        if (node && this.endFrameMarker !== null) {
            const w = node.widgets.find(w => w.name === 'end_frame');
            if (w) w.value = this.endFrameMarker;
        }
    }

    /**
     * x position for a source-time t (seconds) inside the shared track range
     */
    xOfSourceTime(t, trackX, trackW, duration) {
        const clamped = Math.min(duration, Math.max(0, t));
        return trackX + (duration > 0 ? (clamped / duration) * trackW : 0);
    }

    // =====================================================================
    // PLAYBACK
    // =====================================================================

    togglePlay(node) {
        if (!node.audioBuffer) {
            // Still decoding (undefined) or decode failed (null): try to
            // (re)load the selected file instead of silently doing nothing.
            if (node.audioBuffer === null || node.audioDuration > 0) {
                const combo = node.widgets?.find(w => w.type === 'combo');
                if (combo?.value) node.loadAudioIntoDisplay?.(combo.value);
            }
            return;
        }
        this.value.isPlaying = !this.value.isPlaying;
        if (this.value.isPlaying) {
            node.startAudioPlayback?.();
            this.startPlayback(node);
        } else {
            node.stopAudioPlayback?.();
            this.stopPlayback();
        }
        node.setDirtyCanvas(true, true);
    }

    startPlayback(node) {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        const animate = () => {
            if (!this.value.isPlaying || !node.audioBuffer) {
                this.stopPlayback();
                return;
            }
            const t = node.currentSourcePosition?.() ?? 0;
            const frame = Math.floor(t * this.value.fps) + 1;
            if (frame !== this.value.currentFrame) {
                this.value.currentFrame = Math.max(1, Math.min(frame, this.value.totalFrames));
                node.setDirtyCanvas(true, true);
            }
            this.animationId = requestAnimationFrame(animate);
        };
        this.animationId = requestAnimationFrame(animate);
    }

    stopPlayback() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    // =====================================================================
    // SEEKING
    // =====================================================================

    seekFromPos(pos, node) {
        const geo = audioTrackGeometry(node.size[0]);
        const duration = node.audioDuration || this.value.totalFrames / this.value.fps || 1;
        const rel = Math.max(0, Math.min(geo.trackWidth, pos[0] - geo.trackX));
        const t = geo.trackWidth > 0 ? (rel / geo.trackWidth) * duration : 0;
        node.seekSourceTime?.(t);
    }

    onMarkerDrag(markerType, event, pos, node) {
        if (!event.shiftKey) return;
        if (markerType === 'start' && !this.draggingStartMarker) return;
        if (markerType === 'end' && !this.draggingEndMarker) return;

        const geo = audioTrackGeometry(node.size[0]);
        const duration = node.audioDuration || this.value.totalFrames / this.value.fps || 1;
        const fps = this.value.fps || 24;
        const total = this.value.totalFrames || 1;
        const rel = Math.max(0, Math.min(geo.trackWidth, pos[0] - geo.trackX));
        const t = geo.trackWidth > 0 ? (rel / geo.trackWidth) * duration : 0;
        const rawFrame = Math.max(1, Math.min(total, Math.round(t * fps) + 1));

        // Drag direction since the last move (marker handover when jammed)
        const dx = pos[0] - (this._markerDragLastX ?? pos[0]);
        this._markerDragLastX = pos[0];
        const endM = this.endFrameMarker != null && this.endFrameMarker >= 1 ? this.endFrameMarker : total;
        const startM = this.startFrameMarker || 1;

        let newFrame = rawFrame;
        if (markerType === 'start') {
            // Jammed against ] while still moving right -> release [ and
            // continue dragging ] in the movement direction (they separate)
            if (rawFrame > endM && dx > 0) {
                this.draggingStartMarker = false;
                this.draggingEndMarker = true;
                // hand the press over to ] so it receives the move events
                const parts = this._press?.parts;
                if (parts) {
                    const i = parts.indexOf(this.hitAreas.startMarker);
                    if (i !== -1) parts.splice(i, 1);
                    if (!parts.includes(this.hitAreas.endMarker)) parts.push(this.hitAreas.endMarker);
                }
                return this.onMarkerDrag('end', event, pos, node);
            }
            newFrame = Math.min(newFrame, endM);
            if (newFrame !== this.startFrameMarker) {
                this.setStartFrame(newFrame, node);
                node.updateLengthDisplay?.();
                node.setDirtyCanvas(true, true);
            }
        } else {
            // Jammed against [ while still moving left -> release ] and
            // continue dragging [ in the movement direction
            if (rawFrame < startM && dx < 0) {
                this.draggingEndMarker = false;
                this.draggingStartMarker = true;
                // hand the press over to [ so it receives the move events
                const parts = this._press?.parts;
                if (parts) {
                    const i = parts.indexOf(this.hitAreas.endMarker);
                    if (i !== -1) parts.splice(i, 1);
                    if (!parts.includes(this.hitAreas.startMarker)) parts.push(this.hitAreas.startMarker);
                }
                return this.onMarkerDrag('start', event, pos, node);
            }
            newFrame = Math.max(newFrame, startM);
            if (newFrame !== this.endFrameMarker) {
                this.setEndFrame(newFrame, node);
                node.updateLengthDisplay?.();
                node.setDirtyCanvas(true, true);
            }
        }
    }

    /**
     * Our own pointer handling - deterministic down/move/up state that does
     * NOT depend on QQBaseWidget's internal mouseDowned / downedHitAreas
     * machinery (which proved flaky with the frontend's pointer pipeline:
     * clicks on play / value spinners randomly did nothing). Both entry
     * points (the frontend widget router AND our node-level forwarder) call
     * this single handler, so behaviour is identical everywhere:
     *   down  -> capture hit areas under the press, fire their onDown
     *   move  -> fire onMove of the captured areas (drag), auto-cancels if
     *            a move arrives with no buttons held (lost pointerup)
     *   up    -> fire onUp, then onClick of areas still under the release
     */
    mouse(event, pos, node) {
        const type = event?.type;
        const isDown = type === 'pointerdown' || type === 'mousedown';
        const isUp = type === 'pointerup' || type === 'mouseup';
        const isMove = type === 'pointermove' || type === 'mousemove';
        if (!isDown && !isUp && !isMove) return false;

        if (isDown) {
            this._press = { pos: [pos[0], pos[1]], parts: [], moved: false };
            this._markerDragLastX = null;
            this.haveMouseMovedValue = false;
            this.draggingStartMarker = false;
            this.draggingEndMarker = false;
            for (const part of Object.values(this.hitAreas)) {
                if (this.clickWasWithinBounds(pos, part.bounds)) {
                    this._press.parts.push(part);
                    if (part.onDown) part.onDown.apply(this, [event, pos, node]);
                }
            }
            return true;
        }

        if (isMove) {
            if (this._press && event.buttons === 0) {
                // pointerup was swallowed elsewhere (hover move while a
                // press is still active) - cancel the press. Explicit === 0
                // so synthetic events without a buttons property are kept.
                this._press = null;
                this._markerDragLastX = null;
                this.haveMouseMovedValue = false;
                this.draggingStartMarker = false;
                this.draggingEndMarker = false;
                return true;
            }
            if (!this._press) return true;
            // Sub-5px jitter is still a click, not a drag. Once a drag is
            // detected, dismiss a value popup opened by the press so the
            // drag-scrub takes over cleanly.
            if (Math.abs(pos[0] - this._press.pos[0]) > 5 ||
                Math.abs(pos[1] - this._press.pos[1]) > 5) {
                if (!this._press.moved) this._closePromptBox();
                this._press.moved = true;
            }
            for (const part of this._press.parts) {
                if (part.onMove) part.onMove.apply(this, [event, pos, node, part]);
            }
            return true;
        }

        // pointerup
        const press = this._press;
        this._press = null;
        this._markerDragLastX = null;
        const moved = this.haveMouseMovedValue;
        this.haveMouseMovedValue = false;
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;
        if (!press) return false;
        let handled = false;
        for (const part of press.parts) {
            if (part.onUp) part.onUp.apply(this, [event, pos, node, part]);
            if (part.onClick && !moved && this.clickWasWithinBounds(pos, part.bounds)) {
                const r = part.onClick.apply(this, [event, pos, node, part]);
                handled = handled || r === true;
            }
        }
        return true;
    }

    // =====================================================================
    // FPS / SPEED CONTROLS (stats row, left side)
    // =====================================================================

    stepFps(node, dir) {
        const v = Math.min(120, Math.max(1, Math.round((node.getFps() + dir) * 10) / 10));
        node.setFps?.(v);
        node.setDirtyCanvas(true, true);
    }

    // =====================================================================
    // VALUE INPUT DIALOG - our own small DOM prompt. The frontend's
    // canvas.prompt has proven unreliable (needs a pointer event, gets
    // wrapped by several layers), so we render a simple input box instead.
    // =====================================================================
    _showPrompt(title, value, onOk) {
        this._closePromptBox();
        const box = document.createElement('div');
        box.style.cssText = `
            position: fixed; z-index: 100000; left: 50%; top: 30%;
            transform: translateX(-50%); background: #1e1e1e; color: #ddd;
            border: 1px solid #444; border-radius: 8px; padding: 10px 12px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.5); font-family: sans-serif;
            font-size: 13px; display: flex; gap: 8px; align-items: center;`;
        const label = document.createElement('span');
        label.textContent = title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.style.cssText = `
            width: 80px; background: #111; color: #fff; border: 1px solid #444;
            border-radius: 4px; padding: 4px 6px; font-size: 13px; outline: none;`;
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = `
            background: #2a6a8a; color: #fff; border: none; border-radius: 4px;
            padding: 4px 10px; cursor: pointer; font-size: 13px;`;

        const close = () => {
            box.remove();
            document.removeEventListener('pointerdown', outside, true);
            this._promptBoxEl = null;
        };
        const outside = (e) => { if (!box.contains(e.target)) close(); };
        const submit = () => {
            const v = parseFloat(input.value);
            if (!isNaN(v)) onOk(v);
            close();
        };
        okBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
            e.stopPropagation();
        });
        box.append(label, input, okBtn);
        document.body.appendChild(box);
        this._promptBoxEl = box;
        setTimeout(() => {
            input.focus();
            input.select();
            document.addEventListener('pointerdown', outside, true);
        }, 0);
    }

    _closePromptBox() {
        if (this._promptBoxEl) {
            this._promptBoxEl.remove();
            this._promptBoxEl = null;
        }
    }

    promptFps(node, _event) {
        if (this.haveMouseMovedValue) return;
        this._showPrompt('fps:', node.getFps(), (v) => {
            if (v >= 1 && v <= 120) node.setFps?.(Math.round(v * 10) / 10);
            node.setDirtyCanvas(true, true);
        });
    }

    dragFps(node, event) {
        if (this._press && !this._press.moved) return; // still a click
        const dx = event?.deltaX ?? event?.movementX ?? 0;
        if (dx) {
            this.haveMouseMovedValue = true;
            this.stepFps(node, Math.sign(dx));
        }
    }

    stepSpeed(node, dir) {
        const v = Math.min(4.0, Math.max(0.25, Math.round((node.getSpeed() + dir) * 100) / 100));
        node.setSpeed?.(v);
        node.setDirtyCanvas(true, true);
    }

    promptSpeed(node, _event) {
        if (this.haveMouseMovedValue) return;
        this._showPrompt('speed:', node.getSpeed(), (v) => {
            if (v >= 0.25 && v <= 4.0) node.setSpeed?.(Math.round(v * 100) / 100);
            node.setDirtyCanvas(true, true);
        });
    }

    // =====================================================================
    // VIEW CONTRAST (stats row, after speed) - 0.0 = natural, 1.0 = max
    // contrast to visually emphasise the peaks in the lane
    // =====================================================================

    getView(node) {
        const v = parseFloat(node?.viewContrast);
        return (!isNaN(v) && v > 0) ? Math.min(3, v) : 0.0;
    }

    setView(node, v) {
        v = Math.min(3, Math.max(0, Math.round(v * 100) / 100));
        node.viewContrast = v;
        if (node.properties) node.properties.view_contrast = v;
        node.setDirtyCanvas(true, true);
    }

    stepView(node, dir) {
        this.setView(node, this.getView(node) + dir);
    }

    promptView(node, _event) {
        if (this.haveMouseMovedValue) return;
        this._showPrompt('view:', this.getView(node), (v) => {
            if (v >= 0 && v <= 3) this.setView(node, v);
            node.setDirtyCanvas(true, true);
        });
    }

    dragView(node, event) {
        if (this._press && !this._press.moved) return; // still a click
        const dx = event?.deltaX ?? event?.movementX ?? 0;
        if (dx) {
            this.haveMouseMovedValue = true;
            this.stepView(node, Math.sign(dx) * 0.05);
        }
    }

    dragSpeed(node, event) {
        if (this._press && !this._press.moved) return; // still a click
        const dx = event?.deltaX ?? event?.movementX ?? 0;
        if (dx) {
            this.haveMouseMovedValue = true;
            this.stepSpeed(node, Math.sign(dx) * 0.05);
        }
    }

    // =====================================================================
    // DRAW
    // =====================================================================

    draw(ctx, node, w, posY, height) {
        this.ensureValueInitialized();

        // All drawing / hit-testing happens in NODE coordinates (the canvas
        // passes this widget's node-relative y as posY - same as the video
        // widget's timeline, which relies on widget.y being node-relative).
        const baseY = (typeof posY === 'number') ? posY : (this.y || 0);

        const geo = audioTrackGeometry(node.size[0]);
        const fps = this.value.fps || 24;
        const total = Math.max(1, this.value.totalFrames);
        const duration = node.audioDuration || (total / fps);
        const trackX = geo.trackX;
        const trackW = geo.trackWidth;
        const trackEnd = trackX + trackW;

        const startM = this.startFrameMarker || 1;
        const endM = (this.endFrameMarker !== null && this.endFrameMarker >= 1) ? this.endFrameMarker : total;
        const cropT0 = (startM - 1) / fps;
        const cropT1 = Math.min(duration, endM / fps);
        const x0 = this.xOfSourceTime(cropT0, trackX, trackW, duration);
        const x1 = this.xOfSourceTime(cropT1, trackX, trackW, duration);
        const playT = (this.value.currentFrame - 1) / fps;
        const playX = this.xOfSourceTime(playT, trackX, trackW, duration);

        // Lane viewport: a fixed axis of `axisSpan` OUTPUT seconds, so the
        // waveform itself compresses with speed (source time t lands at
        // output time t/speed) - drops visibly slide as speed changes.
        // At speed <= 1 the axis is scaled so the file always fits.
        const speed = node.getSpeed?.() || 1;
        const axisSpan = duration * Math.max(1, 1 / speed);
        const xOfOut = (o) => trackX + (o / axisSpan) * trackW;

        ctx.save();

        // ================= ANALYSIS LANE =================
        // Stretch: the lane canvas fills all space down to the timeline
        // block (track row + stats row), which stays anchored to the bottom
        // of the node - growing the node vertically grows the canvas.
        const rowH = this.TRACK_H;
        const statsH = this.TRACK_H;
        const bottomPad = 6;
        const blockH = 4 + rowH + 4 + statsH; // gap + track row + gap + stats row
        const laneH = Math.max(this.LANE_H, node.size[1] - bottomPad - blockH - baseY);
        const waveTop = baseY + 16;        // top strip: seconds ruler
        const waveBottom = baseY + laneH - 14; // bottom strip: frame ruler
        const waveMid = (waveTop + waveBottom) / 2;
        const waveH = waveBottom - waveTop;

        // Lane canvas: its own dark rounded container (separate from the
        // timeline block below)
        ctx.fillStyle = '#1a1a1a';
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        roundRectPath(ctx, geo.containerX, baseY, geo.containerWidth, laneH, 6);
        ctx.fill();
        ctx.stroke();

        // Analysis view content
        const view = AUDIO_VIEWS[this.viewIndex] || 'WAVE';
        const hasAudio = !!(node.peaks && node.peaks.length > 0);
        // View contrast: gamma curve - quiet parts are suppressed and peaks
        // pop out more the higher it goes. 0-2 ramps the exponent linearly
        // (1 -> 4); 2-3 adds a quadratic kick (up to exponent ~8) so only
        // the true outliers remain visible.
        const vc = this.getView(node);
        let vGamma = 1 + Math.min(vc, 2) * 1.5;
        if (vc > 2) vGamma += (vc - 2) * (vc - 2) * 4;
        const boost = (v) => Math.pow(Math.min(1, Math.max(0, v)), vGamma);

        if (hasAudio) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(trackX, waveTop, trackW, waveH);
            ctx.clip();

            const buckets = node.peaks.length;
            const tToBucket = (t) => Math.min(buckets - 1, Math.max(0, Math.floor((t / duration) * buckets)));

            const drawWave = (alpha) => {
                ctx.fillStyle = `rgba(44, 198, 255, ${alpha})`;
                for (let px = 0; px <= trackW; px += 1) {
                    // px is OUTPUT time; sample source at t = out * speed
                    const t = Math.min(duration, (px / trackW) * axisSpan * speed);
                    const v = boost(node.peaks[tToBucket(t)] || 0);
                    const h = Math.max(1, v * waveH);
                    ctx.fillRect(trackX + px, waveMid - h / 2, 1, h);
                }
            };

            if (view === 'WAVE') {
                drawWave(0.85);
            } else if (view === 'dB') {
                // Loudness bars from pre-computed RMS buckets (-60..0 dB)
                const step = 2;
                for (let px = 0; px <= trackW; px += step) {
                    const t = Math.min(duration, (px / trackW) * axisSpan * speed);
                    const rms = node.rmsBuckets ? (node.rmsBuckets[tToBucket(t)] || 0) : 0;
                    const db = 20 * Math.log10(rms + 1e-7);
                    const level = boost(Math.min(1, Math.max(0, (db + 60) / 60)));
                    const h = Math.max(1, level * waveH);
                    ctx.fillStyle = levelColor(level);
                    ctx.fillRect(trackX + px, waveBottom - h, step - 0.5, h);
                }
            } else {
                // BEATS: faint waveform + onset ticks split into three stacked
                // rows by frequency band (top = hats, middle = snare/body,
                // bottom = kick/bass) with strength-based tick heights. This
                // keeps the lane readable instead of one solid orange wall.
                drawWave(0.18);
                const events = node.onsetEvents;
                if (events && events.length > 0) {
                    // "View" contrast doubles as beat sensitivity: 0 draws
                    // every detected onset, 3 keeps only the strongest
                    // accents (strength is normalized per band in analysis).
                    const minStrength = (vc / 3) * 0.85;
                    const visible = events.filter(ev => ev.strength >= minStrength);
                    const rowH = waveH / 3;
                    const rows = {
                        high: { top: waveTop, color: '#ffd166' },           // hats / cymbals
                        mid: { top: waveTop + rowH, color: '#5fd39a' },     // snare / body
                        low: { top: waveTop + rowH * 2, color: '#ff7043' }, // kick / bass
                    };
                    // faint separators so the three rows read as lanes
                    ctx.fillStyle = 'rgba(255,255,255,0.06)';
                    ctx.fillRect(trackX, waveTop + rowH, trackW, 1);
                    ctx.fillRect(trackX, waveTop + rowH * 2, trackW, 1);
                    const tickW = visible.length > trackW / 2 ? 1 : 2;
                    ctx.globalAlpha = 0.9;
                    for (const ev of visible) {
                        const row = rows[ev.band] || rows.mid;
                        const x = xOfOut(ev.t / speed);
                        if (x < trackX - 2 || x > trackEnd + 2) continue;
                        const h = Math.max(2, ev.strength * rowH * 0.82);
                        ctx.fillStyle = row.color;
                        ctx.fillRect(x - tickW / 2, row.top + rowH - h - 1, tickW, h);
                    }
                    ctx.globalAlpha = 1;
                } else if (node.onsets && node.onsets.length > 0) {
                    // fallback for old analysis data (no band split)
                    ctx.fillStyle = '#ff7043';
                    const tickW = node.onsets.length > trackW / 3 ? 1 : 2;
                    for (const t of node.onsets) {
                        const x = xOfOut(t / speed);
                        ctx.fillRect(x - tickW / 2, waveTop, tickW, waveH);
                    }
                }
            }

            ctx.restore();
        } else {
            ctx.fillStyle = '#666';
            ctx.font = '12px Sans-Serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(node.audioBuffer === undefined ? 'Decoding audio...' : 'Drop audio here or use Upload',
                geo.containerX + geo.containerWidth / 2, waveMid);
        }

        // ================= DUAL RULER =================
        // Three separated rows so the graph never draws over the numbers:
        //   top strip    -> OUTPUT seconds (matches the visible waveform axis)
        //   middle band  -> the graph (clipped, cannot cover the labels)
        //   bottom strip -> SOURCE frame numbers at that position (fps-aware)
        // Tick density adapts to audio length vs node width; minor ticks at
        // step/5 give fine granularity without label clutter.
        if (hasAudio) {
            const pxPerSec = trackW / Math.max(0.001, axisSpan);
            const framesPerOutSec = fps * speed; // frames per OUTPUT second
            const pxPerFrame = pxPerSec / framesPerOutSec;

            const firstOver = (candidates, minPx) => {
                for (const s of candidates) if (s * pxPerSec >= minPx) return s;
                return candidates[candidates.length - 1];
            };
            const secStep = firstOver([0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300], 46);
            const minorSec = secStep / 5;

            let frameStep = 5000;
            for (const s of [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]) {
                if (s * pxPerFrame >= 34) { frameStep = s; break; }
            }
            const minorFrame = frameStep / 5;

            ctx.font = '9px Sans-Serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';

            // --- TOP: output seconds (labels above, ticks dip into the graph) ---
            const fmtSec = (o) => secStep < 1 ? `${o.toFixed(1)}s`
                : (o < 60 ? `${Math.round(o)}s` : fmtTime(o));
            const minorPx = minorSec * pxPerSec;
            ctx.fillStyle = '#555';
            if (minorPx >= 7) {
                for (let i = 1; i * minorSec <= axisSpan + 1e-6 && i < 20000; i++) {
                    if (i % 5 === 0) continue; // major tick position
                    const x = xOfOut(i * minorSec);
                    if (x > trackEnd + 1) break;
                    ctx.fillRect(x, waveTop, 1, 3);
                }
            }
            ctx.fillStyle = '#999';
            for (let i = 0; i * minorSec <= axisSpan + 1e-6 && i < 20000; i += 5) {
                const o = i * minorSec;
                const x = xOfOut(o);
                if (x > trackEnd + 1) break;
                ctx.fillRect(x, waveTop, 1, 5);
                if (x >= trackX - 1) ctx.fillText(fmtSec(o), x, baseY + 11);
            }

            // --- BOTTOM: source frame numbers (ticks rise from the strip) ---
            const minorFramePx = minorFrame * pxPerFrame;
            ctx.fillStyle = '#555';
            if (minorFramePx >= 7) {
                for (let f = 1; f <= total + 1e-6 && (f - 1) / framesPerOutSec <= axisSpan; f += minorFrame) {
                    if ((f - 1) % frameStep === 0) continue;
                    const x = xOfOut((f - 1) / framesPerOutSec);
                    if (x > trackEnd + 1) break;
                    ctx.fillRect(x, waveBottom, 1, 3);
                }
            }
            ctx.fillStyle = '#999';
            for (let f = 1; f <= total + 1e-6 && (f - 1) / framesPerOutSec <= axisSpan; f += frameStep) {
                const x = xOfOut((f - 1) / framesPerOutSec);
                if (x > trackEnd + 1) break;
                ctx.fillRect(x, waveBottom, 1, 5);
                if (x >= trackX - 1) ctx.fillText(String(f), x, baseY + laneH - 4);
            }
        }

        // Dim everything outside the crop range - in OUTPUT coordinates so
        // the dimming follows the compressed waveform (the track row below
        // keeps its own source-time mapping for the [ ] markers)
        const x0L = xOfOut(cropT0 / speed);
        const x1L = xOfOut(cropT1 / speed);
        const playXL = xOfOut(playT / speed);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        if (x0L > trackX) ctx.fillRect(trackX, waveTop, x0L - trackX, waveH);
        if (x1L < trackEnd) ctx.fillRect(x1L, waveTop, trackEnd - x1L, waveH);

        // Playhead (output position in the lane)
        ctx.fillStyle = '#2cc6ff';
        ctx.fillRect(playXL - 1, waveTop, 2, waveH);

        // View label (click to cycle WAVE -> dB -> BEATS) - tucked into the
        // top strip's left corner, LEFT of where the seconds ruler starts
        // (ruler ticks/labels begin at trackX) so they never overlap
        ctx.fillStyle = '#999';
        ctx.font = '8px Sans-Serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(view, geo.containerX + 4, baseY + 11);
        this.hitAreas.viewLabel.bounds = [geo.containerX + 2, baseY, trackX - geo.containerX - 2, 15];
        if (!this.hitAreas.viewLabel.onDown) {
            // Fire on PRESS (down events are always delivered by the
            // frontend pointer pipeline; up events can get swallowed)
            this.hitAreas.viewLabel.onDown = () => {
                this.viewIndex = (this.viewIndex + 1) % AUDIO_VIEWS.length;
                node.setDirtyCanvas(true, true);
            };
        }

        // Lane click-to-seek hit area (below the view label row so the two
        // hit areas never overlap)
        this.hitAreas.laneTrack.bounds = [trackX, baseY + 14, trackW, laneH - 14];
        if (!this.hitAreas.laneTrack.onDown) {
            this.hitAreas.laneTrack.onDown = (e, pos, n) => this.seekFromPos(pos, n);
        }
        if (!this.hitAreas.laneTrack.onMove) {
            this.hitAreas.laneTrack.onMove = (e, pos, n) => this.seekFromPos(pos, n);
        }

        // ================= TIMELINE BLOCK (track + stats rows) =============
        const rowY = baseY + laneH + 4;
        const rowMidY = rowY + rowH / 2;
        const playSize = AUDIO_TRACK_GEO.playSize;
        const padding = AUDIO_TRACK_GEO.containerPad;

        // Timeline block: its own dark rounded container (track row on top,
        // stats row below) - visually separate from the lane canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        roundRectPath(ctx, geo.containerX, rowY, geo.containerWidth, rowH + 4 + statsH, 6);
        ctx.fill();
        ctx.stroke();

        // Play/pause icon
        const btnX = geo.containerX + padding;
        const playY = rowMidY - playSize / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = this.value.isPlaying ? '#2cc6ff' : LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = `${Math.max(13, playSize * 0.75)}px Sans-Serif`;
        ctx.fillText(this.value.isPlaying ? '⏸' : '▶', btnX + playSize / 2, playY + playSize / 2);
        this.hitAreas.playButton.bounds = [btnX, playY, playSize, playSize];
        if (!this.hitAreas.playButton.onDown) {
            // Toggle on PRESS - pointerup delivery is lossy in the frontend
            // pointer pipeline (capture / pointercancel), which made the
            // button randomly unresponsive when waiting for the release.
            this.hitAreas.playButton.onDown = (e, pos, n) => this.togglePlay(n || node);
        }

        // Track line
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trackX, rowMidY);
        ctx.lineTo(trackEnd, rowMidY);
        ctx.stroke();

        // Dim outside crop + highlighted crop span
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        if (x0 > trackX) ctx.fillRect(trackX, rowMidY - 6, x0 - trackX, 12);
        if (x1 < trackEnd) ctx.fillRect(x1, rowMidY - 6, trackEnd - x1, 12);
        ctx.fillStyle = 'rgba(44, 198, 255, 0.12)';
        ctx.fillRect(x0, rowMidY - 6, Math.max(0, x1 - x0), 12);

        // Slider handle (playhead)
        ctx.fillStyle = '#2cc6ff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(playX - 3, rowMidY - 8, 6, 16);
        ctx.fill();
        ctx.stroke();

        // Crop markers [ ]
        ctx.font = `${this.markerSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff0000';
        ctx.fillText('[', x0, rowMidY);
        ctx.fillText(']', x1, rowMidY);

        const markerHitR = this.markerSize / 2;
        this.hitAreas.startMarker.bounds = [x0 - markerHitR, rowMidY - markerHitR, markerHitR * 2, markerHitR * 2];
        if (!this.hitAreas.startMarker.onDown) {
            this.hitAreas.startMarker.onDown = (e, pos, n) => {
                if (e.shiftKey) {
                    this.draggingStartMarker = true;
                    this._markerDragLastX = pos[0];
                }
            };
        }
        if (!this.hitAreas.startMarker.onMove) {
            this.hitAreas.startMarker.onMove = (e, pos, n) => this.onMarkerDrag('start', e, pos, n);
        }
        this.hitAreas.endMarker.bounds = [x1 - markerHitR, rowMidY - markerHitR, markerHitR * 2, markerHitR * 2];
        if (!this.hitAreas.endMarker.onDown) {
            this.hitAreas.endMarker.onDown = (e, pos, n) => {
                if (e.shiftKey) {
                    this.draggingEndMarker = true;
                    this._markerDragLastX = pos[0];
                }
            };
        }
        if (!this.hitAreas.endMarker.onMove) {
            this.hitAreas.endMarker.onMove = (e, pos, n) => this.onMarkerDrag('end', e, pos, n);
        }

        // ================= STATS ROW (fps/speed left, counter right) ========
        const statsY = rowY + rowH + 4;
        const statsMidY = statsY + statsH / 2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = '12px Sans-Serif';

        const assignBounds = (name, bounds) => {
            const area = this.hitAreas[name];
            if (!area) return;
            area.bounds = bounds;
            area.onClick = null;
            area.onDown = null;
            area.onUp = null;
            area.onMove = null;
        };

        let posX = geo.containerX + padding;

        // fps spinner
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText('fps:', posX, statsMidY);
        const fpsLabelW = ctx.measureText('fps:').width + 4;
        posX += fpsLabelW;
        const [fpsDec, fpsTxt, fpsInc] = drawSpinner(ctx, posX, statsY, statsH, node.getFps().toFixed(1));
        assignBounds('fpsDec', fpsDec);
        assignBounds('fpsVal', fpsTxt);
        assignBounds('fpsInc', fpsInc);
        assignBounds('fpsAny', [fpsDec[0], statsY, SPINNER_TOTAL, statsH]);
        this.hitAreas.fpsDec.onDown = (e, pos, n) => this.stepFps(n || node, -1);
        this.hitAreas.fpsInc.onDown = (e, pos, n) => this.stepFps(n || node, 1);
        // Open the value dialog on PRESS; an actual drag (>5px) closes it
        // again (see mouse()) so drag-scrubbing still works.
        this.hitAreas.fpsVal.onDown = (e, pos, n) => this.promptFps(n || node, e);
        this.hitAreas.fpsAny.onMove = (e, pos, n) => this.dragFps(n || node, e);

        posX += SPINNER_TOTAL + 26; // extra offset before the speed label

        // speed spinner
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText('speed:', posX, statsMidY);
        const spdLabelW = ctx.measureText('speed:').width + 4;
        posX += spdLabelW;
        const [spdDec, spdTxt, spdInc] = drawSpinner(ctx, posX, statsY, statsH, node.getSpeed().toFixed(2) + 'x');
        assignBounds('spdDec', spdDec);
        assignBounds('spdVal', spdTxt);
        assignBounds('spdInc', spdInc);
        assignBounds('spdAny', [spdDec[0], statsY, SPINNER_TOTAL, statsH]);
        this.hitAreas.spdDec.onDown = (e, pos, n) => this.stepSpeed(n || node, -0.05);
        this.hitAreas.spdInc.onDown = (e, pos, n) => this.stepSpeed(n || node, 0.05);
        this.hitAreas.spdVal.onDown = (e, pos, n) => this.promptSpeed(n || node, e);
        this.hitAreas.spdAny.onMove = (e, pos, n) => this.dragSpeed(n || node, e);

        posX += SPINNER_TOTAL + 26; // extra offset before the view label

        // view contrast spinner
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText('view:', posX, statsMidY);
        const viewLabelW = ctx.measureText('view:').width + 4;
        posX += viewLabelW;
        const [viewDec, viewTxt, viewInc] = drawSpinner(ctx, posX, statsY, statsH, this.getView(node).toFixed(2));
        assignBounds('viewDec', viewDec);
        assignBounds('viewVal', viewTxt);
        assignBounds('viewInc', viewInc);
        assignBounds('viewAny', [viewDec[0], statsY, SPINNER_TOTAL, statsH]);
        this.hitAreas.viewDec.onDown = (e, pos, n) => this.stepView(n || node, -0.05);
        this.hitAreas.viewInc.onDown = (e, pos, n) => this.stepView(n || node, 0.05);
        this.hitAreas.viewVal.onDown = (e, pos, n) => this.promptView(n || node, e);
        this.hitAreas.viewAny.onMove = (e, pos, n) => this.dragView(n || node, e);

        // Frame + time counter (source frame number + source seconds),
        // right-aligned so the track row above can use the full width
        const counterText = `${this.value.currentFrame}/${total} · ${fmtTime(playT)}`;
        const counterW = ctx.measureText(counterText).width;
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText(counterText, geo.containerX + geo.containerWidth - padding - counterW, statsMidY);

        // Track seek hit area (fires on press, then continuously on drag)
        this.hitAreas.track.bounds = [trackX, rowY, trackW, rowH];
        if (!this.hitAreas.track.onDown) {
            this.hitAreas.track.onDown = (e, pos, n) => this.seekFromPos(pos, n);
        }
        if (!this.hitAreas.track.onMove) {
            this.hitAreas.track.onMove = (e, pos, n) => this.seekFromPos(pos, n);
        }

        // Stash layout info so node-level mouse forwarding (see
        // audio_node_setup.js) can route clicks in the stretched lane region
        // below this widget's fixed computed band to us.
        this._layoutNode = node;
        this._layoutBaseY = baseY;

        ctx.restore();
    }

    computeSize(width) {
        // FIXED height only. Returning a height derived from node.size would
        // feed back into the frontend's auto-layout (node height = widget
        // height sums) and grow the node forever on every redraw. The visual
        // stretch is draw-only (see draw()), and clicks in the stretched
        // region are handled via node-level mouse forwarding.
        // Layout: lane + 4 + track row + 4 + stats row
        return [width, this.LANE_H + 4 + this.TRACK_H + 4 + this.TRACK_H];
    }

    onRemove(node) {
        this.stopPlayback();
        this._closePromptBox();
        node?.stopAudioPlayback?.();
    }
}

// Layout heights
PowerAudioTimelineWidget.prototype.LANE_H = 54;
PowerAudioTimelineWidget.prototype.TRACK_H = 30;
