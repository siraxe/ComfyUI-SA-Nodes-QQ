/**
 * Power Load Video - DOM-based video display with custom timeline
 *
 * Creates a video display using addDOMWidget (like Power Spline Editor)
 * with an integrated scrubbable timeline below the video.
 *
 * Entry point for the modular power_load_video package.
 */

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import { uploadVideoFile, createPowerLoadVideoNodeAt } from './upload_handler.js';
import { createOnNodeCreatedWrapper } from './node_setup.js';

app.registerExtension({
    name: 'PowerLoadVideo',

    settings: [
        {
            id: 'SA-Nodes.overwriteDragAndDrop',
            name: 'Overwrite drag and drop',
            category: ['SA-Nodes', 'Power Load Video', 'Overwrite drag and drop'],
            tooltip: 'When enabled, dragging video files onto the canvas creates Power Load Video nodes instead of default Load Video nodes. Also enables image drag-and-drop to create LoadImage nodes.',
            type: 'boolean',
            defaultValue: false,
        },
    ],

    commands: [
        {
            id: 'SA-Nodes.ToggleOverwriteDragAndDrop',
            label: 'Toggle overwrite drag and drop',
            active: () => app.ui.settings.getSettingValue('SA-Nodes.overwriteDragAndDrop'),
            function: () => {
                const cur = app.ui.settings.getSettingValue('SA-Nodes.overwriteDragAndDrop');
                app.ui.settings.setSettingValue('SA-Nodes.overwriteDragAndDrop', !cur);
            },
        },
    ],

    /**
     * Intercept canvas-level drag-and-drop to create Power Load Video nodes
     * instead of default Load Video nodes
     */
    async setup() {
        // Check if overwrite drag and drop is enabled
        const overwriteDragAndDrop = app.ui.settings.getSettingValue('SA-Nodes.overwriteDragAndDrop');
        if (!overwriteDragAndDrop) {
            return;
        }
        // Get the canvas element - try multiple approaches
        let canvas = null;

        // Method 1: Try to find litegraph canvas directly
        const liteGraphCanvas = document.querySelector('canvas.litegraph');
        if (liteGraphCanvas) {
            canvas = liteGraphCanvas;
        }

        // Method 2: Try to find any canvas with id containing 'graph'
        if (!canvas) {
            const graphCanvas = document.querySelector('canvas[id*="graph"]');
            if (graphCanvas) {
                canvas = graphCanvas;
            }
        }

        // Method 3: Try to find the first canvas element
        if (!canvas) {
            canvas = document.querySelector('canvas');
            if (canvas) {
            }
        }

        if (!canvas) {
            console.warn('[PowerLoadVideo] Canvas not found yet, will retry on node creation');
            return;
        }


        // Track if we're handling a drop to prevent double-processing
        let isHandlingDrop = false;
        let droppedFile = null;

        const handleDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        /**
         * Decode UTF-8 bytes to string properly handling multi-byte characters
         */
        const decodeUtf8 = (bytes) => {
            // Use TextDecoder for proper UTF-8 decoding
            try {
                return new TextDecoder('utf-8').decode(bytes);
            } catch (e) {
                // Fallback to latin1 if text decoder fails
                let result = '';
                for (let i = 0; i < bytes.length; i++) {
                    result += String.fromCharCode(bytes[i]);
                }
                return result;
            }
        };

        /**
         * Extract embedded ComfyUI workflow from PNG metadata
         */
        const extractWorkflowFromPng = (arrayBuffer) => {
            try {
                const dataView = new DataView(arrayBuffer);

                // Verify PNG signature
                if (dataView.getUint32(0) !== 0x89504e47) return null;

                let offset = 8;

                while (offset < dataView.byteLength - 11) {
                    const chunkLength = dataView.getUint32(offset);
                    const chunkType = String.fromCharCode(
                        dataView.getUint8(offset + 4),
                        dataView.getUint8(offset + 5),
                        dataView.getUint8(offset + 6),
                        dataView.getUint8(offset + 7)
                    );

                    // Check for tEXt chunks (text metadata)
                    if (chunkType === 'tEXt' && chunkLength > 0) {
                        let keywordStart = offset + 8;
                        const keywordBytes = [];
                        while (keywordStart < offset + 8 + chunkLength && dataView.getUint8(keywordStart) !== 0) {
                            keywordBytes.push(dataView.getUint8(keywordStart));
                            keywordStart++;
                        }

                        // Decode keyword with proper UTF-8 handling
                        const keyword = decodeUtf8(new Uint8Array(keywordBytes));

                        // Check for workflow-related keywords (ComfyUI uses 'workflow')
                        if (keyword === 'workflow' || keyword === 'ExtraForUi') {
                            let textStart = keywordStart + 1; // skip null terminator
                            const textEnd = offset + 8 + chunkLength;
                            const textBytes = [];
                            while (textStart < textEnd) {
                                textBytes.push(dataView.getUint8(textStart));
                                textStart++;
                            }

                            // Decode text with proper UTF-8 handling
                            const text = decodeUtf8(new Uint8Array(textBytes));

                            try {
                                return JSON.parse(text);
                            } catch (e) {
                                // Failed to parse, continue searching
                            }
                        }
                    }

                    offset += 12 + chunkLength; // length(4) + type(4) + data + crc(4)
                }
            } catch (err) {
                // Silently fail - not a valid PNG or no workflow found
            }
            return null;
        };

        /**
         * Upload an image file to ComfyUI's input directory
         */
        const uploadImageFile = async (file) => {
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
                console.error('[PowerLoadVideo] Image upload error:', err);
            }
            return null;
        };

        /**
         * Create a LoadImage node at the given position and load an image into it
         */
        const createLoadImageNodeWithImage = async (filename, pos) => {
            // Check if LoadImage node type exists
            if (!LiteGraph.registered_node_types['LoadImage']) {
                console.error('[PowerLoadVideo] LoadImage node type not found!');
                return null;
            }

            const node = LiteGraph.createNode('LoadImage');
            if (!node) {
                console.error('[PowerLoadVideo] Failed to create LoadImage node!');
                return null;
            }

            // Set position centered at mouse
            node.pos = [pos[0] - 150, pos[1] - 100];

            // Add node to graph
            app.canvas.graph.add(node);

            // Wait for widgets to be created
            await new Promise(resolve => setTimeout(resolve, 50));

            // Find the image combo widget and set it to our uploaded filename
            const imageWidget = node.widgets.find(w => w.name === 'image');
            if (imageWidget) {
                imageWidget.value = filename;
                // Trigger value change to update the node display
                if (imageWidget.callback) {
                    imageWidget.callback(filename);
                }
            }

            // Select the new node
            app.canvas.selectNodes([node]);

            return node;
        };

        /**
         * Load an image file into a LoadImage node by updating its widget
         */
        const loadImageIntoNode = async (node, file) => {
            // Upload the image first
            const filename = await uploadImageFile(file);
            if (!filename) {
                console.error('[PowerLoadVideo] Failed to upload image!');
                return false;
            }

            // Find the image combo widget and set it to our uploaded filename
            const imageWidget = node.widgets.find(w => w.name === 'image');
            if (imageWidget) {
                imageWidget.value = filename;
                // Trigger value change to update the node display
                if (imageWidget.callback) {
                    imageWidget.callback(filename);
                }
                return true;
            }
            return false;
        };

        /**
         * Check if a file is an image type
         */
        const isImageFile = (file) => {
            return file.type.startsWith('image/') ||
                   file.name.toLowerCase().match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i);
        };

        /**
         * Check if a point is inside a node's bounding box
         */
        const isPointInNode = (pointX, pointY, node) => {
            // Node position and size in graph coordinates
            const nodeLeft = node.pos[0];
            const nodeTop = node.pos[1];
            const nodeRight = nodeLeft + node.size[0];
            const nodeBottom = nodeTop + node.size[1];

            return pointX >= nodeLeft && pointX <= nodeRight &&
                   pointY >= nodeTop && pointY <= nodeBottom;
        };

        /**
         * Check if the drop target is over a LoadImage node
         */
        const getLoadImageNodeAtPosition = (clientX, clientY) => {
            // Get canvas rect for coordinate conversion
            const rect = canvas.getBoundingClientRect();
            const mouseX = clientX - rect.left;
            const mouseY = clientY - rect.top;

            // Convert to graph coordinates
            const ds = app.canvas.ds || { scale: 1, offset: [0, 0] };
            const graphX = mouseX / ds.scale - ds.offset[0];
            const graphY = mouseY / ds.scale - ds.offset[1];

            // Find all LoadImage nodes and check if mouse is over any of them
            const loadImageNodes = app.canvas.graph.nodes.filter(
                node => node.type === 'LoadImage'
            );

            for (const node of loadImageNodes) {
                if (isPointInNode(graphX, graphY, node)) {
                    return node;
                }
            }
            return null;
        };

        const handleDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Prevent double-processing
            if (isHandlingDrop) return;

            const file = e.dataTransfer?.files[0];
            if (!file) return;

            // Check if it's a JSON workflow file first
            if (file.name.endsWith('.json') || file.type === 'application/json') {
                try {
                    const text = await file.text();
                    const workflow = JSON.parse(text);

                    // Load the workflow using ComfyUI's built-in function
                    if (app.loadGraphData) {
                        app.loadGraphData(workflow);
                    } else {
                        console.error('[PowerLoadVideo] app.loadGraphData not available!');
                    }
                } catch (err) {
                    console.error('[PowerLoadVideo] Failed to load JSON workflow:', err);
                }
                return;
            }

            // Check if dropping over a LoadImage node (for any image type)
            if (isImageFile(file)) {
                const loadImageNode = getLoadImageNodeAtPosition(e.clientX, e.clientY);
                if (loadImageNode) {
                    // Drop onto existing LoadImage node - load image into it
                    await loadImageIntoNode(loadImageNode, file);
                    return;
                }
            }

            // Check if it's a PNG image with embedded workflow
            if (file.type === 'image/png') {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const workflow = extractWorkflowFromPng(arrayBuffer);

                    if (workflow && app.loadGraphData) {
                        app.loadGraphData(workflow);
                        return;
                    }
                } catch (err) {
                    // Silently fail - not a PNG with embedded workflow
                }
            }

            // If it's an image file without embedded workflow, create LoadImage node
            if (isImageFile(file)) {
                isHandlingDrop = true;
                droppedFile = file;

                try {
                    // Upload the image file
                    const filename = await uploadImageFile(file);

                    if (filename) {
                        // Wait a moment for node types to be registered
                        await new Promise(resolve => setTimeout(resolve, 100));

                        // Calculate mouse position in graph coordinates
                        const ds = app.canvas.ds || { scale: 1, offset: [0, 0] };
                        const rect = canvas.getBoundingClientRect();
                        const mouseX = e.clientX - rect.left;
                        const mouseY = e.clientY - rect.top;
                        const graphX = mouseX / ds.scale - ds.offset[0];
                        const graphY = mouseY / ds.scale - ds.offset[1];

                        // Create LoadImage node at drop position
                        await createLoadImageNodeWithImage(filename, [graphX, graphY]);
                    } else {
                        console.error('[PowerLoadVideo] Image upload failed!');
                    }
                } finally {
                    isHandlingDrop = false;
                    droppedFile = null;
                }
                return;
            }

            // Check if it's a video file
            if (!file.type.startsWith('video/')) {
                return;
            }

            isHandlingDrop = true;
            droppedFile = file;

            try {
                // Upload the video file
                const filename = await uploadVideoFile(file);

                if (filename) {
                    // Check if the video has embedded workflow metadata (VHS/ComfyUI SaveVideo)
                    try {
                        const checkResp = await api.fetchApi('/power_load_video/check_workflow', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: filename, subfolder: '' })
                        });
                        if (checkResp.ok) {
                            const checkData = await checkResp.json();
                            if (checkData.has_workflow && checkData.workflow && app.loadGraphData) {
                                app.loadGraphData(checkData.workflow);
                                return;
                            }
                        }
                    } catch (err) {
                    }

                    // Wait a moment for node types to be registered
                    await new Promise(resolve => setTimeout(resolve, 100));

                    // Calculate mouse position in graph coordinates (accounts for pan/zoom)
                    const ds = app.canvas.ds || { scale: 1, offset: [0, 0] };
                    const rect = canvas.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;
                    // Convert to graph coordinates by accounting for zoom and pan
                    const graphX = mouseX / ds.scale - ds.offset[0];
                    const graphY = mouseY / ds.scale - ds.offset[1];

                    // Create Power Load Video node at drop position under mouse
                    const node = await createPowerLoadVideoNodeAt(filename, [graphX, graphY]);

                    if (node) {
                        // Focus/select the new node
                        app.canvas.selectNodes([node]);
                    }
                } else {
                    console.error('[PowerLoadVideo] Upload failed!');
                }
            } finally {
                isHandlingDrop = false;
                droppedFile = null;
            }
        };

        // Attach event listeners to canvas with capture phase to intercept before default handlers
        canvas.addEventListener('dragover', handleDragOver, { capture: true });
        canvas.addEventListener('drop', handleDrop, { capture: true });

    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        // Add SA-Nodes category to the node list for easy discovery
        if (nodeData?.category && nodeData.category.startsWith('Power/')) {
            // Extract the subcategory (e.g., 'Video' from 'Power/Video')
            const subcategory = nodeData.category.split('/')[1];
            if (subcategory) {
                // Add to SA-Nodes category as well for easy discovery
                if (!nodeType.category) {
                    nodeType.category = 'SA-Nodes/' + subcategory;
                } else {
                    nodeType.categories = ['SA-Nodes/' + subcategory, nodeData.category];
                }
            }
        }

        if (nodeData?.name === 'PowerLoadVideo') {
            // Note: We intentionally keep video_upload flag so ComfyUI serializes
            // the combo widget value for persistence across tab switches and workflow reloads.

            // Store original onNodeCreated FIRST before wrapping
            const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

            // Wrap onNodeCreated to add custom video display and timeline widget
            nodeType.prototype.onNodeCreated = createOnNodeCreatedWrapper(originalOnNodeCreated, nodeData);

            // Store original onExecuted and wrap it to update native FPS from output
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }

                if (message && message.outputs) {
                    // Get native FPS from output[2]
                    const nativeFPS = message.outputs[2];
                    if (nativeFPS) {
                        this.timelineWidget?.setNativeFPS(this, nativeFPS);
                        // Update top row default to match native FPS on first load
                        if (this.topRowWidget && this.topRowWidget.fpsValue === 24) {
                            this.topRowWidget.fpsValue = Math.round(nativeFPS);
                            this.timelineWidget.setFPS(this, Math.round(nativeFPS));
                        }
                    }
                }

                // Recalculate total frames with accurate native FPS + duration
                if (this.timelineWidget && this.videoElement && this.videoElement.duration && isFinite(this.videoElement.duration)) {
                    const accurateFrames = Math.ceil(this.videoElement.duration * this.timelineWidget.nativeFPS);
                    if (accurateFrames > 0) {
                        this.timelineWidget.setTotalFrames(this, accurateFrames);
                        // Only set default markers if not already restored by onConfigure
                        if (this.timelineWidget.startFrameMarker === 1 && this.timelineWidget.endFrameMarker === 1) {
                            this.timelineWidget.setStartFrame(1, this);
                            this.timelineWidget.setEndFrame(accurateFrames, this);
                        } else if (this.timelineWidget.endFrameMarker > accurateFrames || this.timelineWidget.endFrameMarker === 1) {
                            // End marker exceeds new video length or wasn't set - clamp/update it
                            this.timelineWidget.setEndFrame(Math.min(this.timelineWidget.endFrameMarker || accurateFrames, accurateFrames), this);
                        }
                    }
                }
            };

            // Store original onConfigure and wrap it
            const originalOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(info) {
                if (originalOnConfigure) {
                    originalOnConfigure.apply(this, arguments);
                }

                // Restore frame count from saved widget values
                if (info?.widgets_values && info.widgets_values.length > 1) {
                    const frameCount = info.widgets_values[1];
                    if (frameCount && frameCount > 0) {
                        this.timelineWidget?.setTotalFrames(this, frameCount);
                    }
                }
                // Restore video display from saved combo value (widgets_values[0])
                if (info?.widgets_values && info.widgets_values.length > 0) {
                    const videoFilename = info.widgets_values[0];
                    if (videoFilename && typeof this.loadVideoIntoDisplay === 'function') {
                        this.loadVideoIntoDisplay(videoFilename);
                    }
                    // Update the file selector widget display if it exists
                    if (this.fileSelectorWidget) {
                        this.fileSelectorWidget.setCurrentFilename(videoFilename);
                    }
                }
                // Restore timeline bracket markers [ and ] from hidden widgets
                // Only restore if widgets exist AND have valid values (not null/undefined/0)
                if (this.timelineWidget && this.widgets) {
                    const startFrameWidget = this.widgets.find(w => w.name === 'start_frame');
                    const endFrameWidget = this.widgets.find(w => w.name === 'end_frame');

                    // Restore start marker only if widget has a valid value
                    if (startFrameWidget && typeof startFrameWidget.value === 'number' && startFrameWidget.value > 0) {
                        this.timelineWidget.startFrameMarker = startFrameWidget.value;
                    }
                    // Restore end marker only if widget has a valid value
                    if (endFrameWidget && typeof endFrameWidget.value === 'number' && endFrameWidget.value > 0) {
                        this.timelineWidget.endFrameMarker = endFrameWidget.value;
                    }
                }
                // Restore force_fps from hidden widget to custom UI
                const forceFpsWidget = this.widgets.find(w => w.name === 'force_fps');
                if (forceFpsWidget) {
                    // Sanitize: ensure valid float value (ComfyUI validator rejects {} or None)
                    if (typeof forceFpsWidget.value !== 'number' || isNaN(forceFpsWidget.value)) {
                        forceFpsWidget.value = 0;
                    }
                    if (this.topRowWidget) {
                        this.topRowWidget.forceFpsValue = String(forceFpsWidget.value);
                    }
                }
                // Restore max_fps from hidden widget to custom UI
                const maxFpsWidget = this.widgets.find(w => w.name === 'max_fps');
                if (maxFpsWidget) {
                    // Sanitize: ensure valid float value
                    if (typeof maxFpsWidget.value !== 'number' || isNaN(maxFpsWidget.value)) {
                        maxFpsWidget.value = 0;
                    }
                    if (this.topRowWidget) {
                        this.topRowWidget.maxFpsValue = String(maxFpsWidget.value);
                    }
                }
            };

            // Store original onRemoved and wrap it
            const originalOnRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function() {
                // Clean up timeline widget
                if (this.timelineWidget) {
                    this.timelineWidget.onRemove(this);
                }

                // Clean up drag-and-drop handlers
                if (this.dragHandlers) {
                    const container = document.getElementById(`power-load-video-${this.id}`);
                    if (container) {
                        container.removeEventListener('dragover', this.dragHandlers.handleDragOver);
                        container.removeEventListener('dragleave', this.dragHandlers.handleDragLeave);
                        container.removeEventListener('drop', this.dragHandlers.handleDrop);
                    }
                    this.dragHandlers = null;
                }

                // Clean up hover audio
                if (this._stopHoverAudio) {
                    this._stopHoverAudio();
                    this._stopHoverAudio = null;
                    this._loadHoverAudio = null;
                }

                // Clear VFR frame cache on node removal
                if (this.clearVFRFrames) {
                    this.clearVFRFrames();
                }

                // Clean up keyboard shortcut handler
                if (this.handlePlayPauseShortcut) {
                    document.removeEventListener('keydown', this.handlePlayPauseShortcut);
                    this.handlePlayPauseShortcut = null;
                }

                // Clean up MutationObserver if exists
                if (this.vhsObserver) {
                    this.vhsObserver.disconnect();
                    this.vhsObserver = null;
                }

                // Remove inline styles
                const styleEl = document.getElementById(`power-load-video-styles-${this.id}`);
                if (styleEl) {
                    styleEl.remove();
                }

                if (originalOnRemoved) {
                    originalOnRemoved.apply(this, arguments);
                }
            };
        }
    },
});
