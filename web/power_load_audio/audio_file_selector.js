/**
 * File Selector Widget for Power Load Audio
 * Row: [x] [◀ name.mp3 ▶] [Upload] [Crop] → len
 * The checkbox toggles hover-preview playback in the search dropdown.
 * The hidden combo widget remains the source of truth for the backend.
 */
import { api } from '../../../scripts/api.js';
import { app } from '../../../scripts/app.js';
import { QQBaseWidget, fitString } from '../power_spline_editor/drawing_utils.js';

export class PowerAudioFileSelectorWidget extends QQBaseWidget {
    constructor(node) {
        super('PowerAudioFileSelector');
        this.type = 'custom';
        this.options = { serialize: false };
        this.node = node;
        this.currentFilename = '';
        this.lengthValue = '?f · ?s';   // output length readout (crop + speed)
        this.dropdownOpen = false;
        this.dropdownElement = null;
        this.searchQuery = '';          // remembered across dropdown opens
        this.cropMouseDown = false;
        this.cropInProgress = false;
        this._closeDropdownHandler = null;

        // Hover-preview toggle (checkbox, on by default) + preview player
        this.previewOn = node?.properties?.preview_on_hover !== false;
        this._previewBuffers = new Map();  // filename -> Promise<AudioBuffer>|AudioBuffer
        this._previewSrc = null;
        this._previewGain = null;
        this._previewCtx = null;           // only used if the node has no audio ctx
        this._previewTimer = null;
        this._previewToken = 0;

        this.hitAreas = {
            previewToggle: { bounds: [0, 0], onDown: null },
            prevButton: { bounds: [0, 0], onClick: null },
            fileSelector: { bounds: [0, 0], onClick: null },
            nextButton: { bounds: [0, 0], onClick: null },
            uploadButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
            cropButton: { bounds: [0, 0], onDown: null, onUp: null },
        };
    }

    setCurrentFilename(filename) {
        this.currentFilename = filename || '';
    }

    getComboWidget() {
        return this.node.widgets.find(w => w.type === 'combo');
    }

    getAvailableFiles() {
        const combo = this.getComboWidget();
        return (combo && combo.options && combo.options.values) ? combo.options.values : [];
    }

    selectFile(filename) {
        this.currentFilename = filename;
        const combo = this.getComboWidget();
        if (combo) combo.value = filename;
        this.node.audioFilename = filename;
        if (!this.node.widgets_values || this.node.widgets_values.length === 0) {
            this.node.widgets_values = [filename];
        } else {
            this.node.widgets_values[0] = filename;
        }
        if (typeof this.node.loadAudioIntoDisplay === 'function') {
            // user picked a different file - crop markers go back to full range
            this.node.loadAudioIntoDisplay(filename, true);
        }
        this.closeDropdown();
        this.node.setDirtyCanvas(true, true);
    }

    selectPrevFile() {
        const files = this.getAvailableFiles();
        if (files.length === 0) return;
        let idx = files.indexOf(this.currentFilename);
        idx = idx <= 0 ? files.length - 1 : idx - 1;
        this.selectFile(files[idx]);
    }

    selectNextFile() {
        const files = this.getAvailableFiles();
        if (files.length === 0) return;
        let idx = files.indexOf(this.currentFilename);
        idx = idx < 0 || idx >= files.length - 1 ? 0 : idx + 1;
        this.selectFile(files[idx]);
    }

    /**
     * Filter files by search query (supports multiple keywords, partial matching)
     */
    filterFiles(files, query) {
        if (!query || query.trim() === '') return files;

        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

        return files.filter(filename => {
            const lowerFilename = filename.toLowerCase();
            // All keywords must be present (AND logic)
            return keywords.every(keyword => lowerFilename.includes(keyword));
        });
    }

    // ================= HOVER PREVIEW =================

    getPreviewContext() {
        // Reuse the node's context (primed on click to satisfy autoplay policy)
        let ctx = this.node?._ensureAudioCtx?.();
        if (!ctx) {
            if (!this._previewCtx) {
                this._previewCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            ctx = this._previewCtx;
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => { /* noop */ });
        return ctx;
    }

    /**
     * Fetch + decode a file for hover preview. Cached per filename; a failed
     * decode is evicted so hovering again retries.
     */
    getPreviewBuffer(filename) {
        const cached = this._previewBuffers.get(filename);
        if (cached) return cached;
        const ctx = this.getPreviewContext();
        const promise = fetch(`/view?filename=${encodeURIComponent(filename)}&type=input`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.arrayBuffer();
            })
            .then(data => ctx.decodeAudioData(data))
            .catch(err => {
                this._previewBuffers.delete(filename);
                console.warn('[PowerLoadAudio] Preview decode failed:', filename, err);
                return null;
            });
        this._previewBuffers.set(filename, promise);
        // Bounded cache - drop the oldest entry when it grows too large
        if (this._previewBuffers.size > 16) {
            const oldest = this._previewBuffers.keys().next().value;
            if (oldest !== filename) this._previewBuffers.delete(oldest);
        }
        return promise;
    }

    /** Schedule a preview (short delay so sweeping the list doesn't spam). */
    startPreview(filename) {
        if (!this.previewOn || !filename) return;
        this.stopPreview();
        const token = this._previewToken;
        this._previewTimer = setTimeout(() => {
            this._previewTimer = null;
            if (token !== this._previewToken) return;
            this.playPreviewBuffer(filename, token);
        }, 120);
    }

    async playPreviewBuffer(filename, token) {
        const buffer = await this.getPreviewBuffer(filename);
        if (!buffer || token !== this._previewToken) return;
        // The preview takes over the transport - stop the node's own player
        // so the two never play at the same time.
        const node = this.node;
        if (node?.timelineWidget?.value?.isPlaying) {
            node.timelineWidget.value.isPlaying = false;
            node.timelineWidget.stopPlayback();
            node.stopAudioPlayback?.();
            node.setDirtyCanvas?.(true, true);
        }
        const ctx = this.getPreviewContext();
        this.stopPreviewSource();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(1.0, now + 0.02);
        src.connect(gain);
        gain.connect(ctx.destination);
        src.onended = () => {
            try { src.disconnect(); } catch (e) { /* noop */ }
            try { gain.disconnect(); } catch (e) { /* noop */ }
        };
        src.start();
        this._previewSrc = src;
        this._previewGain = gain;
    }

    stopPreviewSource() {
        const src = this._previewSrc;
        const gain = this._previewGain;
        this._previewSrc = null;
        this._previewGain = null;
        if (!src) return;
        // Short fade-out to avoid an audible click on abrupt stop
        try {
            if (gain) {
                const now = gain.context.currentTime;
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
            }
        } catch (e) { /* noop */ }
        setTimeout(() => {
            try { src.stop(); } catch (e) { /* already stopped */ }
            try { src.disconnect(); } catch (e) { /* noop */ }
            try { gain?.disconnect(); } catch (e) { /* noop */ }
        }, 45);
    }

    /** Kill pending + active preview (hover-out, close, toggle off). */
    stopPreview() {
        this._previewToken++;
        if (this._previewTimer) {
            clearTimeout(this._previewTimer);
            this._previewTimer = null;
        }
        this.stopPreviewSource();
    }

    togglePreview() {
        this.previewOn = !this.previewOn;
        if (this.node?.properties) this.node.properties.preview_on_hover = this.previewOn;
        if (!this.previewOn) this.stopPreview();
        this.node?.setDirtyCanvas?.(true, true);
        return true;
    }

    openDropdown() {
        this.closeDropdown();
        const files = this.getAvailableFiles();
        if (files.length === 0) return;

        // Prime the audio context inside the opening click (a user gesture)
        // so hover previews are allowed by autoplay policies.
        this.getPreviewContext();

        const dropdown = document.createElement('div');
        dropdown.className = 'power-load-audio-dropdown';
        dropdown.style.cssText = `
            position: fixed;
            background-color: #1a1a1a;
            border: 1px solid #555;
            border-radius: 4px;
            max-height: 280px;
            z-index: 10000;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        `;

        // === SEARCH INPUT BAR (top row) ===
        const searchContainer = document.createElement('div');
        searchContainer.style.cssText = `
            padding: 6px 8px;
            border-bottom: 1px solid #333;
            background-color: #0f0f0f;
            position: sticky;
            top: 0;
            z-index: 1;
        `;

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = this.currentFilename || 'Search audio...';
        // Restore the previous search so reopening the dropdown feels continuous
        searchInput.value = this.searchQuery;
        searchInput.style.cssText = `
            width: 100%;
            padding: 6px 8px;
            background-color: #2a2a2a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #eee;
            font-size: 13px;
            outline: none;
            box-sizing: border-box;
        `;

        // Focus the input immediately when dropdown opens. Caret goes to the
        // end so a remembered query can be extended instead of replaced.
        const placeCaretAtEnd = () => {
            const len = searchInput.value.length;
            searchInput.setSelectionRange(len, len);
        };
        searchInput.addEventListener('focus', placeCaretAtEnd);

        searchContainer.appendChild(searchInput);
        dropdown.appendChild(searchContainer);

        // === FILE LIST CONTAINER ===
        const fileList = document.createElement('div');
        fileList.style.cssText = `
            max-height: 240px;
            overflow-y: auto;
        `;

        // Start from the remembered query so the list matches the input
        let filteredFiles = this.filterFiles(files, this.searchQuery);

        /**
         * Render file list items (called on init and after filter changes)
         */
        const renderFileList = () => {
            // Items are about to be replaced - don't leave a preview running
            this.stopPreview();
            fileList.innerHTML = '';

            if (filteredFiles.length === 0) {
                const noResults = document.createElement('div');
                noResults.textContent = 'No matching audio';
                noResults.style.cssText = `
                    padding: 12px;
                    color: #666;
                    font-size: 13px;
                    text-align: center;
                `;
                fileList.appendChild(noResults);
                return;
            }

            filteredFiles.forEach(filename => {
                const item = document.createElement('div');
                item.textContent = filename;
                const isCurrent = filename === this.currentFilename;
                item.style.cssText = `
                    padding: 6px 12px;
                    cursor: pointer;
                    color: ${isCurrent ? '#2cc6ff' : '#ccc'};
                    font-size: 13px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    ${isCurrent ? 'background-color: #0d3b4a;' : ''}
                `;
                item.onmouseenter = () => {
                    item.style.backgroundColor = '#333';
                    this.startPreview(filename);
                };
                item.onmouseleave = () => {
                    item.style.backgroundColor = isCurrent ? '#0d3b4a' : 'transparent';
                    this.stopPreview();
                };
                item.onclick = (e) => {
                    e.stopPropagation();
                    this.selectFile(filename);
                };
                fileList.appendChild(item);
            });
        };

        // Initial render
        renderFileList();
        dropdown.appendChild(fileList);

        // === SEARCH FILTER LOGIC ===
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value;
            this.searchQuery = query;
            filteredFiles = this.filterFiles(files, query);
            renderFileList();
        });

        // Allow Enter key to select first result
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredFiles.length > 0) {
                    this.selectFile(filteredFiles[0]);
                }
            } else if (e.key === 'Escape') {
                this.closeDropdown();
            }
        });

        // Position the dropdown below the file selector area on screen
        const screenBounds = this._getSelectorScreenBounds();
        dropdown.style.left = screenBounds.x + 'px';
        dropdown.style.top = screenBounds.y + 'px';
        dropdown.style.width = Math.max(screenBounds.width, 200) + 'px';

        document.body.appendChild(dropdown);

        this.dropdownElement = dropdown;
        this.dropdownOpen = true;
        this._closeDropdownHandler = (e) => {
            if (!this.dropdownElement || !this.dropdownOpen) return;
            if (this.dropdownElement.contains(e.target)) return;
            this.closeDropdown();
        };
        setTimeout(() => document.addEventListener('pointerdown', this._closeDropdownHandler, true), 0);

        // Focus search input after a short delay to ensure DOM is ready
        setTimeout(() => {
            searchInput.focus();
            placeCaretAtEnd();
        }, 10);
    }

    /**
     * Get the file selector area's screen bounds for dropdown positioning
     * (same canvas-space -> screen-space conversion as Power Load Video)
     */
    _getSelectorScreenBounds() {
        const canvas = app.canvas;
        const node = this.node;

        // File-name pill x/width (same layout as draw())
        const margin = 12;
        const arrowW = 20;
        const bounds = this.hitAreas.fileSelector.bounds;
        const selectorX = bounds[0] || (margin + arrowW + 2);
        const selectorWidth = bounds[2] || 200;

        // Get canvas transform (pan + zoom)
        const canvasEl = canvas.canvas;
        const rect = canvasEl.getBoundingClientRect();
        const ds = canvas.ds;

        // Convert node-local coordinates to screen coordinates
        const scale = ds?.scale || 1;
        const offsetX = ds?.offset?.[0] || 0;
        const offsetY = ds?.offset?.[1] || 0;

        const screenX = rect.left + (node.pos[0] + selectorX + offsetX) * scale;
        const screenY = rect.top + (node.pos[1] + (this.last_y || 0) + offsetY) * scale + scale;
        const screenW = selectorWidth * scale;

        return { x: screenX, y: screenY, width: Math.max(screenW, 200) };
    }

    closeDropdown() {
        this.stopPreview();
        if (this.dropdownElement) {
            this.dropdownElement.remove();
            this.dropdownElement = null;
        }
        if (this._closeDropdownHandler) {
            document.removeEventListener('pointerdown', this._closeDropdownHandler, true);
            this._closeDropdownHandler = null;
        }
        this.dropdownOpen = false;
    }

    async uploadFile(file) {
        const formData = new FormData();
        formData.append('image', file);
        formData.append('type', 'input');
        try {
            const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });
            if (resp.ok || resp.status === 200) {
                const data = await resp.json();
                return data.name || data.filename || file.name;
            }
        } catch (err) {
            console.error('[PowerLoadAudio] Upload error:', err);
        }
        return null;
    }

    /**
     * Export the current [ ] selection as "<name>_crop.mp3" (server-side
     * ffmpeg trim + baked pitch-preserving speed), then select the new file
     * so the whole node reloads around it - with speed reset to 1.0 since
     * the exported file already plays at that rate.
     */
    async cropToSelection() {
        const node = this.node;
        const filename = this.currentFilename;
        if (!filename || this.cropInProgress) return;
        const range = node.getSourceRange?.() || [0, 0];
        const speed = node.getSpeed?.() || 1.0;
        if (range[1] - range[0] <= 0.01) return;
        this.cropInProgress = true;
        node.setDirtyCanvas?.(true, true);
        try {
            const resp = await api.fetchApi('/sa_audio/crop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, start_time: range[0], end_time: range[1], speed }),
            });
            if (resp.ok || resp.status === 200) {
                const data = await resp.json();
                const name = data.name;
                if (name) {
                    // make the new file known to the combo (dropdown /
                    // prev-next) without a full UI refresh
                    const combo = this.getComboWidget();
                    if (combo?.options?.values && !combo.options.values.includes(name)) {
                        combo.options.values.push(name);
                    }
                    this.selectFile(name);
                    // the cropped file is already at source speed - reset
                    node.setSpeed?.(1.0);
                }
            } else {
                const text = await resp.text().catch(() => '');
                console.error('[PowerLoadAudio] Crop failed:', resp.status, text);
            }
        } catch (err) {
            console.error('[PowerLoadAudio] Crop error:', err);
        }
        this.cropInProgress = false;
        this.cropMouseDown = false;
        node.setDirtyCanvas?.(true, true);
    }

    draw(ctx, node, w, posY, height) {
        const margin = 12;
        const spacing = 8;
        const midY = posY + height * 0.5;

        ctx.save();

        const arrowW = 20;
        const uploadW = 62;
        const cropW = 62;

        // Hover-preview checkbox (leftmost, unlabeled)
        const checkSize = Math.min(15, Math.max(11, height * 0.68));
        const checkX = margin;
        const checkY = posY + (height - checkSize) * 0.5;
        const leftX = margin + checkSize + spacing; // where the ◀ arrow starts

        // Output length readout (right-aligned at the far right)
        ctx.font = `${Math.max(13, height * 0.6)}px Sans-Serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const lenText = `→ ${this.lengthValue}`;
        const lenW = ctx.measureText(lenText).width;
        // Reserve room for up to 4-digit frames and 4-digit seconds so the
        // row layout doesn't jump as the readout grows/shrinks.
        const lenSlotW = Math.max(lenW, ctx.measureText('→ 9999f · 99.99s').width);

        // Right-to-left: readout | Crop | Upload
        const uploadX = node.size[0] - margin - lenSlotW - spacing * 2 - cropW - spacing - uploadW;
        const cropX = uploadX + uploadW + spacing;
        const nameX = leftX + arrowW + 2;
        const nameW = Math.max(60, uploadX - spacing - arrowW - nameX);

        // checkbox box + check mark (no text)
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(checkX, checkY, checkSize, checkSize, 3);
        ctx.fill();
        ctx.stroke();
        if (this.previewOn) {
            ctx.strokeStyle = '#2cc6ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(checkX + checkSize * 0.22, checkY + checkSize * 0.52);
            ctx.lineTo(checkX + checkSize * 0.44, checkY + checkSize * 0.74);
            ctx.lineTo(checkX + checkSize * 0.80, checkY + checkSize * 0.28);
            ctx.stroke();
        }
        this.hitAreas.previewToggle.bounds = [checkX, posY, checkSize, height];
        if (!this.hitAreas.previewToggle.onDown) {
            this.hitAreas.previewToggle.onDown = () => this.togglePreview();
        }

        // prev / next arrows
        ctx.textAlign = 'center';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText('◀', leftX + arrowW / 2, midY);
        ctx.fillText('▶', uploadX - spacing - arrowW / 2, midY);
        this.hitAreas.prevButton.bounds = [leftX, posY, arrowW, height];
        this.hitAreas.nextButton.bounds = [uploadX - spacing - arrowW, posY, arrowW, height];
        if (!this.hitAreas.prevButton.onDown) this.hitAreas.prevButton.onDown = () => this.selectPrevFile();
        if (!this.hitAreas.nextButton.onDown) this.hitAreas.nextButton.onDown = () => this.selectNextFile();

        // file name pill (click = dropdown)
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(nameX, posY, nameW, height, [height * 0.5]);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = this.currentFilename ? LiteGraph.WIDGET_TEXT_COLOR : '#888';
        ctx.textAlign = 'left';
        ctx.fillText(fitString(ctx, this.currentFilename || 'no audio selected', nameW - 16), nameX + 8, midY);
        this.hitAreas.fileSelector.bounds = [nameX, posY, nameW, height];
        if (!this.hitAreas.fileSelector.onDown) {
            this.hitAreas.fileSelector.onDown = () => {
                if (this.dropdownOpen) this.closeDropdown();
                else this.openDropdown();
            };
        }

        // upload button (icon-less, shifted left by the Crop button) - no
        // pressed tint: the file dialog swallows the pointerup, which would
        // leave the button stuck highlighted
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(uploadX, posY, uploadW, height, [height * 0.5]);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textAlign = 'center';
        ctx.fillText('Upload', uploadX + uploadW / 2, midY);
        this.hitAreas.uploadButton.bounds = [uploadX, posY, uploadW, height];
        if (!this.hitAreas.uploadButton.onDown) {
            this.hitAreas.uploadButton.onDown = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'audio/*,video/mp4,video/webm';
                input.style.display = 'none';
                input.addEventListener('change', async () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    const name = await this.uploadFile(file);
                    if (name) {
                        // make the new file known to the combo (dropdown /
                        // prev-next) without a full UI refresh
                        const combo = this.getComboWidget();
                        if (combo?.options?.values && !combo.options.values.includes(name)) {
                            combo.options.values.push(name);
                            combo.options.values.sort();
                        }
                        this.selectFile(name);
                    }
                });
                document.body.appendChild(input);
                input.click();
                setTimeout(() => input.remove(), 60000);
            };
        }

        // crop button - exports the [ ] selection as <name>_crop.mp3 and
        // selects it (fires on press; disabled look while running)
        ctx.fillStyle = this.cropInProgress ? '#1a4a6a'
            : (this.cropMouseDown ? '#4a2a1a' : LiteGraph.WIDGET_BGCOLOR);
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.beginPath();
        ctx.roundRect(cropX, posY, cropW, height, [height * 0.5]);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.textAlign = 'center';
        ctx.fillText(this.cropInProgress ? 'Cropping…' : 'Crop', cropX + cropW / 2, midY);
        this.hitAreas.cropButton.bounds = [cropX, posY, cropW, height];
        if (!this.hitAreas.cropButton.onDown) {
            this.hitAreas.cropButton.onDown = () => {
                if (this.cropInProgress) return;
                this.cropMouseDown = true;
                this.cropToSelection();
            };
        }
        if (!this.hitAreas.cropButton.onUp) {
            this.hitAreas.cropButton.onUp = () => {
                this.cropMouseDown = false;
                node.setDirtyCanvas(true, false);
            };
        }

        // output length readout (crop + speed applied)
        ctx.fillStyle = '#2cc6ff';
        ctx.textAlign = 'left';
        ctx.fillText(lenText, cropX + cropW + spacing, midY);

        ctx.restore();
    }

    onRemove() {
        this.closeDropdown();
        this._previewBuffers.clear();
        if (this._previewCtx) {
            try { this._previewCtx.close(); } catch (e) { /* noop */ }
            this._previewCtx = null;
        }
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
