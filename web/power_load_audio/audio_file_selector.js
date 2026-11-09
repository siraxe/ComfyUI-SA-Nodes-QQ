/**
 * File Selector Widget for Power Load Audio
 * Row: [◀ name.mp3 ▶] [Upload]
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
        this.cropMouseDown = false;
        this.cropInProgress = false;
        this._closeDropdownHandler = null;

        this.hitAreas = {
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
            this.node.loadAudioIntoDisplay(filename);
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

    openDropdown() {
        this.closeDropdown();
        const files = this.getAvailableFiles();
        if (files.length === 0) return;

        const dropdown = document.createElement('div');
        dropdown.style.cssText = `
            position: fixed; z-index: 99999; max-height: 240px; overflow-y: auto;
            background: #1e1e1e; border: 1px solid #444; border-radius: 6px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.5); font-family: sans-serif; font-size: 12px;
        `;
        for (const file of files) {
            const item = document.createElement('div');
            item.textContent = file;
            item.style.cssText = 'padding: 5px 12px; cursor: pointer; color: #ddd; white-space: nowrap;';
            if (file === this.currentFilename) item.style.color = '#2cc6ff';
            item.addEventListener('mouseenter', () => { item.style.background = '#3a3a3a'; });
            item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectFile(file);
            });
            dropdown.appendChild(item);
        }
        document.body.appendChild(dropdown);

        // Position under the file selector (canvas-space -> screen-space)
        const canvasRect = app.canvas.canvas.getBoundingClientRect();
        const ds = app.canvas.ds || { scale: 1, offset: [0, 0] };
        const bounds = this.hitAreas.fileSelector.bounds;
        const lastY = this.last_y || 0;
        const x = canvasRect.left + (this.node.pos[0] + bounds[0]) * ds.scale + ds.offset[0];
        const y = canvasRect.top + (this.node.pos[1] + lastY + 22) * ds.scale + ds.offset[1];
        dropdown.style.left = `${x}px`;
        dropdown.style.top = `${y}px`;

        this.dropdownElement = dropdown;
        this._closeDropdownHandler = (e) => {
            if (!dropdown.contains(e.target)) this.closeDropdown();
        };
        setTimeout(() => document.addEventListener('pointerdown', this._closeDropdownHandler, true), 0);
    }

    closeDropdown() {
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

        // Output length readout (right-aligned at the far right)
        ctx.font = `${Math.max(13, height * 0.6)}px Sans-Serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const lenText = `→ ${this.lengthValue}`;
        const lenW = ctx.measureText(lenText).width;

        // Right-to-left: readout | Crop | Upload
        const uploadX = node.size[0] - margin - lenW - spacing * 2 - cropW - spacing - uploadW;
        const cropX = uploadX + uploadW + spacing;
        const nameX = margin + arrowW + 2;
        const nameW = Math.max(60, uploadX - spacing - arrowW - nameX);

        // prev / next arrows
        ctx.textAlign = 'center';
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.fillText('◀', margin + arrowW / 2, midY);
        ctx.fillText('▶', uploadX - spacing - arrowW / 2, midY);
        this.hitAreas.prevButton.bounds = [margin, posY, arrowW, height];
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
                    if (name) this.selectFile(name);
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
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
