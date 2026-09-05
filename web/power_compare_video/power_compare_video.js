/**
 * Power Compare Video - playback preview + A/B comparison for IMAGE sequences
 *
 * Receives video frames from the backend (saved to temp on each execution)
 * and plays them back in an in-node playback area with the same bottom
 * timeline UI as Power Load Video (play/pause, scrubbing, [ ] markers).
 *
 * When a second video is available (previous run's cache, or the images_b
 * input), the row above the playback area offers three compare modes:
 *   - slide (default): rgthree-Image-Comparer-style slider on the playback
 *     area - the divider follows the mouse, revealing B on the left and
 *     keeping A on the right
 *   - right: B placed on the right side of A
 *   - bottom: B placed below A
 * The same row holds an fps stepper (drag / click / prompt). Frame counts
 * may differ - playback runs for the longer sequence while the shorter one
 * freezes on its last frame.
 *
 * Reuses PowerLoadVideoTimelineWidget: frames are driven manually through
 * the image sequence (same code path the timeline uses for VFR videos),
 * so no video element decoding is involved.
 */

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import { PowerLoadVideoTimelineWidget } from '../power_load_video/timeline_widget.js';
import { PowerCompareRowWidget } from './compare_row_widget.js';

app.registerExtension({
    name: 'PowerCompareVideo',

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== 'PowerCompareVideo') return;

        // Store original onNodeCreated FIRST before wrapping
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function() {
            if (originalOnNodeCreated) {
                originalOnNodeCreated.apply(this, arguments);
            }

            // Enforce minimum width and max height (same bounds as PowerLoadVideo)
            if (this.size[0] < 640) {
                this.size[0] = 640;
            }
            if (this.size[1] > 585) {
                this.size[1] = 585;
            }
            this.onResize = function(size) {
                if (size[0] < 640) {
                    size[0] = 640;
                }
                if (size[1] > 585) {
                    size[1] = 585;
                }
            };

            this.widgets = this.widgets || [];

            // addCustomWidget polyfill (same as PowerLoadVideo)
            if (!this.addCustomWidget) {
                this.addCustomWidget = function(widget) {
                    widget.parent = this;
                    this.widgets = this.widgets || [];
                    this.widgets.push(widget);

                    const originalMouse = widget.mouse;
                    widget.mouse = function(event, pos, node) {
                        const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
                        return originalMouse?.call(this, event, localPos, node);
                    };

                    return widget;
                };
            }

            // === COMPARE MODE ROW (mode buttons + fps stepper) ===
            this.compareMode = this.properties?.compare_mode || 'slide';

            // Hide the default fps widget - it's edited through the row's stepper
            const fpsWidget = this.widgets.find(w => w.name === 'fps');
            if (fpsWidget) {
                fpsWidget.computeSize = () => [0, 0];
                fpsWidget.hidden = true;
                if (typeof fpsWidget.value !== 'number' || isNaN(fpsWidget.value)) {
                    fpsWidget.value = 24;
                }
            }

            // Create the row widget FIRST (appears above the playback area)
            if (!this.rowWidget) {
                this.rowWidget = new PowerCompareRowWidget();
                this.addCustomWidget(this.rowWidget);
            }
            if (fpsWidget) {
                this.rowWidget.fpsValue = Math.max(1, Math.round(fpsWidget.value));
            }

            // Output pick (A/B): restored from properties/widget, edited via
            // the row's pick buttons - hide the default combo widget
            this.outputPick = this.properties?.output_pick || 'A';
            const pickWidget = this.widgets.find(w => w.name === 'output_pick');
            if (pickWidget) {
                pickWidget.computeSize = () => [0, 0];
                pickWidget.hidden = true;
                if (pickWidget.value !== 'A' && pickWidget.value !== 'B') {
                    pickWidget.value = 'A';
                }
                this.outputPick = pickWidget.value;
            }

            // === PLAYBACK AREA (DOM widget) ===
            const container = document.createElement('div');
            container.id = 'power-compare-video-' + this.id;
            container.style.cssText = 'width: 100%; height: 380px; background-color: #000; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center;';

            // Canvas that renders the current frame
            const displayCanvas = document.createElement('canvas');
            displayCanvas.id = 'power-compare-video-canvas-' + this.id;
            displayCanvas.style.cssText = 'max-width: 100%; max-height: 100%; display: none; background: #000;';

            // Placeholder shown until frames arrive
            const placeholderText = document.createElement('div');
            placeholderText.id = 'power-compare-video-placeholder-' + this.id;
            placeholderText.textContent = 'Connect video frames to preview';
            placeholderText.style.cssText = 'position: absolute; color: #888; font-size: 14px; pointer-events: none; user-select: none;';

            // The shared timeline widget expects a videoElement reference on the
            // node. Ours stays empty (no src) and is never played - the timeline
            // then falls back to driving frames manually, which is exactly what
            // we want for an image sequence.
            const dummyVideo = document.createElement('video');
            dummyVideo.style.display = 'none';

            this.displayCanvas = displayCanvas;
            this.compareFrames = null;
            this.compareFramesB = null;
            this.compareSplit = null;  // 0..1 divider position (set when B exists)
            container.appendChild(displayCanvas);
            container.appendChild(placeholderText);
            container.appendChild(dummyVideo);

            this.placeholderText = placeholderText;

            // Add playback area as DOM widget
            this.videoDisplayWidget = this.addDOMWidget(nodeData.name, 'VideoDisplay', container, {
                serialize: false,
                hideOnZoom: false
            });
            this.videoDisplayWidget.computeSize = function(width) {
                return [width, 380];
            };

            // === TIMELINE WIDGET LAST (bottom UI, shared with PowerLoadVideo) ===
            if (!this.timelineWidget) {
                this.timelineWidget = new PowerLoadVideoTimelineWidget('PowerCompareVideoTimeline');
                this.addCustomWidget(this.timelineWidget);
            }
            this.timelineWidget.setVideoElement(dummyVideo);

            // Letterbox-fit an image into a region (aspect preserved, centered)
            const drawFit = (ctx, img, rx, ry, rw, rh) => {
                const s = Math.min(rw / img.naturalWidth, rh / img.naturalHeight);
                const dw = img.naturalWidth * s;
                const dh = img.naturalHeight * s;
                ctx.drawImage(img, rx + (rw - dw) / 2, ry + (rh - dh) / 2, dw, dh);
            };

            // White divider lines (same look as rgthree's comparer)
            const drawDividerV = (ctx, x, h) => {
                ctx.save();
                ctx.globalCompositeOperation = 'difference';
                ctx.strokeStyle = 'rgba(255,255,255,1)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
                ctx.restore();
            };
            const drawDividerH = (ctx, y, w) => {
                ctx.save();
                ctx.globalCompositeOperation = 'difference';
                ctx.strokeStyle = 'rgba(255,255,255,1)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(w, y);
                ctx.stroke();
                ctx.restore();
            };

            /**
             * Draw the frame at frameIndex (1-based) onto the display canvas.
             * Signature matches what PowerLoadVideoTimelineWidget expects.
             *
             * Modes (node.compareMode):
             *  - 'slide'  (default): A fills the canvas; B is revealed to the LEFT
             *    of the split position with a draggable divider line.
             *  - 'right': B placed on the right side, A on the left.
             *  - 'bottom': B placed below, A on top.
             * Side-by-side modes render the canvas at double size in the split
             * direction (both videos keep full resolution; CSS scales it down).
             * Both indices clamp to their own length so the shorter video
             * freezes on its last frame.
             */
            this.updateDisplayCanvas = (frameIndex) => {
                const framesA = this.compareFrames;
                if (!this.displayCanvas || !framesA || !framesA.length) return;

                const i = Math.max(0, (frameIndex || 1) - 1);
                const imgA = framesA[Math.min(i, framesA.length - 1)];
                if (!imgA || !imgA.naturalWidth) return;

                const framesB = this.compareFramesB;
                const imgB = (framesB && framesB.length) ? framesB[Math.min(i, framesB.length - 1)] : null;
                const bReady = !!(imgB && imgB.naturalWidth);
                const mode = this.compareMode || 'slide';

                const aw = imgA.naturalWidth;
                const ah = imgA.naturalHeight;
                const cw = (mode === 'right' && bReady) ? aw * 2 : aw;
                const ch = (mode === 'bottom' && bReady) ? ah * 2 : ah;

                const ctx = this.displayCanvas.getContext('2d');
                if (this.displayCanvas.width !== cw || this.displayCanvas.height !== ch) {
                    this.displayCanvas.width = cw;
                    this.displayCanvas.height = ch;
                }
                ctx.clearRect(0, 0, cw, ch);

                // A always fills its region (top-left)
                ctx.drawImage(imgA, 0, 0);

                if (!bReady) return;

                if (mode === 'slide') {
                    if (typeof this.compareSplit === 'number') {
                        const splitX = Math.round(Math.max(0, Math.min(1, this.compareSplit)) * cw);
                        if (splitX > 0) {
                            // B clipped to the left of the divider (stretched to
                            // the canvas size so differing resolutions still align)
                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(0, 0, splitX, ch);
                            ctx.clip();
                            ctx.drawImage(imgB, 0, 0, cw, ch);
                            ctx.restore();
                            drawDividerV(ctx, splitX, ch);
                        }
                    }
                } else if (mode === 'right') {
                    drawFit(ctx, imgB, aw, 0, aw, ah);
                    drawDividerV(ctx, aw, ch);
                } else { // bottom
                    drawFit(ctx, imgB, 0, ah, aw, ah);
                    drawDividerH(ctx, ah, cw);
                }
            };

            // Left-to-right sliding compare: the divider follows the mouse while
            // it moves over the playback area (borrowed from rgthree comparer).
            // Only active in slide mode with a second video present.
            const updateSplitFromMouse = (e) => {
                if ((this.compareMode || 'slide') !== 'slide') return;
                if (!this.compareFramesB || !this.compareFramesB.length) return;
                const rect = displayCanvas.getBoundingClientRect();
                if (!rect.width) return;
                const ratio = (e.clientX - rect.left) / rect.width;
                this.compareSplit = Math.max(0, Math.min(1, ratio));
                this.updateDisplayCanvas(this.timelineWidget?.value?.currentFrame || 1);
            };
            displayCanvas.addEventListener('mousemove', (e) => {
                updateSplitFromMouse(e);
                const slideActive = (this.compareMode || 'slide') === 'slide' && this.compareFramesB && this.compareFramesB.length;
                displayCanvas.style.cursor = slideActive ? 'ew-resize' : 'default';
            });
            displayCanvas.addEventListener('mousedown', updateSplitFromMouse);
            displayCanvas.addEventListener('mouseleave', () => {
                displayCanvas.style.cursor = 'default';
            });

            // Keyboard shortcut: Shift+Spacebar toggles playback for the selected node
            this.handlePlayPauseShortcut = (e) => {
                if ((e.key === ' ' || e.code === 'Space') && e.shiftKey) {
                    if (!e.target.matches('input, textarea')) {
                        if (this.selected) {
                            e.preventDefault();
                            e.stopPropagation();
                            this.timelineWidget?.togglePlay(this);
                        }
                    }
                }
            };
            document.addEventListener('keydown', this.handlePlayPauseShortcut, true);
        };

        // Receive frames from the backend after each execution
        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            if (originalOnExecuted) {
                originalOnExecuted.apply(this, arguments);
            }
            if (message && Array.isArray(message.compare_frames) && message.compare_frames.length) {
                // Scalar ui values arrive wrapped in 1-element arrays (server merges by list)
                const fps = Array.isArray(message.fps) ? message.fps[0] : message.fps;
                const frameCount = Array.isArray(message.frame_count) ? message.frame_count[0] : message.frame_count;
                const framesB = Array.isArray(message.compare_frames_b) ? message.compare_frames_b : [];
                const frameCountB = Array.isArray(message.frame_count_b) ? message.frame_count_b[0] : message.frame_count_b;
                this.loadCompareFrames(message.compare_frames, fps, frameCount, framesB, frameCountB);
            }
        };

        /**
         * Load frame lists (temp-file references) into the playback area.
         * A = current video, B = second video (previous run or images_b input).
         * Playback covers the LONGER sequence; the shorter one freezes on its
         * last frame.
         */
        nodeType.prototype.loadCompareFrames = async function(frameInfos, fps, frameCount, frameInfosB, frameCountB) {
            frameInfosB = Array.isArray(frameInfosB) ? frameInfosB : [];

            // Stop any ongoing playback before swapping frames
            if (this.timelineWidget?.value?.isPlaying) {
                this.timelineWidget.stopPlayback();
                this.timelineWidget.value.isPlaying = false;
            }

            // Cache-buster so re-executed frames with identical filenames refresh
            const cacheBuster = '&t=' + Date.now();
            const loadAll = (infos) => Promise.all(infos.map(info => new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null);
                const params = new URLSearchParams();
                params.set('filename', info.filename || '');
                params.set('subfolder', info.subfolder || '');
                params.set('type', info.type || 'temp');
                img.src = api.apiURL('/view?' + params.toString() + cacheBuster);
            })));

            const [loadedARaw, loadedBRaw] = await Promise.all([loadAll(frameInfos), loadAll(frameInfosB)]);
            const loaded = loadedARaw.filter(Boolean);
            const loadedB = loadedBRaw.filter(Boolean);

            this.compareFrames = loaded;
            this.compareFramesB = loadedB;

            if (!loaded.length) {
                // Temp files are gone (server restart) - show placeholder again
                if (this.placeholderText) {
                    this.placeholderText.textContent = 'Frames unavailable - queue the workflow to refresh';
                    this.placeholderText.style.display = 'block';
                }
                if (this.displayCanvas) this.displayCanvas.style.display = 'none';
                return;
            }

            if (this.placeholderText) {
                this.placeholderText.style.display = 'none';
            }
            if (this.displayCanvas) {
                this.displayCanvas.style.display = 'block';
            }

            // Reuse the timeline's manual frame-driving playback path (VFR mode)
            this.isVFRVideo = true;
            this.isVFRDecoding = false;

            // Total = longer sequence (frameCount* are the authoritative counts;
            // fall back to actually-loaded lengths for missing/broken frames)
            const countA = frameCount > 0 ? frameCount : loaded.length;
            const countB = frameCountB > 0 ? frameCountB : loadedB.length;
            const total = Math.max(countA, countB);

            // Prefer the live fps (row stepper / hidden widget) over the
            // value baked into this execution message
            let playbackFps = (fps && fps > 0) ? fps : 24;
            const fpsW = this.widgets?.find(w => w.name === 'fps');
            if (fpsW && typeof fpsW.value === 'number' && fpsW.value > 0) {
                playbackFps = fpsW.value;
            }
            if (this.timelineWidget) {
                this.timelineWidget.nativeFPS = playbackFps;
                this.timelineWidget.value.fps = playbackFps;
                this.timelineWidget.setTotalFrames(this, total);
                this.timelineWidget.setStartFrame(1, this);
                this.timelineWidget.setEndFrame(total, this);
            }

            // Default the slider to the middle once a second video exists
            if (loadedB.length && typeof this.compareSplit !== 'number') {
                this.compareSplit = 0.5;
            }
            // No second video anymore - drop the slider
            if (!loadedB.length) {
                this.compareSplit = null;
            }

            this.updateDisplayCanvas(this.timelineWidget?.value?.currentFrame || 1);
            this.setDirtyCanvas(true, true);
        };

        // Restore mode + fps on workflow load
        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function(info) {
            if (originalOnConfigure) {
                originalOnConfigure.apply(this, arguments);
            }
            this.compareMode = this.properties?.compare_mode || 'slide';
            const fpsWidget = this.widgets?.find(w => w.name === 'fps');
            if (fpsWidget && (typeof fpsWidget.value !== 'number' || isNaN(fpsWidget.value))) {
                fpsWidget.value = 24;
            }
            if (fpsWidget && this.rowWidget) {
                this.rowWidget.fpsValue = Math.max(1, Math.round(fpsWidget.value));
            }
            // output_pick widget values are applied just before this hook,
            // so the widget wins; fall back to saved properties
            const pickWidget = this.widgets?.find(w => w.name === 'output_pick');
            if (pickWidget) {
                if (pickWidget.value !== 'A' && pickWidget.value !== 'B') {
                    pickWidget.value = this.properties?.output_pick || 'A';
                }
                this.outputPick = pickWidget.value;
            } else {
                this.outputPick = this.properties?.output_pick || 'A';
            }
        };

        // Cleanup on node removal
        const originalOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            if (this.timelineWidget) {
                this.timelineWidget.onRemove(this);
            }
            if (this.handlePlayPauseShortcut) {
                document.removeEventListener('keydown', this.handlePlayPauseShortcut);
                this.handlePlayPauseShortcut = null;
            }
            this.compareFrames = null;
            this.compareFramesB = null;
            this.compareSplit = null;

            if (originalOnRemoved) {
                originalOnRemoved.apply(this, arguments);
            }
        };
    },
});
