/**
 * Power Load Audio - audio loading node with waveform / dB / beats preview,
 * scrubbable timeline, frame crop markers and speed control.
 *
 * Entry point for the power_load_audio package.
 */
import { app } from '../../../scripts/app.js';
import { createAudioNodeCreatedWrapper } from './audio_node_setup.js';

function sanitizeFloat(v, fallback) {
    const n = parseFloat(v);
    return (!isNaN(n) && isFinite(n)) ? n : fallback;
}

app.registerExtension({
    name: 'PowerLoadAudio',

    async beforeRegisterNodeDef(nodeType, nodeData) {
        // Add SA-Nodes category alias for discovery (same as PowerLoadVideo)
        if (nodeData?.category && nodeData.category.startsWith('Power/')) {
            const subcategory = nodeData.category.split('/')[1];
            if (subcategory) {
                if (!nodeType.category) {
                    nodeType.category = 'SA-Nodes/' + subcategory;
                } else {
                    nodeType.categories = ['SA-Nodes/' + subcategory, nodeData.category];
                }
            }
        }

        if (nodeData?.name !== 'PowerLoadAudio') return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = createAudioNodeCreatedWrapper(originalOnNodeCreated);

        // Restore UI state from saved workflow
        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (originalOnConfigure) {
                originalOnConfigure.apply(this, arguments);
            }

            const widgets = this.widgets || [];

            // Sanitize + restore speed / fps from hidden widgets
            const speedWidget = widgets.find(w => w.name === 'speed');
            if (speedWidget) speedWidget.value = Math.min(4, Math.max(0.25, sanitizeFloat(speedWidget.value, 1.0)));
            const fpsWidget = widgets.find(w => w.name === 'fps');
            if (fpsWidget) fpsWidget.value = Math.min(120, Math.max(1, sanitizeFloat(fpsWidget.value, 24.0)));
            this.syncTopRowFromWidgets?.();

            // Restore crop markers from hidden widgets
            if (this.timelineWidget) {
                const startWidget = widgets.find(w => w.name === 'start_frame');
                const endWidget = widgets.find(w => w.name === 'end_frame');
                if (startWidget && typeof startWidget.value === 'number' && startWidget.value > 1) {
                    this.timelineWidget.startFrameMarker = Math.max(1, Math.floor(startWidget.value));
                }
                if (endWidget && typeof endWidget.value === 'number' && endWidget.value > 1) {
                    this.timelineWidget.endFrameMarker = Math.max(1, Math.floor(endWidget.value));
                }
            }

            // Reload the audio from the saved combo value
            const filename = this.widgets_values?.[0];
            if (filename && typeof this.loadAudioIntoDisplay === 'function') {
                // markers must be restored BEFORE the load so they survive
                // (loadAudioIntoDisplay only resets them when they are defaults)
                this.fileSelectorWidget?.setCurrentFilename(filename);
                setTimeout(() => this.loadAudioIntoDisplay(filename), 0);
            }
        };

        // Cleanup on node removal
        const originalOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.stopAudioPlayback?.();
            if (this.handlePlayPauseShortcut) {
                document.removeEventListener('keydown', this.handlePlayPauseShortcut, true);
                this.handlePlayPauseShortcut = null;
            }
            this.fileSelectorWidget?.onRemove?.();
            if (this._audioCtx) {
                try { this._audioCtx.close(); } catch (e) { /* noop */ }
                this._audioCtx = null;
            }
            if (originalOnRemoved) {
                originalOnRemoved.apply(this, arguments);
            }
        };
    },
});
