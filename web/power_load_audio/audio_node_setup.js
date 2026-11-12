/**
 * Node Setup - onNodeCreated wrapper logic for PowerLoadAudio
 *
 * Builds the audio playback engine (WebAudio), computes waveform/dB/beat
 * analysis from the decoded AudioBuffer, wires the custom widgets to the
 * hidden backend widgets and handles audio file drop/upload.
 */
import { api } from '../../../scripts/api.js';
import { PowerAudioTimelineWidget, AUDIO_PEAK_BUCKETS } from './audio_timeline_widget.js';
import { PowerAudioFileSelectorWidget } from './audio_file_selector.js';

/**
 * Pitch-preserving speed is handled natively by AudioBufferSourceNode
 * playbackRate, so preview and export (ffmpeg atempo) stay in sync.
 */
export function createAudioNodeCreatedWrapper(originalOnNodeCreated) {
    return function () {
        if (originalOnNodeCreated) {
            originalOnNodeCreated.apply(this, arguments);
        }

        // Compact node: enforce a sane minimum width
        if (this.size[0] < 460) this.size[0] = 460;
        this.onResize = function (size) {
            if (size[0] < 460) size[0] = 460;
        };

        this.widgets = this.widgets || [];
        this.audioBuffer = null;      // decoded AudioBuffer (or null)
        this.audioDuration = 0;       // source duration in seconds
        this.peaks = null;            // Float32Array of max abs per bucket
        this.rmsBuckets = null;       // Float32Array of rms per bucket
        this.onsets = null;           // array of beat/onset times (seconds)
        this.onsetEvents = null;      // [{ t, band: 'low'|'mid'|'high', strength }]
        this.viewContrast = Math.min(3, Math.max(0, parseFloat(this.properties?.view_contrast) || 0));

        // addCustomWidget polyfill (same as PowerLoadVideo)
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

        // ================= AUDIO ENGINE =================

        this._ensureAudioCtx = () => {
            if (!this._audioCtx) {
                this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
            return this._audioCtx;
        };

        // Crop range in source seconds from the [ ] markers
        this.getSourceRange = () => {
            const fps = this.getFps();
            const tl = this.timelineWidget;
            const total = tl?.value?.totalFrames || 1;
            const startM = tl?.startFrameMarker || 1;
            const endM = (tl?.endFrameMarker !== null && tl?.endFrameMarker >= 1) ? tl.endFrameMarker : total;
            return [(startM - 1) / fps, endM / fps];
        };

        this.getFps = () => {
            const w = this.widgets.find(w => w.name === 'fps');
            const v = parseFloat(w?.value);
            return (!isNaN(v) && v > 0) ? v : 24.0;
        };

        this.getSpeed = () => {
            const w = this.widgets.find(w => w.name === 'speed');
            const v = parseFloat(w?.value);
            return (!isNaN(v) && v > 0) ? Math.min(4, Math.max(0.25, v)) : 1.0;
        };

        /**
         * Start (or restart) looping playback of the crop range at the
         * current speed. fromTime: optional source-seconds position.
         */
        this.startAudioPlayback = (fromTime) => {
            if (!this.audioBuffer) return;
            const ctx = this._ensureAudioCtx();
            this.stopAudioPlayback();
            const [s, e] = this.getSourceRange();
            if (e - s <= 0.01) return;
            const token = (this._playToken = (this._playToken || 0) + 1);
            const begin = () => {
                // a newer start/stop superseded us while awaiting resume()
                if (token !== this._playToken || !this.audioBuffer) return;
                const src = ctx.createBufferSource();
                src.buffer = this.audioBuffer;
                src.playbackRate.value = this.getSpeed();
                src.loop = true;
                src.loopStart = s;
                src.loopEnd = e;
                src.connect(ctx.destination);
                const cur = this.currentSourcePosition();
                const offset = Math.min(Math.max(fromTime ?? cur, s), e - 0.001);
                src.start(0, offset);
                this._audioSrc = src;
                this._playStartCtx = ctx.currentTime;
                this._playStartSrc = offset;
            };
            // Autoplay policy: the context may still be suspended on the
            // first press - wait for resume() so playback isn't silent.
            if (ctx.state === 'suspended') {
                ctx.resume().then(begin, begin);
            } else {
                begin();
            }
        };

        this.stopAudioPlayback = () => {
            if (this._audioSrc) {
                try { this._audioSrc.stop(); } catch (e) { /* already stopped */ }
                try { this._audioSrc.disconnect(); } catch (e) { /* noop */ }
                this._audioSrc = null;
            }
            this._playStartCtx = null;
            this._playStartSrc = null;
        };

        /**
         * Current playback position in SOURCE seconds (wrapped into the loop
         * range while playing, marker/currentFrame position while paused).
         */
        this.currentSourcePosition = () => {
            if (this._audioSrc && this._playStartCtx !== null && this._audioCtx) {
                const speed = this.getSpeed();
                let t = this._playStartSrc + (this._audioCtx.currentTime - this._playStartCtx) * speed;
                const [s, e] = this.getSourceRange();
                const span = e - s;
                if (span > 0.01) t = s + (((t - s) % span) + span) % span;
                return t;
            }
            return ((this.timelineWidget?.value?.currentFrame || 1) - 1) / this.getFps();
        };

        /**
         * Seek (also restarts playback at the new position when playing).
         */
        this.seekSourceTime = (t) => {
            const fps = this.getFps();
            const total = this.timelineWidget?.value?.totalFrames || 1;
            const frame = Math.max(1, Math.min(total, Math.round(t * fps) + 1));
            if (this.timelineWidget) this.timelineWidget.value.currentFrame = frame;
            if (this.timelineWidget?.value?.isPlaying) {
                this.startAudioPlayback(t);
            }
            this.setDirtyCanvas(true, true);
        };

        // fps / speed setters called by the stats row (sync hidden widgets)
        this.setFps = (fps) => {
            const w = this.widgets.find(w => w.name === 'fps');
            if (w) w.value = fps;
            const tl = this.timelineWidget;
            if (tl) {
                const prevFps = tl.value.fps || fps;
                const duration = this.audioDuration || (tl.value.totalFrames || 1) / prevFps;
                // Preserve crop/playhead positions in SECONDS so changing fps
                // only relabels the timeline: the [ ] markers (and playhead)
                // stay visually in place while their frame numbers change.
                const totalOld = tl.value.totalFrames || 1;
                const endOld = (tl.endFrameMarker !== null && tl.endFrameMarker >= 1) ? tl.endFrameMarker : totalOld;
                const startT = (tl.startFrameMarker - 1) / prevFps;
                const endT = endOld / prevFps;
                const curT = (tl.value.currentFrame - 1) / prevFps;
                tl.value.fps = fps;
                const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-4));
                tl.setTotalFrames(this, totalFrames);
                tl.setStartFrame(Math.max(1, Math.min(totalFrames, Math.round(startT * fps) + 1)), this);
                tl.setEndFrame(Math.max(1, Math.min(totalFrames, Math.round(endT * fps))), this);
                tl.value.currentFrame = Math.max(1, Math.min(totalFrames, Math.round(curT * fps) + 1));
            }
            this.updateLengthDisplay();
            this.setDirtyCanvas(true, true);
        };

        this.setSpeed = (speed) => {
            const w = this.widgets.find(w => w.name === 'speed');
            if (w) w.value = speed;
            // Restart playback at the current position with the new rate so
            // the preview audibly matches the export
            if (this.timelineWidget?.value?.isPlaying) {
                this.startAudioPlayback(this.currentSourcePosition());
            }
            this.updateLengthDisplay();
            this.setDirtyCanvas(true, true);
        };

        /**
         * Update the OUTPUT length readout (crop + speed applied) shown in
         * the file-selector row.
         */
        this.updateLengthDisplay = () => {
            if (!this.fileSelectorWidget) return;
            const fps = this.getFps();
            const speed = this.getSpeed();
            const tl = this.timelineWidget;
            const total = tl?.value?.totalFrames || 1;
            const [s, e] = this.getSourceRange();
            const outDur = (e - s) / speed;
            const outFrames = Math.max(0, Math.ceil(outDur * fps - 1e-4));
            this.fileSelectorWidget.lengthValue = `${outFrames}f · ${outDur.toFixed(2)}s`;
        };

        // ================= ANALYSIS =================

        /**
         * Pre-compute per-bucket max amplitude and RMS from the decoded
         * AudioBuffer, plus beat/onset times (energy flux peak picking).
         * All values are in SOURCE time; drawing scales them by speed/fps.
         */
        this.computeAudioAnalysis = (buffer) => {
            const ch = buffer.getChannelData(0);
            const n = ch.length;
            const bucketSize = Math.max(1, Math.ceil(n / AUDIO_PEAK_BUCKETS));
            const buckets = Math.ceil(n / bucketSize);
            const peaks = new Float32Array(buckets);
            const rms = new Float32Array(buckets);
            for (let b = 0; b < buckets; b++) {
                const lo = b * bucketSize;
                const hi = Math.min(n, lo + bucketSize);
                let sum = 0, max = 0;
                for (let i = lo; i < hi; i++) {
                    const v = Math.abs(ch[i]);
                    if (v > max) max = v;
                    sum += ch[i] * ch[i];
                }
                peaks[b] = max;
                rms[b] = Math.sqrt(sum / Math.max(1, hi - lo));
            }
            this.peaks = peaks;
            this.rmsBuckets = rms;

            // Onset/beat detection: full-band log-energy positive flux with
            // adaptive peak picking. Every onset is then classified into
            // LOW / MID / HIGH by which band's normalized energy rises most
            // (one-pole splits at 150 Hz / 2 kHz), so the BEATS view gets
            // separate "beat types" instead of one solid wall of ticks.
            const sr = buffer.sampleRate;
            const hop = 1024;
            const frames = Math.floor(n / hop);
            const aLow = 1 - Math.exp(-2 * Math.PI * 150 / sr);
            const aHigh = 1 - Math.exp(-2 * Math.PI * 2000 / sr);
            const eAll = new Float32Array(frames);
            const eLow = new Float32Array(frames);
            const eMid = new Float32Array(frames);
            const eHigh = new Float32Array(frames);
            let lpLow = 0, lpHigh = 0;
            let accAll = 0, accL = 0, accM = 0, accH = 0, hopCount = 0, bucket = 0;
            for (let i = 0; i < frames * hop; i++) {
                const x = ch[i];
                lpLow += aLow * (x - lpLow);
                lpHigh += aHigh * (x - lpHigh);
                const low = lpLow;
                const mid = lpHigh - lpLow;
                const high = x - lpHigh;
                accAll += x * x;
                accL += low * low;
                accM += mid * mid;
                accH += high * high;
                if (++hopCount === hop) {
                    eAll[bucket] = Math.sqrt(accAll / hop);
                    eLow[bucket] = Math.sqrt(accL / hop);
                    eMid[bucket] = Math.sqrt(accM / hop);
                    eHigh[bucket] = Math.sqrt(accH / hop);
                    bucket++;
                    accAll = accL = accM = accH = 0;
                    hopCount = 0;
                }
            }

            // Average per-band level - used to normalize the classification
            // so the natural spectral tilt doesn't bias every hit to LOW.
            const bandMean = (a) => {
                let s = 0;
                for (let i = 0; i < a.length; i++) s += a[i];
                return a.length > 0 ? s / a.length : 0;
            };
            const mL = bandMean(eLow), mM = bandMean(eMid), mH = bandMean(eHigh);

            // Onset detection on the full-band energy (reliable peak picking)
            const flux = new Float32Array(frames);
            for (let f = 1; f < frames; f++) {
                flux[f] = Math.max(0, Math.log(eAll[f] + 1e-7) - Math.log(eAll[f - 1] + 1e-7));
            }
            // prefix sums for the local mean threshold
            const prefix = new Float32Array(frames + 1);
            for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + flux[f];
            const globalMean = frames > 0 ? prefix[frames] / frames : 0;

            // Classify by the band with the biggest short-window energy rise
            const WIN = 2; // ~46 ms at 1024 hop / 44.1 kHz
            const classifyBand = (f) => {
                let bl = 0, bm = 0, bh = 0, al = 0, am = 0, ah = 0;
                for (let k = 1; k <= WIN; k++) {
                    if (f + k < frames) { al += eLow[f + k]; am += eMid[f + k]; ah += eHigh[f + k]; }
                    if (f - k >= 0) { bl += eLow[f - k]; bm += eMid[f - k]; bh += eHigh[f - k]; }
                }
                const dl = Math.max(0, al - bl) / (mL + 1e-9);
                const dm = Math.max(0, am - bm) / (mM + 1e-9);
                const dh = Math.max(0, ah - bh) / (mH + 1e-9);
                if (dh >= dl && dh >= dm) return { band: 'high', level: dh };
                if (dm >= dl) return { band: 'mid', level: dm };
                return { band: 'low', level: dl };
            };

            // Thresholds are deliberately a bit permissive: the BEATS view's
            // "View" contrast control then filters these candidates by
            // strength, so 0 shows everything and higher values thin them out.
            const W = 20;
            const events = [];
            let last = -Infinity;
            for (let f = 2; f < frames - 1; f++) {
                const lo = Math.max(0, f - W);
                const hi = Math.min(frames, f + W + 1);
                const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
                const thr = Math.max(mean * 1.2, globalMean * 0.45) + 1e-4;
                if (flux[f] >= thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) {
                    const t = (f * hop + hop / 2) / sr;
                    if (t - last >= 0.1) {
                        const { band, level } = classifyBand(f);
                        // Ignore noise-level rises on steady tones (e.g. a
                        // sustained bass wiggling the flux): the winning
                        // band must gain a meaningful share of its average.
                        if (level < 0.05) continue;
                        events.push({ t, band, strength: level });
                        last = t;
                    }
                }
            }
            // Normalize strength per band (0..1) for tick heights
            const maxByBand = { low: 0, mid: 0, high: 0 };
            for (const e of events) {
                if (e.strength > maxByBand[e.band]) maxByBand[e.band] = e.strength;
            }
            for (const e of events) {
                const m = maxByBand[e.band];
                e.strength = m > 0 ? Math.min(1, e.strength / m) : 0.5;
            }
            events.sort((a, b) => a.t - b.t);
            this.onsetEvents = events;
            this.onsets = events.map(e => e.t);
        };

        // ================= WIDGETS =================

        if (!this.fileSelectorWidget) {
            this.fileSelectorWidget = new PowerAudioFileSelectorWidget(this);
            this.addCustomWidget(this.fileSelectorWidget);
        }
        if (!this.timelineWidget) {
            this.timelineWidget = new PowerAudioTimelineWidget();
            this.addCustomWidget(this.timelineWidget);
        }

        // Hide the native widgets (combo + numbers) - they stay in this.widgets
        // so their values get serialized to the backend on execute
        setTimeout(() => {
            const combo = this.widgets.find(w => w.type === 'combo');
            if (combo) {
                combo.computeSize = () => [0, 0];
                combo.hidden = true;
            }
            for (const name of ['start_frame', 'end_frame', 'speed', 'fps']) {
                const w = this.widgets.find(w => w.name === name);
                if (w) {
                    w.computeSize = () => [0, 0];
                    w.hidden = true;
                    if ((name === 'speed' || name === 'fps') && (typeof w.value !== 'number' || isNaN(w.value))) {
                        w.value = name === 'speed' ? 1.0 : 24.0;
                    }
                }
            }
        }, 0);

        // Sync the visible controls from hidden widget values (used on
        // configure + init) - fps/speed spinners now live in the timeline
        // widget's stats row and read via getFps()/getSpeed()
        this.syncTopRowFromWidgets = () => {
            if (this.timelineWidget) this.timelineWidget.value.fps = this.getFps();
            this.updateLengthDisplay();
        };

        // ================= LOAD =================

        /**
         * Fetch + decode the audio file, compute analysis and reset the
         * timeline. Called on upload/drop/configure.
         * resetCrop: user picked a new file -> [ ] markers return to full
         * range. Configure restores them instead (no reset).
         */
        this.loadAudioIntoDisplay = (filename, resetCrop = false) => {
            if (!filename) return;
            // skip only when already loading (undefined) or loaded (buffer);
            // a FAILED decode (null) may be retried (e.g. pressing play)
            if (this._audioLoadToken !== undefined && this._audioLoadName === filename && this.audioBuffer !== null) return;
            this._audioLoadName = filename;
            const shouldResetCrop = !!resetCrop;
            const token = (this._audioLoadToken = (this._audioLoadToken || 0) + 1);

            this.stopAudioPlayback();
            if (this.timelineWidget) {
                this.timelineWidget.value.isPlaying = false;
                this.timelineWidget.stopPlayback();
            }
            // Mark as loading (lane shows "Decoding audio...")
            this.audioBuffer = undefined;
            this.peaks = null;
            this.rmsBuckets = null;
            this.onsets = null;
            this.onsetEvents = null;
            this.audioDuration = 0;
            this.setDirtyCanvas(true, true);

            const url = `/view?filename=${encodeURIComponent(filename)}&type=input`;
            fetch(url)
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.arrayBuffer();
                })
                .then(data => {
                    if (token !== this._audioLoadToken) return; // superseded
                    const ctx = this._ensureAudioCtx();
                    return ctx.decodeAudioData(data);
                })
                .then(buffer => {
                    if (token !== this._audioLoadToken) return;
                    if (!buffer) throw new Error('decode failed');
                    this.audioBuffer = buffer;
                    this.audioDuration = buffer.duration;
                    this.computeAudioAnalysis(buffer);

                    const fps = this.getFps();
                    const totalFrames = Math.max(1, Math.ceil(buffer.duration * fps - 1e-4));
                    const tl = this.timelineWidget;
                    if (tl) {
                        tl.value.currentFrame = 1;
                        const hadDefaults = (tl.startFrameMarker === 1) &&
                            ((tl.endFrameMarker === 1) || (tl.endFrameMarker !== null && tl.endFrameMarker >= tl.value.totalFrames));
                        tl.setTotalFrames(this, totalFrames);
                        // new file -> always back to the full [ ] range
                        if (shouldResetCrop || hadDefaults || tl.endFrameMarker === 1) {
                            tl.setStartFrame(1, this);
                            tl.setEndFrame(totalFrames, this);
                        }
                    }
                    this.updateLengthDisplay();
                    this.setDirtyCanvas(true, true);
                })
                .catch(err => {
                    if (token !== this._audioLoadToken) return;
                    console.warn('[PowerLoadAudio] Could not decode audio:', filename, err);
                    this.audioBuffer = null; // null = decode failed (show hint text)
                    this.setDirtyCanvas(true, true);
                });
        };

        // ================= DROP / KEYBOARD =================

        // Allow dropping audio files directly onto the node
        this.onDragOver = (e) => {
            return true;
        };
        this.onDragDrop = async (e) => {
            const file = e?.dataTransfer?.files?.[0] || e?.data?.files?.[0];
            if (!file) return false;
            if (!(file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|opus|wma|mp4|webm)$/i.test(file.name))) {
                return false;
            }
            const formData = new FormData();
            formData.append('image', file);
            formData.append('type', 'input');
            try {
                const resp = await api.fetchApi('/upload/image', { method: 'POST', body: formData });
                if (resp.ok || resp.status === 200) {
                    const data = await resp.json();
                    const name = data.name || data.filename || file.name;
                    this.fileSelectorWidget?.setCurrentFilename(name);
                    const combo = this.widgets.find(w => w.type === 'combo');
                    if (combo) {
                        // make the new file known to the combo (dropdown /
                        // prev-next) without a full UI refresh
                        if (combo.options?.values && !combo.options.values.includes(name)) {
                            combo.options.values.push(name);
                            combo.options.values.sort();
                        }
                        combo.value = name;
                    }
                    if (!this.widgets_values || this.widgets_values.length === 0) {
                        this.widgets_values = [name];
                    } else {
                        this.widgets_values[0] = name;
                    }
                    this.loadAudioIntoDisplay(name, true);
                    return true;
                }
            } catch (err) {
                console.error('[PowerLoadAudio] Drop upload error:', err);
            }
            return false;
        };

        // Shift+Space toggles playback for the selected node
        this.handlePlayPauseShortcut = (e) => {
            if ((e.key === ' ' || e.code === 'Space') && e.shiftKey) {
                if (!e.target.matches('input, textarea') && this.selected) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.timelineWidget?.togglePlay(this);
                }
            }
        };
        document.addEventListener('keydown', this.handlePlayPauseShortcut, true);

        // Forward mouse events in the visually-stretched lane region to the
        // timeline widget. The widget's computeSize is FIXED (otherwise the
        // node auto-layout would grow forever), so the normal per-widget hit
        // routing only covers the compact band; anything below it (the extra
        // lane height gained by enlarging the node) is forwarded here.
        // pos stays NODE-relative - hit-area bounds are node-relative too.
        // Returns true to claim the event, otherwise LiteGraph starts
        // dragging the whole node when the user scrubs the timeline.
        // The bottom-right resize grip is excluded so node scaling keeps
        // working from inside the timeline area.
        this._forwardToTimeline = (event, pos, node) => {
            const tl = this.timelineWidget;
            if (!tl || typeof tl.mouse !== 'function') return false;
            const bandBottom = (tl.last_y || 0) + tl.computeSize(this.size[0])[1];
            if (pos[1] < bandBottom) return false; // normal routing handles it
            // Resize grip corner (bottom-right) must stay unclaimed
            const grip = 24;
            if (pos[0] > this.size[0] - grip && pos[1] > this.size[1] - grip) return false;
            tl.mouse(event, pos, this);
            return true;
        };
        this.onMouseDown = this._forwardToTimeline;
        this.onMouseMove = this._forwardToTimeline;
        this.onMouseUp = this._forwardToTimeline;

        // Initial sync of fps/speed UI from widget defaults
        this.syncTopRowFromWidgets();
    };
}
