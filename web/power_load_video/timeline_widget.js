/**
 * Timeline Widget for video playback control
 * Styled to match Power Spline Editor's timeline aesthetic
 */
import { QQBaseWidget } from '../power_spline_editor/drawing_utils.js';

export class PowerLoadVideoTimelineWidget extends QQBaseWidget {
    constructor(name = "PowerLoadVideoTimeline") {
        super(name);
        this.type = "custom";
        this.options = { serialize: false };
        this.value = {
            isPlaying: false,  // Changed to false - no auto-playback
            currentFrame: 1,
            totalFrames: 1,
            fps: 24
        };

        // Native FPS of the loaded video (detected from backend)
        this.nativeFPS = 24;

        // Animation state
        this.animationId = null;
        this.lastUpdateTime = 0;

        // Fix #1 & #2: Initialize hitAreas and mouseDowned to prevent runtime errors
        this.hitAreas = {};
        this.mouseDowned = false;

        // Fix #7: Initialize showTimeline to true by default (timeline should always be visible)
        this.showTimeline = true;

        // Frame bounds markers - start and end frame indicators
        this.startFrameMarker = 1;     // [ marker position (start bound)
        this.endFrameMarker = 1;       // ] marker position (end bound) - defaults to frame 1, updated on video load
        this.markerSize = 16;          // Size of the bracket symbols
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;

        // Create persistent hit area objects (don't recreate on every draw!)
        // This ensures object identity is preserved between pointerdown and pointermove events
        this.hitAreas.timeline = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };
        this.hitAreas.timelinePlay = {
            bounds: [0, 0, 0, 0],
            onClick: null
        };
        // Hit areas for frame bound markers
        this.hitAreas.startMarker = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };
        this.hitAreas.endMarker = {
            bounds: [0, 0, 0, 0],
            onClick: null,
            onMove: null
        };

    }

    /**
     * Ensure value is properly initialized as an object
     */
    ensureValueInitialized() {
        if (typeof this.value !== 'object' || this.value === null || Array.isArray(this.value)) {
            console.warn('[PowerLoadVideoTimelineWidget] Value was corrupted, reinitializing');
            this.value = {
                isPlaying: false,
                currentFrame: 1,
                totalFrames: 1,
                fps: 24
            };
        }
    }

    /**
     * Update the total frame count for this node's timeline
     */
    setTotalFrames(node, totalFrames) {
        this.ensureValueInitialized();
        if (totalFrames && totalFrames > 0) {
            this.value.totalFrames = totalFrames;
            // Clamp current frame to new range
            this.value.currentFrame = Math.max(1, Math.min(this.value.currentFrame, totalFrames));
            node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Update FPS for playback speed control
     */
    setFPS(node, fps) {
        this.ensureValueInitialized();
        if (fps && fps > 0) {
            this.value.fps = fps;
            // Apply playback rate to video element
            this.applyPlaybackRate();
        }
    }

    /**
     * Set the native FPS of the loaded video
     */
    setNativeFPS(node, fps) {
        if (fps && fps > 0) {
            this.nativeFPS = fps;
            // Recalculate total frames if we have duration - use ceiling to avoid truncation
            if (this.videoElement && this.videoElement.duration && isFinite(this.videoElement.duration)) {
                const totalFrames = Math.ceil(this.videoElement.duration * this.nativeFPS);
                this.setTotalFrames(node, totalFrames);
            }
            // Re-apply playback rate with new native FPS
            this.applyPlaybackRate();
        }
    }

    /**
     * Apply playback rate based on user FPS vs native FPS
     */
    applyPlaybackRate() {
        if (this.videoElement) {
            const rate = this.value.fps / this.nativeFPS;
            this.videoElement.playbackRate = rate;
        }
    }

    /**
     * Set the video element reference for direct control
     */
    setVideoElement(videoElement) {
        this.videoElement = videoElement;
    }

    /**
     * Main draw function for the timeline widget
     */
    draw(ctx, node) {
        // Ensure value is properly initialized (defensive against serialization issues)
        this.ensureValueInitialized();

        const padding = 16;
        const detailRowHeight = this.computeSize(node.size[0])[1];
        const playSize = Math.min(22, detailRowHeight - 4);

        ctx.save();

        // Calculate layout (full width timeline)
        const detailX = padding;
        const canvasToTimelineOffset = 8; // Offset between video canvas and timeline
        const detailY = this.y + canvasToTimelineOffset;
        const detailWidth = node.size[0] - padding * 2;

        // === UNIFIED CONTAINER WITH ROUNDED BORDER ===
        const containerBorderRadius = 6; // Rounded corners for container border
        const containerPadding = 8; // Padding inside the container

        // Container spans from play button area to frame counter
        const containerX = detailX + padding;
        const containerY = detailY + 2; // Small top offset
        const containerWidth = detailWidth - padding * 2;
        const containerHeight = detailRowHeight - 4;
        const containerMidY = containerY + containerHeight / 2;

        const playActive = this.value.isPlaying;
        const playPressed = this._isButtonPressed('timelinePlay');

        ctx.save();

        // Draw unified rounded container (like Power Spline Editor style)
        ctx.fillStyle = '#1a1a1a'; // Dark background for container
        ctx.strokeStyle = '#555'; // Border color
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(containerX, containerY, containerWidth, containerHeight, [containerBorderRadius]);
        } else {
            // Fallback for rounded rectangle
            const r = containerBorderRadius;
            ctx.moveTo(containerX + r, containerY);
            ctx.lineTo(containerX + containerWidth - r, containerY);
            ctx.arc(containerX + containerWidth - r, containerY + r, r, Math.PI * 1.5, Math.PI * 2);
            ctx.lineTo(containerX + containerWidth, containerHeight - r);
            ctx.arc(containerX + containerWidth - r, containerHeight - r, r, 0, Math.PI * 0.5);
            ctx.lineTo(containerX + r, containerHeight);
            ctx.arc(containerX + r, containerHeight - r, r, Math.PI * 0.5, Math.PI);
            ctx.lineTo(containerX, containerY + r);
            ctx.arc(containerX + r, containerY + r, r, Math.PI, Math.PI * 1.5);
        }
        ctx.fill();
        ctx.stroke();

        // === DRAW PLAY/PAUSE ICON (inside container) ===
        const playX = containerX + containerPadding;
        const playY = containerMidY - playSize / 2;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = playActive ? '#2cc6ff' : LiteGraph.WIDGET_TEXT_COLOR; // Cyan when playing
        ctx.font = `${Math.max(14, playSize * 0.8)}px Sans-Serif`;
        const icon = playActive ? '⏸' : '▶';
        ctx.fillText(icon, playX + playSize / 2, playY + playSize / 2 + (playPressed ? 1 : 0));

        // Update persistent hit area bounds only (don't recreate object!)
        this.hitAreas.timelinePlay.bounds = [playX, playY, playSize, playSize];
        if (!this.hitAreas.timelinePlay.onClick) {
            this.hitAreas.timelinePlay.onClick = (e, pos, n) => this.togglePlay(n);
        }

        // === DRAW TIMELINE TRACK (inside container) ===
        const spacer = 10;

        const sliderSteps = this.value.totalFrames || 1;
        const sliderValue = this.value.currentFrame;
        const sliderProgress = sliderSteps > 1 ? (sliderValue - 1) / (sliderSteps - 1) : 0;

        // Measure frame counter text width using fixed font and always assume 3 digits (999/999)
        // This prevents the timeline from scaling when frames go from 2 to 3 digits
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `${Math.max(14, playSize * 0.8)}px Sans-Serif`;
        const frameCounterWidth = ctx.measureText('999/999').width + 8; // Always reserve space for 6 digits + separator

        // Calculate timeline dimensions based on available space minus frame counter
        const timelineX = playX + playSize + spacer;
        const timelineHeight = 16; // Timeline track height
        const timelineY = containerMidY - timelineHeight / 2;
        const timelineMidY = containerMidY;
        const timelineWidth = Math.max(10, containerWidth - containerPadding * 2 - playSize - spacer * 2 - frameCounterWidth);
        const timelineEnd = timelineX + timelineWidth;
        const stepWidth = sliderSteps > 1 ? timelineWidth / (sliderSteps - 1) : 0;

        // Timeline track line (inside the container)
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(timelineX, timelineMidY);
        ctx.lineTo(timelineEnd, timelineMidY);
        ctx.stroke();

        // Frame markers (dots evenly distributed for visual reference)
        ctx.fillStyle = '#777';
        const maxMarkers = 100; // Limit markers for performance
        const actualMarkerCount = Math.min(sliderSteps, maxMarkers);
        const markerStep = sliderSteps > 1 ? sliderSteps / (actualMarkerCount - 1) : 1;
        for (let i = 0; i < actualMarkerCount; i++) {
            const frameIndex = Math.round(i * markerStep);
            const x = timelineX + stepWidth * frameIndex;
            // Draw larger dot every ~5 markers for better visual reference
            const isMajorMarker = i % 5 === 0;
            ctx.beginPath();
            ctx.arc(x, timelineMidY, isMajorMarker ? 2 : 1, 0, Math.PI * 2);
            ctx.fill();
        }

        // === DRAW SLIDER HANDLE (styled like Power Spline Editor) ===
        ctx.fillStyle = '#2cc6ff'; // Cyan color matching PSE
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;

        const sliderHalfWidth = Math.max(3, detailRowHeight * 0.12);
        const sliderHalfHeight = Math.max(8, detailRowHeight * 0.35);
        const sliderPosX = timelineX + sliderProgress * timelineWidth;
        ctx.beginPath();
        ctx.rect(sliderPosX - sliderHalfWidth, timelineMidY - sliderHalfHeight, sliderHalfWidth * 2, sliderHalfHeight * 2);
        ctx.fill();
        ctx.stroke();

        // === DRAW FRAME BOUND MARKERS [ and ] ===
        // Red bracket symbols that mark start/end bounds on the timeline
        const markerFont = `${this.markerSize}px monospace`;
        ctx.font = markerFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Calculate positions for markers based on frame numbers
        const getMarkerX = (frameNum) => {
            if (!frameNum || frameNum < 1) return timelineX;
            const progress = Math.max(0, Math.min((frameNum - 1) / (Math.max(1, sliderSteps - 1)), 1));
            return timelineX + progress * timelineWidth;
        };

        // Draw start marker [ in red
        if (this.startFrameMarker >= 1) {
            const startX = getMarkerX(this.startFrameMarker);
            ctx.fillStyle = '#ff0000'; // Red color for markers
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;

            // Draw bracket with slight shadow/outline for visibility
            ctx.save();
            ctx.translate(startX, timelineMidY);
            ctx.fillText('[', 0, 0);
            ctx.restore();
        }

        // Draw end marker ] in red (only if set)
        if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
            const endX = getMarkerX(this.endFrameMarker);
            ctx.fillStyle = '#ff0000'; // Red color for markers
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;

            // Draw bracket with slight shadow/outline for visibility
            ctx.save();
            ctx.translate(endX, timelineMidY);
            ctx.fillText(']', 0, 0);
            ctx.restore();
        }

        // Frame counter label (inside container on the right)
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        const frameCounterX = timelineEnd + spacer;
        ctx.fillText(`${sliderValue}/${sliderSteps}`, frameCounterX, timelineMidY);

        ctx.restore();

        // === SETUP HIT AREAS ===
        // Use the timeline track area for seek interaction
        // Expand hit area vertically to cover entire widget height for easier scrubbing
        const expandedTimelineHeight = detailRowHeight; // Full widget height for hit detection

        // Update persistent hit area bounds only (don't recreate object!)
        this.hitAreas.timeline.bounds = [timelineX, detailY, timelineWidth, expandedTimelineHeight];
        if (!this.hitAreas.timeline.onClick) {
            this.hitAreas.timeline.onClick = (e, pos, n) => this.seekToPosition(e, pos, n);
        }
        if (!this.hitAreas.timeline.onMove) {
            this.hitAreas.timeline.onMove = (e, pos, n) => this.dragSeek(e, pos, n);
        }

        // Hit areas for frame bound markers [ and ]
        const markerHitRadius = this.markerSize / 2;

        // Start marker hit area
        if (this.startFrameMarker >= 1) {
            const startX = getMarkerX(this.startFrameMarker);
            this.hitAreas.startMarker.bounds = [
                startX - markerHitRadius,
                timelineMidY - markerHitRadius,
                markerHitRadius * 2,
                markerHitRadius * 2
            ];
            // Use onDown for immediate response on pointerdown (before drag starts)
            if (!this.hitAreas.startMarker.onDown) {
                this.hitAreas.startMarker.onDown = (e, pos, n) => this.onMarkerClick('start', e, pos, n);
            }
            if (!this.hitAreas.startMarker.onMove) {
                this.hitAreas.startMarker.onMove = (e, pos, n) => this.onMarkerDrag('start', e, pos, n);
            }
        }

        // End marker hit area
        if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
            const endX = getMarkerX(this.endFrameMarker);
            this.hitAreas.endMarker.bounds = [
                endX - markerHitRadius,
                timelineMidY - markerHitRadius,
                markerHitRadius * 2,
                markerHitRadius * 2
            ];
            // Use onDown for immediate response on pointerdown (before drag starts)
            if (!this.hitAreas.endMarker.onDown) {
                this.hitAreas.endMarker.onDown = (e, pos, n) => this.onMarkerClick('end', e, pos, n);
            }
            if (!this.hitAreas.endMarker.onMove) {
                this.hitAreas.endMarker.onMove = (e, pos, n) => this.onMarkerDrag('end', e, pos, n);
            }
        }

        ctx.restore();
    }

    /**
     * Draw button background matching Power Spline Editor style
     */
    _drawButtonBackground(ctx, x, y, width, height, active) {
        ctx.save();
        ctx.fillStyle = active ? '#0d3b4a' : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = active ? '#2cc6ff' : LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();

        // Fix #4: Use fallback for roundRect compatibility with older browsers
        if (ctx.roundRect) {
            ctx.roundRect(x, y, width, height, [6]);
        } else {
            // Fallback: draw rounded rectangle using arcTo
            const r = 6;
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + width - r, y);
            ctx.arcTo(x + width, y, x + width, y + r, r);
            ctx.lineTo(x + width, y + height - r);
            ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
            ctx.lineTo(x + r, y + height);
            ctx.arcTo(x, y + height, x, y + height - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
        }

        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Check if a button is currently pressed
     */
    _isButtonPressed(buttonName) {
        const hitArea = this.hitAreas[buttonName];
        return hitArea?.wasMouseClickedAndIsOver || false;
    }

    /**
     * Toggle play/pause state
     */
    togglePlay(node) {
        if (node.isVFRDecoding) return;  // Locked during VFR frame capture
        this.value.isPlaying = !this.value.isPlaying;

        if (this.value.isPlaying) {
            this.startPlayback(node);
            // Only start hover audio if mouse is currently over the video
            if (node._isHovering && node._startHoverAudio) node._startHoverAudio();
        } else {
            this.stopPlayback();
            // Stop hover audio
            if (node._stopHoverAudio) node._stopHoverAudio();
        }

        node.setDirtyCanvas(true, true);
    }

    /**
     * Start video playback using native HTML5 video element
     * The animation loop now reads from the video's actual position instead of driving it.
     */
    startPlayback(node) {
        // Fix #3: Cancel any existing animation first for safety against memory leaks
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        const fps = this.value.fps || 24;
        const frameInterval = 1000 / fps;
        const nativeFPS = this.nativeFPS || 24;

        // Enable loop mode and start playback
        if (this.videoElement && this.videoElement.duration) {
            // CFR: Use native video playback
            this.videoElement.loop = true;

            // Start actual video playback - let the browser handle buffering naturally
            const playPromise = this.videoElement.play();
            if (playPromise) {
                playPromise.catch(err => {
                    console.warn('[PowerLoadVideo] Play promise rejected:', err);
                    this.value.isPlaying = false;
                    if (node._stopHoverAudio) node._stopHoverAudio();
                });
            }
        }

        // Animation loop reads from video position instead of driving it
        const animate = () => {
            if (!this.videoElement || !this.value.isPlaying) {
                this.stopPlayback();
                return;
            }

            // Read current frame from video's actual playback position
            if (node.isVFRVideo) {
                // VFR: Drive frames manually using elapsed time from pre-decoded array
                const now = performance.now();
                const elapsed = now - this.lastUpdateTime;

                if (elapsed >= frameInterval) {
                    this.lastUpdateTime = now - (elapsed % frameInterval);
                    const startMarker = this.startFrameMarker || 1;
                    const endMarker = this.endFrameMarker !== null && this.endFrameMarker >= 1
                        ? this.endFrameMarker
                        : this.value.totalFrames;

                    let currentFrame = this.value.currentFrame + 1;

                    // Handle looping within markers
                    if (currentFrame > endMarker) {
                        currentFrame = startMarker;
                        if (node._isHovering && node._restartHoverAudioOnLoop) {
                            node._restartHoverAudioOnLoop();
                        }
                    }

                    this.value.currentFrame = currentFrame;
                    if (node.updateDisplayCanvas) {
                        node.updateDisplayCanvas(currentFrame);
                    }
                    node.setDirtyCanvas(true, true);
                }
            } else if (this.videoElement.duration && !isNaN(this.videoElement.currentTime)) {
                // CFR: Read current frame from video's actual playback position
                let currentTime = this.videoElement.currentTime;

                // Read marker positions dynamically each frame (not captured in closure)
                const startMarker = this.startFrameMarker || 1;
                const endMarker = this.endFrameMarker !== null && this.endFrameMarker >= 1
                    ? this.endFrameMarker
                    : this.value.totalFrames;
                const startTime = (startMarker - 1) / nativeFPS;
                const endTime = (endMarker - 1) / nativeFPS;

                // Handle looping: if we've gone past endMarker, seek back to start
                if (currentTime >= endTime) {
                    currentTime = startTime;
                    this.videoElement.currentTime = startTime;

                    // Restart hover audio on loop if still hovering and playing
                    if (node._isHovering && node._restartHoverAudioOnLoop) {
                        node._restartHoverAudioOnLoop();
                    }
                }

                // Convert time to frame number for display
                const currentFrame = Math.floor(currentTime * nativeFPS) + 1;
                if (this.value.currentFrame !== currentFrame) {
                    this.value.currentFrame = currentFrame;
                    // Draw current frame to display canvas (video is hidden)
                    if (node.updateDisplayCanvas) {
                        node.updateDisplayCanvas(currentFrame);
                    }
                    node.setDirtyCanvas(true, true);
                }
            }

            this.animationId = requestAnimationFrame(animate);
        };

        this.lastUpdateTime = performance.now();
        this.animationId = requestAnimationFrame(animate);
    }

    /**
     * Stop video playback and pause the video element
     */
    stopPlayback() {
        // Pause the actual video element
        if (this.videoElement && !this.videoElement.paused) {
            this.videoElement.pause();
        }

        // Disable native looping when stopped
        if (this.videoElement) {
            this.videoElement.loop = false;
        }

        // Cancel the animation loop
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * Seek to a specific position on click
     */
    seekToPosition(event, pos, node) {
        this.ensureValueInitialized();
        if (node.isVFRDecoding) return;  // Locked during VFR frame capture
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];

        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;

        const newFrame = Math.max(1, Math.round(ratio * (this.value.totalFrames - 1)) + 1);
        this.value.currentFrame = newFrame;

        // For VFR videos with decoded frames, update video time but display comes from frame array
        if (this.videoElement && this.videoElement.duration) {
            const nativeFPS = this.nativeFPS || 24;
            const newTime = (newFrame - 1) / nativeFPS;
            const clampedTime = Math.min(newTime, this.videoElement.duration);
            this.videoElement.currentTime = clampedTime;
        }

        // Update display canvas for VFR videos or if node has updateDisplayCanvas method
        if (node.updateDisplayCanvas) {
            node.updateDisplayCanvas(this.value.currentFrame);
        } else if (this.videoElement && !node.isVFRVideo) {
            // For non-VFR, just ensure video is at right time
        }

        node.setDirtyCanvas(true, true);
    }

    /**
     * Drag to seek along timeline
     * Called by base class QQBaseWidget when mouse is dragged over hit area
     * Uses direct position calculation for smooth real-time scrubbing
     */
    dragSeek(event, pos, node) {
        this.ensureValueInitialized();
        if (node.isVFRDecoding) return;  // Locked during VFR frame capture
        // Use the current mouse position directly for real-time scrubbing
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const totalFrames = this.value.totalFrames || 1;

        // Calculate frame from absolute position (same as seekToPosition)
        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;
        const newFrame = Math.max(1, Math.round(ratio * (totalFrames - 1)) + 1);

        if (newFrame !== this.value.currentFrame) {
            this.value.currentFrame = newFrame;

            // For VFR videos with decoded frames, update video time but display comes from frame array
            if (this.videoElement && this.videoElement.duration) {
                const nativeFPS = this.nativeFPS || 24;
                const newTime = (newFrame - 1) / nativeFPS;
                this.videoElement.currentTime = Math.min(newTime, this.videoElement.duration);
            }

            // Update display canvas for VFR videos or if node has updateDisplayCanvas method
            if (node.updateDisplayCanvas) {
                node.updateDisplayCanvas(this.value.currentFrame);
            }

            node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Calculate distance from click position to a marker's center
     * Used to determine which marker was actually clicked when they are close together
     */
    getDistanceToMarkerCenter(pos, markerFrame) {
        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const sliderSteps = this.value.totalFrames || 1;

        // Calculate the X position of this marker
        const progress = Math.max(0, Math.min((markerFrame - 1) / (Math.max(1, sliderSteps - 1)), 1));
        const markerX = timelineX + progress * timelineWidth;

        // Get timeline mid Y from the hit area bounds
        const timelineY = this.hitAreas.timeline.bounds[1];
        const timelineHeight = this.hitAreas.timeline.bounds[3];
        const timelineMidY = timelineY + timelineHeight / 2;

        // Calculate Euclidean distance
        const dx = pos[0] - markerX;
        const dy = pos[1] - timelineMidY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Handle click on frame bound markers [ or ]
     * Start dragging if Shift key is held, otherwise just select the marker
     * When markers are close together, only the closest one to the click position will be dragged
     */
    onMarkerClick(markerType, event, pos, node) {
        // Check if Shift key is held down for dragging
        const shiftHeld = event.shiftKey;

        if (shiftHeld) {
            // When both markers exist and are close together, determine which one was actually clicked
            // by calculating distance to each marker's center
            if (this.startFrameMarker >= 1 && this.endFrameMarker !== null && this.endFrameMarker >= 1) {
                const distToStart = this.getDistanceToMarkerCenter(pos, this.startFrameMarker);
                const distToEnd = this.getDistanceToMarkerCenter(pos, this.endFrameMarker);

                // Only start dragging if this marker is closer to the click than the other
                if (markerType === 'start') {
                    if (distToStart <= distToEnd) {
                        this.draggingStartMarker = true;
                    }
                } else {
                    if (distToEnd < distToStart) {
                        this.draggingEndMarker = true;
                    }
                }
            } else {
                // Only one marker exists, drag it directly
                if (markerType === 'start') {
                    this.draggingStartMarker = true;
                } else {
                    this.draggingEndMarker = true;
                }
            }
        }
        // Without Shift, we could add other interactions later (like snapping playback head to marker)
    }

    /**
     * Handle drag on frame bound markers [ or ]
     * Only allows dragging when Shift key is held down AND the specific marker was clicked
     * Markers are constrained not to cross each other
     */
    onMarkerDrag(markerType, event, pos, node) {
        // Check if Shift key is held down - required for dragging markers
        const shiftHeld = event.shiftKey;

        if (!shiftHeld) {
            return; // Don't allow dragging without Shift
        }

        // Only drag the specific marker that was clicked (not both when they're close)
        if (markerType === 'start' && !this.draggingStartMarker) {
            return;
        }
        if (markerType === 'end' && !this.draggingEndMarker) {
            return;
        }

        const timelineX = this.hitAreas.timeline.bounds[0];
        const timelineWidth = this.hitAreas.timeline.bounds[2];
        const totalFrames = this.value.totalFrames || 1;

        // Calculate frame from absolute position
        const relativeX = Math.max(0, Math.min(timelineWidth, pos[0] - timelineX));
        const ratio = timelineWidth > 0 ? relativeX / timelineWidth : 0;
        let newFrame = Math.max(1, Math.round(ratio * (totalFrames - 1)) + 1);

        // Apply constraints based on marker type
        if (markerType === 'start') {
            // Start marker [ cannot go past end marker ]
            if (this.endFrameMarker !== null && this.endFrameMarker >= 1) {
                newFrame = Math.min(newFrame, this.endFrameMarker);
            }

            if (newFrame !== this.startFrameMarker) {
                this.startFrameMarker = newFrame;
                // Sync to hidden widget so backend receives the value
                const w = node.widgets.find(w => w.name === 'start_frame');
                if (w) w.value = newFrame;
                this.updateFrameCountDisplay(node);
                node.setDirtyCanvas(true, true);
            }
        } else if (markerType === 'end') {
            // End marker ] cannot go past start marker [
            if (this.startFrameMarker >= 1) {
                newFrame = Math.max(newFrame, this.startFrameMarker);
            }

            if (newFrame !== this.endFrameMarker) {
                this.endFrameMarker = newFrame;
                // Sync to hidden widget so backend receives the value
                const w = node.widgets.find(w => w.name === 'end_frame');
                if (w) w.value = newFrame;
                this.updateFrameCountDisplay(node);
                node.setDirtyCanvas(true, true);
            }
        }
    }

    /**
     * Handle mouse up - reset dragging flags for markers
     */
    onMouseUp(event, pos, node) {
        // Reset marker dragging flags when mouse is released
        this.draggingStartMarker = false;
        this.draggingEndMarker = false;
    }

    /**
     * Set the start frame marker position [
     */
    setStartFrame(frame, node) {
        this.startFrameMarker = Math.max(1, frame || 1);
        // Sync to hidden widget so backend receives the value
        if (node) {
            const w = node.widgets.find(w => w.name === 'start_frame');
            if (w) w.value = this.startFrameMarker;
        }
        this.updateFrameCountDisplay(node);
    }

    /**
     * Set the end frame marker position ]
     */
    setEndFrame(frame, node) {
        this.endFrameMarker = frame !== null && frame !== undefined ? Math.max(1, frame) : null;
        // Sync to hidden widget so backend receives the value
        if (node && this.endFrameMarker !== null) {
            const w = node.widgets.find(w => w.name === 'end_frame');
            if (w) w.value = this.endFrameMarker;
        }
        this.updateFrameCountDisplay(node);
    }

    /**
     * Update the top row frame count display (?f -> "123f")
     */
    updateFrameCountDisplay(node) {
        if (node && node.topRowWidget) {
            const start = this.startFrameMarker || 1;
            const end = this.endFrameMarker || this.value.totalFrames || 1;
            const count = Math.max(0, end - start + 1);
            node.topRowWidget.frameCountValue = count + "f";
        }
    }

    /**
     * Get current start frame marker value
     */
    getStartFrame() {
        return this.startFrameMarker;
    }

    /**
     * Get current end frame marker value
     */
    getEndFrame() {
        return this.endFrameMarker;
    }

    /**
     * Cleanup when node is removed
     */
    onRemove(node) {
        this.stopPlayback();
    }

    /**
     * Set whether the timeline should be visible
     * Similar to Power Spline Editor's box layer behavior when "Add Keyframes" is pressed
     */
    setShowTimeline(show) {
        this.showTimeline = !!show;
    }

    /**
     * Compute widget size - returns 0 height when hidden, 36px when visible
     * Similar to Power Spline Editor's box layer behavior
     */
    computeSize(width) {
        const result = this.showTimeline ? [width, 36] : [width, 0];
        return result;
    }
}
