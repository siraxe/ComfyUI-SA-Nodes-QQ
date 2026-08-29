/**
 * Node Setup - onNodeCreated wrapper logic for PowerLoadVideo
 */
import { api } from '../../../scripts/api.js';
import { app } from '../../../scripts/app.js';
import { PowerLoadVideoTopRowWidget } from './top_row_widget.js';
import { PowerLoadVideoTimelineWidget } from './timeline_widget.js';
import { PowerLoadVideoFileSelectorWidget } from './file_selector_widget.js';
import { BoxCropWidget } from './box_crop_widget.js';

/**
 * Create the onNodeCreated wrapper function for PowerLoadVideo nodes
 */
export function createOnNodeCreatedWrapper(originalOnNodeCreated, nodeData) {
    return function() {
        // Call original first
        if (originalOnNodeCreated) {
            originalOnNodeCreated.apply(this, arguments);
        }

        // Enforce minimum width and max height
        if (this.size[0] < 640) {
            this.size[0] = 640;
        }
        if (this.size[1] > 585) {
            this.size[1] = 585;
        }

        // Enforce min width and max height on resize
        this.onResize = function(size) {
            if (size[0] < 640) {
                size[0] = 640;
            }
            if (size[1] > 585) {
                size[1] = 585;
            }
        };

        // Fix #5: Ensure widgets array exists before manipulation
        this.widgets = this.widgets || [];
        // Remove built-in widgets except 'video' - we need to keep the video combo widget
        // in the widgets array so ComfyUI serializes its value to the backend on execute.
        // It gets hidden visually below (computeSize = [0,0]).
        const widgetsToRemove = ['timeline', 'frame_rate', 'looping'];
        let removedCount = 0;
        for (const widgetName of widgetsToRemove) {
            let index;
            while ((index = this.widgets.findIndex(w => w.name === widgetName)) >= 0) {
                this.widgets.splice(index, 1);
                removedCount++;
            }
        }
        // ALSO hide any remaining video DOM elements that might be rendered by ComfyUI's video upload
        const hideBuiltInElements = () => {
            const nodeContainer = document.getElementById(`node-${this.id}`);
            if (nodeContainer) {
                // Find and hide any video/canvas elements - be more aggressive with selector
                const builtInElements = nodeContainer.querySelectorAll('video:not([id*="power-load-video"]), canvas:not([id*="litegraph"]):not([id*="power-load-video"]), .vhs-video-container');
                builtInElements.forEach(el => {
                    el.style.display = 'none';
                });
            }
        };

        // Try multiple times to ensure we catch dynamically added elements
        hideBuiltInElements();
        setTimeout(hideBuiltInElements, 50);
        setTimeout(hideBuiltInElements, 100);

        // Use MutationObserver to continuously hide any built-in elements that get added dynamically
        const observer = new MutationObserver(() => {
            hideBuiltInElements();
        });

        // Store reference on node for cleanup
        this.vhsObserver = observer;

        // Observe the node container for changes once it exists
        setTimeout(() => {
            const nodeContainer = document.getElementById(`node-${this.id}`);
            if (nodeContainer) {
                observer.observe(nodeContainer, { childList: true, subtree: true });

                // Add inline style to hide built-in elements at the container level
                const styleEl = document.createElement('style');
                styleEl.id = `power-load-video-styles-${this.id}`;
                styleEl.textContent = `
                    #node-${this.id} video:not([id*="power-load-video"]),
                    #node-${this.id} canvas.vhs-canvas,
                    #node-${this.id} .vhs-video-container,
                    #node-${this.id} [class*="vhs"] {
                        display: none !important;
                    }
                `;
                document.head.appendChild(styleEl);
            }
        }, 100);

        // Add addCustomWidget polyfill if not present (same as PowerSplineEditor)
        if (!this.addCustomWidget) {
            this.addCustomWidget = function (widget) {
                widget.parent = this;
                this.widgets = this.widgets || [];
                this.widgets.push(widget);

                const originalMouse = widget.mouse;
                widget.mouse = function (event, pos, node) {
                    const localPos = [pos[0], pos[1] - (widget.last_y || 0)];
                    return originalMouse?.call(this, event, localPos, node);
                };

                return widget;
            };
        }

        // Create DOM container for video display with drag-and-drop support
        const videoContainer = document.createElement('div');
        videoContainer.id = `power-load-video-${this.id}`;
        videoContainer.style.cssText = `
            width: 100%;
            height: 380px;
            background-color: #000;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Add placeholder text
        const placeholderText = document.createElement('div');
        placeholderText.id = `power-load-video-placeholder-${this.id}`;
        placeholderText.textContent = 'Drop video here';
        placeholderText.style.cssText = `
            position: absolute;
            color: #888;
            font-size: 14px;
            pointer-events: none;
            user-select: none;
        `;

        // Create HTML5 video element (hidden - we use canvas for display)
        const videoElement = document.createElement('video');
        videoElement.id = `power-load-video-element-${this.id}`;
        videoElement.style.cssText = `
            max-width: 100%;
            max-height: 100%;
            display: none;  // Hidden - we use canvas for rendering
        `;
        videoElement.muted = true;
        videoElement.preload = 'auto';  // Load full video data for scrubbing
        videoElement.playsInline = true;

        // Create canvas element for frame display (used for VFR and regular playback)
        const displayCanvas = document.createElement('canvas');
        displayCanvas.setAttribute('willReadFrequently', 'true');  // Optimize for multiple getImageData calls
        displayCanvas.id = `power-load-video-canvas-${this.id}`;
        displayCanvas.style.cssText = `
            max-width: 100%;
            max-height: 100%;
            display: block;
            background: #000;
        `;

        // Store references on node for later access
        this.videoElement = videoElement;
        this.displayCanvas = displayCanvas;  // Canvas for displaying frames
        this._frameBuffer = document.createElement('canvas');  // Offscreen buffer for last clean frame (used during seeking)

        // Redraw display canvas whenever video seek completes (handles scrubbing for CFR videos)
        videoElement.addEventListener('seeked', () => {
            if (!this.isVFRVideo && this.displayCanvas) {
                const frame = this.timelineWidget?.value?.currentFrame || 1;
                this.updateDisplayCanvas(frame);
            }
        });

        // Append elements to container
        videoContainer.appendChild(videoElement);  // Hidden video element for decoding
        videoContainer.appendChild(displayCanvas);  // Visible canvas for frame display
        videoContainer.appendChild(placeholderText);


        // Add drag-and-drop support directly to the video container element
        let draggedFile = null;

        const handleDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            videoContainer.style.backgroundColor = '#1a3a4a';
            placeholderText.style.opacity = '1';
        };

        const handleDragLeave = (e) => {
            // Only reset if leaving the container entirely (not entering a child)
            if (!videoContainer.contains(e.relatedTarget)) {
                e.preventDefault();
                e.stopPropagation();
                videoContainer.style.backgroundColor = '#000';
            }
        };

        const handleDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            videoContainer.style.backgroundColor = '#000';

            const file = e.dataTransfer.files[0];

            if (!file) {
                return;
            }

            if (!file.type.startsWith('video/')) {
                return;
            }

            draggedFile = file;

            // Upload the file via ComfyUI's API
            try {
                const formData = new FormData();
                formData.append('image', file);
                formData.append('type', 'input');

                const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });

                if (resp.ok || resp.status === 200) {
                    const data = await resp.json();

                    // Get the uploaded filename from response
                    let uploadedName = data.name || data.filename || file.name;

                    // Store the video filename on the node for execution
                    this.videoFilename = uploadedName;

                    // Update the hidden combo widget value so ComfyUI serializes it to the backend
                    const comboWidget = this.widgets.find(w => w.type === 'combo');
                    if (comboWidget) {
                        comboWidget.value = uploadedName;
                    }
                    // Also update widgets_values so serialization picks it up
                    if (!this.widgets_values || this.widgets_values.length === 0) {
                        this.widgets_values = [uploadedName];
                    } else {
                        this.widgets_values[0] = uploadedName;
                    }

                    // Directly load the video into our custom display using node method
                    if (typeof this.loadVideoIntoDisplay === 'function') {
                        this.loadVideoIntoDisplay(uploadedName);
                    } else {
                        console.error('[PowerLoadVideo] loadVideoIntoDisplay not available yet, will retry');
                        // Retry after a short delay
                        setTimeout(() => {
                            if (typeof this.loadVideoIntoDisplay === 'function') {
                                this.loadVideoIntoDisplay(uploadedName);
                            }
                        }, 50);
                    }
                } else {
                    console.error('[PowerLoadVideo] Upload failed:', resp.status, resp.statusText);
                }
            } catch (err) {
                console.error('[PowerLoadVideo] Upload error:', err);
            }
        };

        // Attach drag handlers directly to the video container element
        videoContainer.addEventListener('dragover', handleDragOver);
        videoContainer.addEventListener('dragleave', handleDragLeave);
        videoContainer.addEventListener('drop', handleDrop);

        // Audio playback on hover - uses Web Audio API independently from video element
        // so it doesn't interfere with timeline's manual frame-by-frame seeking
        let audioCtx = null;
        let audioBuffer = null;
        let audioSource = null;
        let audioLoadPromise = null;

        const loadAudio = (videoFilename) => {
            // Fetch audio from the same video file via /view endpoint
            const audioUrl = `/view?filename=${encodeURIComponent(videoFilename)}&type=input`;
            audioLoadPromise = fetch(audioUrl)
                .then(r => r.arrayBuffer())
                .then(data => {
                    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    return audioCtx.decodeAudioData(data);
                })
                .then(buf => { audioBuffer = buf; })
                .catch(() => { audioBuffer = null; });
        };

        const startAudio = () => {
            if (!audioBuffer || !audioCtx) return;
            // Resume AudioContext if suspended (browser autoplay policy)
            if (audioCtx.state === 'suspended') audioCtx.resume();
            stopAudio();
            audioSource = audioCtx.createBufferSource();
            audioSource.buffer = audioBuffer;
            audioSource.connect(audioCtx.destination);

            // Sync to current timeline frame position
            const nativeFPS = this.timelineWidget?.nativeFPS || 24;
            const playbackFPS = this.timelineWidget?.value?.fps || nativeFPS;
            const currentFrame = this.timelineWidget?.value?.currentFrame || 1;
            const startOffset = (currentFrame - 1) / nativeFPS;
            // Clamp to marker range end
            const endMarker = this.timelineWidget?.endFrameMarker;
            const totalFrames = this.timelineWidget?.value?.totalFrames || audioBuffer.duration * nativeFPS;
            const endMarkerFrame = endMarker || totalFrames;
            const endTime = (endMarkerFrame - 1) / nativeFPS;
            const remaining = Math.max(0, endTime - startOffset);

            // Adjust playback rate to sync audio speed with video FPS
            const playbackRate = playbackFPS / nativeFPS;
            audioSource.playbackRate.value = playbackRate;

            audioSource.start(0, startOffset, remaining);
            audioSource.onended = () => { audioSource = null; };
        };

        const stopAudio = () => {
            if (audioSource) {
                try { audioSource.stop(); } catch(e) {}
                audioSource = null;
            }
        };

        // Track hover state on the node to ensure audio only plays when BOTH conditions are true
        videoContainer.addEventListener('mouseenter', () => {
            this._isHovering = true;
            // Only start audio if currently playing AND now hovering
            if (this.timelineWidget?.value?.isPlaying && this._startHoverAudio) this._startHoverAudio();
        });
        videoContainer.addEventListener('mouseleave', () => {
            this._isHovering = false;
            stopAudio();
        });

        // Keyboard shortcut: Shift+Spacebar to toggle playback
        this.handlePlayPauseShortcut = (e) => {
            if ((e.key === ' ' || e.code === 'Space') && e.shiftKey) {
                if (!e.target.matches('input, textarea')) {
                    // Only toggle playback for the currently selected node
                    if (this.selected) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.timelineWidget?.togglePlay(this);
                    }
                }
            }
        };
        document.addEventListener('keydown', this.handlePlayPauseShortcut, true);

        // Expose loadAudio so it can be called when a new video is loaded
        this._loadHoverAudio = loadAudio;
        this._stopHoverAudio = stopAudio;
        this._startHoverAudio = () => {
            if (!this.timelineWidget?.value?.isPlaying) return;  // Read fresh state, not stale closure
            if (audioLoadPromise) {
                audioLoadPromise.then(() => { if (this.timelineWidget?.value?.isPlaying) startAudio(); });
            } else if (audioBuffer) {
                startAudio();
            }
        };
        // Restart audio from beginning when video loops
        this._restartHoverAudioOnLoop = () => {
            if (!this.timelineWidget?.value?.isPlaying) return;
            if (audioLoadPromise) {
                audioLoadPromise.then(() => { if (this.timelineWidget?.value?.isPlaying) startAudio(); });
            } else if (audioBuffer) {
                startAudio();
            }
        };

        // Store handlers for cleanup on node removal
        this.dragHandlers = { handleDragOver, handleDragLeave, handleDrop };

        // === CREATE WIDGETS IN ORDER: Top Row -> Box Crop (hidden) -> File Selector -> Video Display -> Timeline ===

        // 1. Create and add the top row widget FIRST (appears above video)
        if (!this.topRowWidget) {
            this.topRowWidget = new PowerLoadVideoTopRowWidget();
            this.addCustomWidget(this.topRowWidget);
        }

        // 2. Create box crop widget BEFORE file selector (file selector's Crop button needs it to exist)
        if (!this.boxCropWidget) {
            this.boxCropWidget = new BoxCropWidget();
            this.addCustomWidget(this.boxCropWidget);
        }

        // 3. Create and add the file selector widget (upload + dropdown, replaces old upload button)
        if (!this.fileSelectorWidget) {
            this.fileSelectorWidget = new PowerLoadVideoFileSelectorWidget(this);
            this.addCustomWidget(this.fileSelectorWidget);
        }

        // 4. Add video display as DOM widget
        this.videoDisplayWidget = this.addDOMWidget(nodeData.name, 'VideoDisplay', videoContainer, {
            serialize: false,
            hideOnZoom: false
        });

        // Set computeSize for proper layout
        this.videoDisplayWidget.computeSize = function(width) {
            return [width, 380];
        };

        // 5. Create and add the timeline widget LAST (appears below video)
        if (!this.timelineWidget) {
            this.timelineWidget = new PowerLoadVideoTimelineWidget();
            this.addCustomWidget(this.timelineWidget);
        }

        // Set the video element reference on the timeline widget
        this.timelineWidget.setVideoElement(videoElement);

        // Box crop overlay is now drawn directly on displayCanvas in updateDisplayCanvas

        // Helper to sync crop values to hidden widgets for backend serialization
        this.syncCropToWidgets = () => {
            if (!this.boxCropWidget) return;
            const bv = this.boxCropWidget.value;
            const mapping = [
                ['crop_enabled', bv.visible],
                ['crop_x', bv.x],
                ['crop_y', bv.y],
                ['crop_w', bv.width],
                ['crop_h', bv.height],
            ];
            for (const [name, val] of mapping) {
                const w = this.widgets.find(w => w.name === name);
                if (w) w.value = val;
            }
        };

        // === HIDE THE COMBO WIDGET ("choose file to upload") AND frame range widgets ===
        setTimeout(() => {
            const comboWidget = this.widgets.find(w => w.type === 'combo');
            if (comboWidget) {
                comboWidget.computeSize = () => [0, 0]; // Make it zero height
                comboWidget.hidden = true; // Mark as hidden
            }
            // Hide start_frame, end_frame, force_fps, max_fps, and crop parameter widgets
            for (const name of ['start_frame', 'end_frame', 'force_fps', 'max_fps', 'crop_enabled', 'crop_x', 'crop_y', 'crop_w', 'crop_h']) {
                const w = this.widgets.find(w => w.name === name);
                if (w) {
                    w.computeSize = () => [0, 0];
                    w.hidden = true;
                    // Ensure float widgets always have a valid numeric value
                    // (ComfyUI's prompt validator rejects {} or None for FLOAT inputs)
                    if (name === 'force_fps' || name === 'max_fps') {
                        if (typeof w.value !== 'number' || isNaN(w.value)) {
                            w.value = 0;
                        }
                    }
                }
            }
            // Sync initial crop values to hidden widgets
            this.syncCropToWidgets();
        }, 0);

        /**
         * Decode all frames from a VFR video into an array of canvas elements.
         * Uses requestVideoFrameCallback to capture frames during playback,
         * since seek-based capture fails for VFR videos (browser stays on first frame).
         */
        this.decodeVFRFrames = async (videoEl, frameCount, fps) => {
            // Clear abort flag from any previous decode
            this._vfrDecodeAborted = false;

            // Array to hold decoded frame canvases
            this.vfrFrames = [];
            this.isVFRVideo = true;
            this.isVFRDecoding = true;  // Lock interaction during capture

            // Show decoding status overlay
            placeholderText.textContent = `VFR detected, decoding 0/${frameCount} frames...`;
            placeholderText.style.display = 'block';
            placeholderText.style.color = '#ccc';
            // Black out the display canvas
            if (this.displayCanvas) {
                const ctx = this.displayCanvas.getContext('2d');
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
            }

            try {
                await new Promise((resolve, reject) => {
                    // Safety timeout
                    const safetyTimer = setTimeout(() => {
                        console.warn(`[PowerLoadVideo] Capture timeout: got ${this.vfrFrames.length}/${frameCount} frames`);
                        videoEl.pause();
                        resolve();
                    }, 30000);

                    // Listen for video ending (may get fewer frames than expected)
                    videoEl.addEventListener('ended', () => {
                        clearTimeout(safetyTimer);
                        resolve();
                    }, { once: true });

                    const captureFrame = (now, metadata) => {
                        // Abort if a new video was loaded while decoding
                        if (this._vfrDecodeAborted) {
                            clearTimeout(safetyTimer);
                            videoEl.pause();
                            resolve();
                            return;
                        }

                        const frameCanvas = document.createElement('canvas');
                        frameCanvas.setAttribute('willReadFrequently', 'true');  // Optimize for getImageData readbacks
                        frameCanvas.width = videoEl.videoWidth;
                        frameCanvas.height = videoEl.videoHeight;
                        const frameCtx = frameCanvas.getContext('2d');
                        frameCtx.drawImage(videoEl, 0, 0);
                        this.vfrFrames.push(frameCanvas);

                        // Update overlay text
                        placeholderText.textContent = `VFR detected, decoding ${this.vfrFrames.length}/${frameCount} frames...`;

                        if (this.vfrFrames.length >= frameCount) {
                            clearTimeout(safetyTimer);
                            videoEl.pause();
                            resolve();
                            return;
                        }

                        videoEl.requestVideoFrameCallback(captureFrame);
                    };

                    videoEl.currentTime = 0;
                    videoEl.requestVideoFrameCallback(captureFrame);
                    videoEl.playbackRate = 1;
                    videoEl.play().catch(err => {
                        clearTimeout(safetyTimer);
                        reject(err);
                    });
                });

                // If decode was aborted while awaiting, skip all post-decode setup
                if (this._vfrDecodeAborted) {
                    return;
                }

                // Reset video state
                videoEl.currentTime = 0;
                videoEl.pause();

                // Update totalFrames to actual captured count (may differ from server metadata)
                const actualFrames = this.vfrFrames.length;
                if (this.timelineWidget && actualFrames > 0) {
                    this.timelineWidget.setTotalFrames(this, actualFrames);
                    // Only set default markers if not already restored by onConfigure
                    if (this.timelineWidget.startFrameMarker === 1 && this.timelineWidget.endFrameMarker === 1) {
                        this.timelineWidget.setStartFrame(1, this);
                        this.timelineWidget.setEndFrame(actualFrames, this);
                    } else if (this.timelineWidget.endFrameMarker > actualFrames || this.timelineWidget.endFrameMarker === 1) {
                        // End marker exceeds new video length or wasn't set - clamp/update it
                        this.timelineWidget.setEndFrame(Math.min(this.timelineWidget.endFrameMarker || actualFrames, actualFrames), this);
                    }
                }

                // Hide overlay and show first frame
                placeholderText.style.display = 'none';
                if (this.displayCanvas && actualFrames > 0) {
                    this.updateDisplayCanvas(1);
                }

                this.setDirtyCanvas(true, true);

            } catch (err) {
                console.error('[PowerLoadVideo] Error during VFR frame capture:', err);
                this.isVFRVideo = false;  // Fall back to normal playback on error
                placeholderText.style.display = 'none';
            } finally {
                this.isVFRDecoding = false;  // Unlock interaction
            }
        };

        /**
         * Get the canvas for a specific frame (for VFR videos)
         */
        this.getVFRFrameCanvas = (frameIndex) => {
            if (!this.isVFRVideo || !this.vfrFrames) return null;
            const idx = Math.max(0, Math.min(frameIndex, this.vfrFrames.length - 1));
            return this.vfrFrames[idx];
        };

        /**
         * Update the display canvas with the current frame.
         * For VFR videos: uses pre-decoded frame array.
         * For CFR videos: draws from video element.
         */
        this.updateDisplayCanvas = (frameIndex) => {
            if (!this.displayCanvas) { console.warn('[PowerLoadVideo] updateDisplayCanvas: no displayCanvas'); return; }

            const ctx = this.displayCanvas.getContext('2d');
            const videoEl = this.videoElement;

            // Ensure canvas is sized correctly
            if (videoEl && videoEl.videoWidth > 0) {
                if (this.displayCanvas.width !== videoEl.videoWidth) {
                    this.displayCanvas.width = videoEl.videoWidth;
                    this.displayCanvas.height = videoEl.videoHeight;
                }
            }

            // Draw frame (clear + draw) only when a new frame is available.
            // When video is mid-seek, restore the last good frame from the buffer
            // to avoid both black frames and overlay accumulation.
            let drewFrame = false;

            // For VFR videos, use pre-decoded frame
            if (this.isVFRVideo && this.vfrFrames && frameIndex > 0) {
                const idx = frameIndex - 1;  // 1-based to 0-based
                const frameCanvas = this.vfrFrames[idx];
                if (frameCanvas) {
                    ctx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
                    ctx.drawImage(frameCanvas, 0, 0);
                    drewFrame = true;
                } else {
                    console.warn(`[PowerLoadVideo] updateDisplayCanvas: VFR frame ${frameIndex} (idx ${idx}) not found, total=${this.vfrFrames.length}`);
                }
            } else if (videoEl && videoEl.readyState >= 2) {  // HAVE_CURRENT_DATA (CFR path)
                ctx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
                ctx.drawImage(videoEl, 0, 0);
                drewFrame = true;
            }

            if (drewFrame) {
                // Save clean frame (without overlay) to buffer for reuse during seeking
                const buf = this._frameBuffer;
                if (buf.width !== this.displayCanvas.width || buf.height !== this.displayCanvas.height) {
                    buf.width = this.displayCanvas.width;
                    buf.height = this.displayCanvas.height;
                }
                buf.getContext('2d').clearRect(0, 0, buf.width, buf.height);
                buf.getContext('2d').drawImage(this.displayCanvas, 0, 0);
            } else if (this._frameBuffer.width > 0) {
                // Video not ready (seeking) - restore last good clean frame
                ctx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
                ctx.drawImage(this._frameBuffer, 0, 0);
            }

            // Draw box crop overlay on top of the video frame
            if (this.boxCropWidget?.value?.visible) {
                this.boxCropWidget.drawBoxOverlay(ctx, this, this.displayCanvas.width, this.displayCanvas.height);
            }
        };

        // Wire up box crop mouse interaction on the display canvas
        displayCanvas.addEventListener('mousedown', (e) => {
            if (!this.boxCropWidget?.value?.visible) return;
            if (this.boxCropWidget.handleCanvasMouse(e, null, this)) {
                e.stopPropagation();
                e.preventDefault();
                const onWinMouseMove = (e) => {
                    this.boxCropWidget.handleCanvasMouse(e, null, this);
                };
                const onWinMouseUp = (e) => {
                    this.boxCropWidget.handleCanvasMouse(e, null, this);
                    window.removeEventListener('mousemove', onWinMouseMove);
                    window.removeEventListener('mouseup', onWinMouseUp);
                };
                window.addEventListener('mousemove', onWinMouseMove);
                window.addEventListener('mouseup', onWinMouseUp);
            }
        });

        // Change cursor when hovering over crop handles/box
        displayCanvas.addEventListener('mousemove', (e) => {
            if (!this.boxCropWidget?.value?.visible || this.boxCropWidget.isDragging) return;
            const videoEl = this.videoElement;
            if (!videoEl || videoEl.videoWidth === 0) return;

            const canvasRect = displayCanvas.getBoundingClientRect();
            const relX = (e.clientX - canvasRect.left) / canvasRect.width * videoEl.videoWidth;
            const relY = (e.clientY - canvasRect.top) / canvasRect.height * videoEl.videoHeight;
            const videoW = videoEl.videoWidth;
            const videoH = videoEl.videoHeight;
            const bv = this.boxCropWidget.value;
            const cx = bv.x * videoW;
            const cy = bv.y * videoH;
            const hw = (bv.width * videoW) / 2;
            const hh = (bv.height * videoH) / 2;

            const corners = [
                { x: cx - hw, y: cy - hh, cursor: 'nw-resize' },
                { x: cx + hw, y: cy - hh, cursor: 'ne-resize' },
                { x: cx + hw, y: cy + hh, cursor: 'se-resize' },
                { x: cx - hw, y: cy + hh, cursor: 'sw-resize' },
            ];

            let cursor = 'default';
            for (const corner of corners) {
                if (Math.sqrt((relX - corner.x) ** 2 + (relY - corner.y) ** 2) < 15) {
                    cursor = corner.cursor;
                    break;
                }
            }
            if (cursor === 'default') {
                const isInside = relX >= cx - hw && relX <= cx + hw && relY >= cy - hh && relY <= cy + hh;
                if (isInside) cursor = 'move';
            }
            displayCanvas.style.cursor = cursor;
        });
        displayCanvas.addEventListener('mouseleave', () => {
            displayCanvas.style.cursor = 'default';
        });

        /**
         * Clear VFR frame cache to free memory.
         * Called when switching videos or node is removed.
         */
        this.clearVFRFrames = () => {
            if (this.vfrFrames && this.vfrFrames.length > 0) {
                // Clear the array to allow garbage collection
                this.vfrFrames = null;
                this.isVFRVideo = false;
            }
        };

        // Abort any in-progress VFR decode (used when switching videos mid-decode)
        this._abortVFRDecode = () => {
            if (this.isVFRDecoding) {
                this._vfrDecodeAborted = true;
                if (videoElement && !videoElement.paused) {
                    videoElement.pause();
                }
                this.isVFRDecoding = false;
                this.isVFRVideo = false;
                this.vfrFrames = null;
                if (placeholderText) {
                    placeholderText.style.display = 'none';
                }
            }
        };

        // Function to load video into custom display - attach to node for external access
        this.loadVideoIntoDisplay = (videoFilename) => {
            if (!videoFilename || String(videoElement.src).includes(videoFilename)) {
                return;
            }

            // Abort any in-progress VFR decode before switching video
            this._abortVFRDecode();

            // Clear VFR frames from previous video before loading new one
            this.clearVFRFrames();

            // Reset frame buffer so stale frames from previous video aren't shown
            this._frameBuffer.width = 0;
            this._frameBuffer.height = 0;

            // Re-clamp crop values to fit within video bounds
            if (this.boxCropWidget) {
                const bv = this.boxCropWidget.value;
                bv.width = Math.min(1.0, bv.width);
                bv.height = Math.min(1.0, bv.height);
                bv.x = Math.max(bv.width / 2, Math.min(1 - bv.width / 2, bv.x));
                bv.y = Math.max(bv.height / 2, Math.min(1 - bv.height / 2, bv.y));
                if (typeof this.syncCropToWidgets === 'function') {
                    this.syncCropToWidgets();
                }
            }

            // Stop playback and reset timeline when loading new video
            if (this.timelineWidget?.value?.isPlaying) {
                this.timelineWidget.stopPlayback();
                this.timelineWidget.value.isPlaying = false;
                if (this._stopHoverAudio) this._stopHoverAudio();
            }
            // Reset current frame to 1 and video time to start
            if (this.timelineWidget) {
                this.timelineWidget.value.currentFrame = 1;
            }
            if (videoElement) {
                videoElement.currentTime = 0;
            }

            // Preload audio for hover playback
            if (this._loadHoverAudio) this._loadHoverAudio(videoFilename);

            // Hide placeholder text
            if (placeholderText) {
                placeholderText.style.display = 'none';
            }

            // Update video source - use type=input for input directory files (ComfyUI's convention)
            const videoSrc = `/view?filename=${encodeURIComponent(videoFilename)}&type=input`;
            videoElement.src = videoSrc;

            // Set up one-time listeners for this load
            const onMetadataLoaded = async () => {

                // Update size display immediately
                if (this.topRowWidget) {
                    this.topRowWidget.sizeValue = `${videoElement.videoWidth}x${videoElement.videoHeight}`;
                }

                // Fetch native FPS from server
                try {
                    const resp = await api.fetchApi(`/wanvideowrapper_qq/video_metadata?filename=${encodeURIComponent(videoFilename)}`);
                    if (resp.ok) {
                        const meta = await resp.json();
                        if (meta.success && meta.fps) {
                            const detectedFPS = Math.round(meta.fps);
                            // Set native FPS on timeline
                            this.timelineWidget.nativeFPS = meta.fps;
                            // Update UI spinner to match native FPS
                            this.topRowWidget.fpsValue = detectedFPS;
                            this.timelineWidget.setFPS(this, detectedFPS);

                            // Use accurate frame count from server
                            let totalFrames;
                            if (meta.frame_count > 0) {
                                totalFrames = meta.frame_count;
                            } else {
                                // Calculate from duration with ceiling to ensure we don't truncate the last frame
                                totalFrames = Math.ceil(videoElement.duration * meta.fps);
                            }
                            this.timelineWidget.setTotalFrames(this, totalFrames);
                            // Only set default markers if not already restored by onConfigure
                            // Check: start marker still at constructor default (1) AND end marker still at constructor default (1)
                            if (this.timelineWidget.startFrameMarker === 1 && this.timelineWidget.endFrameMarker === 1) {
                                this.timelineWidget.setStartFrame(1, this);
                                this.timelineWidget.setEndFrame(totalFrames, this);
                            } else if (this.timelineWidget.endFrameMarker > totalFrames || this.timelineWidget.endFrameMarker === 1) {
                                // End marker exceeds new video length or wasn't set - clamp/update it
                                this.timelineWidget.setEndFrame(Math.min(this.timelineWidget.endFrameMarker || totalFrames, totalFrames), this);
                            }
                            this.timelineWidget.applyPlaybackRate();

                            // === VFR DETECTION ===
                            const durationFromFrames = meta.frame_count / meta.fps;
                            const durationDiff = Math.abs(durationFromFrames - videoElement.duration);
                            const durationDiffPercent = (durationDiff / videoElement.duration) * 100;

                            if (durationDiffPercent > 2) {
                                await this.decodeVFRFrames(videoElement, meta.frame_count, meta.fps);
                            }

                            this.setDirtyCanvas(true, true);
                            return;
                        }
                    }
                } catch (e) {
                    console.warn('[PowerLoadVideo] Could not fetch video metadata, estimating:', e);
                }

                // Fallback: estimate with current FPS
                const nativeFPS = this.timelineWidget.nativeFPS || this.timelineWidget.value.fps || 24;
                // Use ceiling to ensure we capture the full video duration without truncation
                // Add small buffer (1 frame) to account for any edge case timing issues
                const totalFrames = Math.ceil(videoElement.duration * nativeFPS) + 1;
                this.timelineWidget.setTotalFrames(this, totalFrames);
                // Only set default markers if not already restored by onConfigure
                if (this.timelineWidget.startFrameMarker === 1 && this.timelineWidget.endFrameMarker === 1) {
                    this.timelineWidget.setStartFrame(1, this);
                    this.timelineWidget.setEndFrame(totalFrames, this);
                } else if (this.timelineWidget.endFrameMarker > totalFrames || this.timelineWidget.endFrameMarker === 1) {
                    // End marker exceeds new video length or wasn't set - clamp/update it
                    this.timelineWidget.setEndFrame(Math.min(this.timelineWidget.endFrameMarker || totalFrames, totalFrames), this);
                }
                this.timelineWidget.applyPlaybackRate();

                // Force redraw
                this.setDirtyCanvas(true, true);
            };

            const onError = (e) => {
                console.error('[PowerLoadVideo] Video load error:', e);
            };

            videoElement.addEventListener('loadedmetadata', onMetadataLoaded, { once: true });
            videoElement.addEventListener('error', onError, { once: true });

            // Draw first frame when video data becomes available (CFR videos only)
            videoElement.addEventListener('loadeddata', () => {
                if (!this.isVFRVideo && this.displayCanvas) {
                    this.updateDisplayCanvas(1);
                }
            }, { once: true });
        };

        // Override execute to load video into our custom display
        const originalExecute = this.execute;
        this.execute = async function() {
            if (originalExecute) {
                await originalExecute.apply(this, arguments);
            }

            // Get the video filename from various sources
            let videoFilename = null;

            // Try to get from widgets_values first (set during node creation)
            if (this.widgets_values && this.widgets_values.length > 0) {
                videoFilename = this.widgets_values[0];
            }

            // Or try to find a widget with the video filename
            if (!videoFilename) {
                const videoWidget = this.widgets.find(w => w.type === 'combo' || (w.options && w.options.video_upload));
                if (videoWidget) {
                    videoFilename = videoWidget.value;
                }
            }

            // Or try to get from node.videoFilename (set by Upload button)
            if (!videoFilename) {
                videoFilename = this.videoFilename;
            }

            if (typeof this.loadVideoIntoDisplay === 'function') {
                this.loadVideoIntoDisplay(videoFilename);
            }
        }.bind(this);

        // Watch for drag-drop changes on the combo widget (before execute)
        setTimeout(() => {
            const videoWidget = this.widgets.find(w => w.type === 'combo');
            if (videoWidget) {
                // Store original callback if any
                const originalCallback = videoWidget.callback;
                videoWidget.callback = function(value) {
                    if (typeof this.loadVideoIntoDisplay === 'function') {
                        this.loadVideoIntoDisplay(value);
                    }
                    if (originalCallback) {
                        originalCallback.apply(this, arguments);
                    }
                }.bind(this);
            }
        }, 100);
    };
}
