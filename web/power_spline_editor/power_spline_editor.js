/**
 * PowerSplineEditor Main Extension
 * Integrates all modular managers for spline editing functionality
 */

import { app } from '../../../scripts/app.js';
import {
  makeUUID,
  loadScript,
  create_documentation_stylesheet,
  RgthreeBaseWidget,
  DimensionsWidget,
  PowerSplineHeaderWidget,
  NodeSizeManager,
  drawWidgetButton,
  transformMouseToVideoSpace,
  transformVideoToCanvasSpace
} from './spline_utils.js';
import { TopRowWidget, handleCanvasRefresh, handleFramesRefresh } from './canvas_top_row.js';
import { commitHanddrawPath } from './layer_type_draw.js';
import { isLayerWidget } from './layer_widget_identity.js';
import { chainCallback, hideWidgetForGood } from './general_utils.js';
import { initializeLayerUI, SplineLayerManager } from './layer_ui_main_widget.js';
import SplineEditor2 from './canvas/canvas_main.js';
import {
  getSlotInPosition,
  getSlotMenuOptions,
  showCustomDrivenToggleMenu
} from './context_menu.js';
import { drawDriverLines } from './driver_line_renderer.js';

import { createBackgroundImageManager } from './modules/background-image-manager.js';
import { createRefImageManager } from './modules/ref-image-manager.js';
import { createVideoBackgroundManager } from './modules/video-background-manager.js';
import { createDimensionManager } from './modules/dimension-manager.js';
import { saveRefImageToCache, safeSetSessionItem } from './modules/image-cache.js';

// Load external scripts
loadScript('/web_async/svg-path-properties.min.js').catch(e =>
  console.log(e)
);

// Initialize Protovis loading with proper tracking
if (typeof window.pv === 'undefined') {
    window.protovisLoaded = false;
}
const loadProtovis = async () => {
    // Check if protovis is already loaded to prevent multiple loads
    if (typeof window.pv !== 'undefined') {
        console.log('[PowerSplineEditor] Protovis already loaded');
        window.protovisLoaded = true;
        return;
    }

    try {
        console.log('[PowerSplineEditor] Loading Protovis from /web_async/protovis.min.js...');
        await loadScript('/web_async/protovis.min.js');
        console.log('[PowerSplineEditor] Script loaded, waiting for pv to be available...');
        // Wait a bit to ensure protovis is fully loaded
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify protovis is now available
        if (typeof window.pv !== 'undefined') {
            window.protovisLoaded = true;
            console.log('[PowerSplineEditor] Protovis loaded successfully');
        } else {
            console.warn("[PowerSplineEditor] Protovis library did not load properly, checking typeof pv:", typeof pv);
            // Try accessing pv directly (it might be global but not on window)
            if (typeof pv !== 'undefined') {
                console.log('[PowerSplineEditor] Found pv as global variable');
                window.protovisLoaded = true;
            }
        }
    } catch (e) {
        console.error("[PowerSplineEditor] Failed to load protovis.min.js", e);
    }
};

// Start loading Protovis immediately
loadProtovis().catch(e => console.log(e));
create_documentation_stylesheet();

app.registerExtension({
  name: 'WanVideoWrapper_QQ.PowerSplineEditor',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === 'PowerSplineEditor') {
      // Initialize modules
      // await initializeModules();

      // ============================================================== 
      // == NODE CREATED - Setup and initialization
      // ============================================================
      chainCallback(nodeType.prototype, 'onNodeCreated', async function () {
        this.serialize_widgets = true;
        this.resizable = false;

        // Initialize core managers
        this.sizeManager = new NodeSizeManager(this);
        this.layerManager = new SplineLayerManager(this);

        // Initialize modular managers
        this.bgImageManager = createBackgroundImageManager(this);
        this.refImageManager = createRefImageManager(this);
        this.videoManager = createVideoBackgroundManager(this);
        this.dimensionManager = createDimensionManager(this);

        // Set up onResize
        this.onResize = function (size) {
          const constrainedSize = this.sizeManager.onNodeResized(size);
          size[0] = constrainedSize[0];
          size[1] = constrainedSize[1];
        };

        // Hide and setup coordinates widget
        const coordinatesWidget = this.widgets.find(w => w.name === 'coordinates');
        hideWidgetForGood(this, coordinatesWidget);
        coordinatesWidget.value = '[]';

        // Create DOM element for editor
        var element = document.createElement('div');
        this.uuid = makeUUID();
        element.id = `spline-editor-${this.uuid}`;
        element.style.margin = '0';
        element.style.padding = '0';
        element.style.display = 'block';

        // ============================================================
        // == CONTEXT MENU INITIALIZATION
        // ============================================================
        // Create context menu container
        const contextMenuContainer = document.createElement('div');
        contextMenuContainer.className = 'spline-editor-context-menu';
        contextMenuContainer.style.cssText = `
          position: fixed !important;
          display: none !important;
          background-color: #1a1a1a !important;
          border: 1px solid #000 !important;
          box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
          z-index: 10000 !important;
          padding: 4px !important;
          border-radius: 0px !important;
          min-width: 160px !important;
          font-family: Arial, sans-serif !important;
          font-size: 11px !important;
        `;

        // Define menu items with their labels
        const menuItemLabels = [
          'Invert point order',  // Item 0: toggles to "Edit" for handdraw layers
          'Smooth',              // Item 1: only visible for handdraw layers
          'Remove',              // Item 2
          'Load Image',          // Item 3
          'Clear Image',         // Item 4
          'Clear All Splines'    // Item 5
        ];

        // Create menu items array
        const menuItems = menuItemLabels.map(label => {
          const menuItem = document.createElement('div');
          menuItem.textContent = label;
          menuItem.style.cssText = `
            padding: 6px 12px !important;
            cursor: pointer !important;
            color: #ddd !important;
            background-color: #1a1a1a !important;
            user-select: none !important;
            white-space: nowrap !important;
          `;

          // Add hover effects
          menuItem.addEventListener('mouseenter', () => {
            menuItem.style.backgroundColor = '#2a2a2a';
          });
          menuItem.addEventListener('mouseleave', () => {
            menuItem.style.backgroundColor = '#1a1a1a';
          });

          contextMenuContainer.appendChild(menuItem);
          return menuItem;
        });

        // Attach menu to document body
        document.body.appendChild(contextMenuContainer);

        // Store references on the node for SplineEditor2 to access
        this.contextMenu = contextMenuContainer;
        this.menuItems = menuItems;

        // Clean up context menu when node is removed
        const originalOnRemoved = this.onRemoved;
        this.onRemoved = function() {
          if (this.contextMenu && this.contextMenu.parentNode) {
            this.contextMenu.parentNode.removeChild(this.contextMenu);
          }
          if (originalOnRemoved) {
            originalOnRemoved.call(this);
          }
        };

        // Add fake image widget for copy/paste
        const fakeimagewidget = this.addWidget('COMBO', 'image', null, () => {}, {
          values: []
        });
        hideWidgetForGood(this, fakeimagewidget);
        fakeimagewidget.draw = () => {};

        // Hide internal widgets
        const pointsStoreWidget = this.widgets.find(
          w => w.name === 'points_store'
        );
        if (pointsStoreWidget) {
          hideWidgetForGood(this, pointsStoreWidget);
        }

        // ============================================================== 
        // == SETUP WIDTH/HEIGHT WIDGETS WITH CALLBACKS
        // ============================================================
        const widthWidget = this.widgets.find(w => w.name === 'mask_width');
        if (widthWidget) {
          const originalWidthCallback = widthWidget.callback;
          widthWidget.callback = (value) => {
            if (originalWidthCallback) originalWidthCallback.call(widthWidget, value);
            this.properties = this.properties || {};
            this.properties.userAdjustedDims = true;
            this.properties.bgImageDims = this.properties.bgImageDims || {};
            this.properties.bgImageDims.width = value;
            try {
              const hWidget = this.widgets.find(w => w.name === 'mask_height');
              const userDims = {
                width: Number(value),
                height: Number(hWidget?.value ?? this.properties.bgImageDims.height ?? 0)
              };
              if (this.uuid) {
                safeSetSessionItem(
                  `spline-editor-user-dims-${this.uuid}`,
                  JSON.stringify(userDims)
                );
              }
            } catch {}
          };
          hideWidgetForGood(this, widthWidget);
        }

        const heightWidget = this.widgets.find(w => w.name === 'mask_height');
        if (heightWidget) {
          const originalHeightCallback = heightWidget.callback;
          heightWidget.callback = (value) => {
            if (originalHeightCallback)
              originalHeightCallback.call(heightWidget, value);
            this.properties = this.properties || {};
            this.properties.userAdjustedDims = true;
            this.properties.bgImageDims = this.properties.bgImageDims || {};
            this.properties.bgImageDims.height = value;
            try {
              const wWidget = this.widgets.find(w => w.name === 'mask_width');
              const userDims = {
                width: Number(wWidget?.value ?? this.properties.bgImageDims.width ?? 0),
                height: Number(value)
              };
              if (this.uuid) {
                safeSetSessionItem(
                  `spline-editor-user-dims-${this.uuid}`,
                  JSON.stringify(userDims)
                );
              }
            } catch {}
          };
          hideWidgetForGood(this, heightWidget);
        }

        // ============================================================
        // == SETUP BG_OPACITY WIDGET WITH CALLBACK
        // ============================================================
        const bgOpacityWidget = this.widgets.find(w => w.name === 'bg_opacity');
        if (bgOpacityWidget) {
          hideWidgetForGood(this, bgOpacityWidget);
          const originalCallback = bgOpacityWidget.callback;
          bgOpacityWidget.callback = (value) => {
            if (originalCallback) {
              originalCallback.call(bgOpacityWidget, value);
            }
            this.bgImageManager?.updateBackgroundImage();
            return value;
          };
        }

        // Hide pause widgets
        const startPauseWidget = this.widgets.find(
          w => w.name === 'start_pause'
        );
        if (startPauseWidget) {
          hideWidgetForGood(this, startPauseWidget);
          startPauseWidget.draw = () => {};
        }

        const endPauseWidget = this.widgets.find(w => w.name === 'end_pause');
        if (endPauseWidget) {
          hideWidgetForGood(this, endPauseWidget);
          endPauseWidget.draw = () => {};
        }

        // Hide interpolation, offset, repeat, driver widgets
        const interpolationWidget = this.widgets.find(
          w => w.name === 'interpolation'
        );
        if (interpolationWidget) {
          hideWidgetForGood(this, interpolationWidget);
          interpolationWidget.draw = () => {};
        }

        const offsetWidget = this.widgets.find(w => w.name === 'offset');
        if (offsetWidget) {
          hideWidgetForGood(this, offsetWidget);
          offsetWidget.draw = () => {};
        }

        const repeatWidget = this.widgets.find(w => w.name === 'repeat');
        if (repeatWidget) {
          hideWidgetForGood(this, repeatWidget);
          repeatWidget.draw = () => {};
        }

        const driverRotationWidget = this.widgets.find(
          w => w.name === 'driver_rotation'
        );
        if (driverRotationWidget) {
          hideWidgetForGood(this, driverRotationWidget);
          driverRotationWidget.draw = () => {};
        }

        const driverDScaleWidget = this.widgets.find(
          w => w.name === 'driver_d_scale'
        );
        if (driverDScaleWidget) {
          hideWidgetForGood(this, driverDScaleWidget);
          driverDScaleWidget.draw = () => {};
        }

        // ============================================================
        // == CUSTOM WIDGET METHODS
        // ============================================================
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

        // Add top row widget
        this.addCustomWidget(new TopRowWidget('top_row_display', {}, {
          onRefreshCanvas: handleCanvasRefresh,
          onRefreshFrames: handleFramesRefresh
        }));

        // Add SplineEditor2 DOM widget
        this.splineEditor2 = this.addDOMWidget(nodeData.name, 'SplineEditor2Widget', element, {
          serialize: false,
          hideOnZoom: false
        });

        // Set computeSize for proper layout
        this.splineEditor2.computeSize = function (width) {
          const heightWidget = this.node?.widgets?.find(w => w.name === 'mask_height');
          const canvasHeight = heightWidget?.value ?? 480;
          const spacingAfterCanvas =
            this.node?.sizeManager?.config?.spacingAfterCanvas ?? 60;
          return [width, canvasHeight + spacingAfterCanvas];
        }.bind(this.splineEditor2);

        // ============================================================
        // == HELPER METHODS
        // ============================================================
        this.generateUniqueName = function (baseName, existingNames) {
          if (!existingNames.includes(baseName)) return baseName;
          const regex = /_(\d+)$/;
          let nameToCheck = baseName;
          let counter = 1;
          const match = baseName.match(regex);
          if (match) {
            nameToCheck = baseName.substring(0, match.index);
            counter = parseInt(match[1], 10) + 1;
          }
          let newName = `${nameToCheck}_${counter}`;
          while (existingNames.includes(newName)) {
            counter++;
            newName = `${nameToCheck}_${counter}`;
          }
          return newName;
        };

        this.hasSplineWidgets = function () {
          return (
            this.widgets &&
            this.widgets.some(isLayerWidget)
          );
        };

        this.allSplinesState = function () {
          const layerWidgets = this.widgets.filter(isLayerWidget);
          if (!layerWidgets.length) return false;
          return layerWidgets.every(w => w.value.on);
        };

        this.toggleAllSplines = function () {
          const layerWidgets = this.widgets.filter(isLayerWidget);
          const newState = !this.allSplinesState();
          layerWidgets.forEach(w => (w.value.on = newState));
          this.setDirtyCanvas(true, true);
        };

        this.updateNodeHeight = function () {
          this.sizeManager.updateSize(true);
        };

        this.commitHanddraw = function (points) {
          return commitHanddrawPath(this, points);
        };

        this.handleFramesRefresh = async function () {
          if (this.dimensionManager) {
            await this.dimensionManager.handleFramesRefresh();
          }
        };

        // ============================================================
        // == INITIALIZATION OVERLAY REFRESH
        // ============================================================
        this.initOverlayRefresh = async function () {
          try {
            const isConnectedToPrepareRefs =
              this.refImageManager.checkIfConnectedToPrepareRefs();

            if (isConnectedToPrepareRefs) {
              try {
                const timestamp = Date.now();
                const refImageUrl = new URL(
                  `ref/bg_image_cl.png?t=${timestamp}`,
                  import.meta.url
                ).href;
                const response = await fetch(refImageUrl);
                if (response.ok) {
                  const blob = await response.blob();
                  const base64Data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                  });

                  this.originalRefImageData = {
                    name: 'bg_image_cl.png',
                    base64: base64Data,
                    type: 'image/png'
                  };

                  await this.bgImageManager.updateBackgroundImage();
                  this.editor?.refreshBackgroundImage?.();
                  return;
                }
              } catch (e) {
                console.error('Failed to load bg_image_cl.png:', e);
              }
            } else {
              // Try to pull fresh ref image from connected node
              const { getReferenceImageFromConnectedNode } = await import(
                './graph_query.js'
              );
              const base64Image = await getReferenceImageFromConnectedNode(this);
              if (base64Image) {
                this.originalRefImageData = {
                  name: 'ref_image_from_connection.jpg',
                  base64: base64Image.split(',')[1],
                  type: 'image/jpeg'
                };
                try {
                  await saveRefImageToCache(this.originalRefImageData.base64, 'bg_image.png');
                } catch {}
                if (this.uuid) {
                  sessionStorage.removeItem(`spline-editor-img-${this.uuid}`);
                }
                await this.bgImageManager.updateBackgroundImage();
                this.editor?.refreshBackgroundImage?.();
                return;
              }
            }
          } catch {}

          // Fallback: just apply current opacity
          try {
            await this.bgImageManager.updateBackgroundImage();
            this.editor?.refreshBackgroundImage?.();
          } catch {}
        }.bind(this);

        // Trigger auto-refresh during init
        setTimeout(() => {
          this.initOverlayRefresh();
        }, 150);
        setTimeout(() => {
          this.initOverlayRefresh();
        }, 700);

        // Set initial node size
        this.updateNodeHeight();

        // Initialize layer UI
        initializeLayerUI(this);

        // ============================================================
        // == UI EVENT HANDLERS
        // ============================================================

        // Override onNodeContextMenu
        const originalOnNodeContextMenu = nodeType.prototype.onNodeContextMenu;
        nodeType.prototype.onNodeContextMenu = function (x, y, node) {
          for (const widget of this.layerManager.getSplineWidgets()) {
            if (widget.hitAreas?.drivenToggle) {
              const toggleBounds = widget.hitAreas.drivenToggle.bounds;
              const widgetAbsX = node.pos[0];
              const widgetAbsY = node.pos[1] + widget.last_y;

              const toggleAbsXStart = widgetAbsX + toggleBounds[0];
              const toggleAbsXEnd = toggleAbsXStart + toggleBounds[1];
              const toggleAbsYStart = widgetAbsY;
              const toggleAbsYEnd = widgetAbsY + LiteGraph.NODE_WIDGET_HEIGHT;

              if (
                x >= toggleAbsXStart &&
                x <= toggleAbsXEnd &&
                y >= toggleAbsYStart &&
                y <= toggleAbsYEnd
              ) {
                showCustomDrivenToggleMenu(null, widget, { x, y });
                return false;
              }
            }
          }

          return originalOnNodeContextMenu?.apply(this, arguments);
        };

        // Draw foreground
        chainCallback(this, 'onDrawForeground', function (ctx) {
          if (!this.flags.collapsed) {
            drawDriverLines(ctx, this);
          }
        });
      });

      // ============================================================
      // == NODE CONFIGURATION
      // ============================================================
      chainCallback(nodeType.prototype, 'onConfigure', async function (info) {
        if (!this.widgets || !this.updateNodeHeight) {
          return;
        }

        // Restore persisted max frames
        if (this.editor && this.properties?.box_max_frames) {
          const propMaxFrames = Number(this.properties.box_max_frames);
          if (!Number.isNaN(propMaxFrames) && propMaxFrames > 0) {
            this.editor._maxFrames = propMaxFrames;
            if (this.uuid) {
              safeSetSessionItem(
                `spline-editor-maxframes-${this.uuid}`,
                String(propMaxFrames)
              );
            }
          }
        }

        const savedSize = [this.size[0], this.size[1]];
        this.layerManager.recreateSplinesFromData(info.widgets_values);

        // Ensure coordWidget has default value
        const coordWidget = this.widgets.find(w => w.name === 'coordinates');
        if (coordWidget && !coordWidget.value) {
          coordWidget.value = '[]';
        }

        try {
          // Restore background image dimensions
          let dims = null;
          const sessionDims = sessionStorage.getItem(
            `spline-editor-dims-${this.uuid}`
          );
          if (sessionDims) {
            dims = JSON.parse(sessionDims);
          } else if (
            this.properties?.bgImageDims &&
            !this.properties.userAdjustedDims
          ) {
            dims = this.properties.bgImageDims;
          }

          // Apply dimensions
          if (dims && !this.properties.userAdjustedDims) {
            const widthWidget = this.widgets.find(w => w.name === 'mask_width');
            const heightWidget = this.widgets.find(
              w => w.name === 'mask_height'
            );

            const userDimsJson = this.uuid
              ? sessionStorage.getItem(`spline-editor-user-dims-${this.uuid}`)
              : null;
            const hasUserDims =
              this.properties.userAdjustedDims || !!userDimsJson;

            if (!hasUserDims) {
              const widgetDiffers =
                (widthWidget &&
                  dims &&
                  typeof widthWidget.value === 'number' &&
                  widthWidget.value !== dims.width) ||
                (heightWidget &&
                  dims &&
                  typeof heightWidget.value === 'number' &&
                  heightWidget.value !== dims.height);

              if (widgetDiffers) {
                this.properties.userAdjustedDims = true;
                try {
                  const stored = {
                    width: Number(widthWidget?.value ?? dims.width),
                    height: Number(heightWidget?.value ?? dims.height)
                  };
                  if (this.uuid) {
                    safeSetSessionItem(
                      `spline-editor-user-dims-${this.uuid}`,
                      JSON.stringify(stored)
                    );
                  }
                } catch {}
              } else {
                if (widthWidget && widthWidget.value !== dims.width) {
                  widthWidget.value = dims.width;
                }
                if (heightWidget && heightWidget.value !== dims.height) {
                  heightWidget.value = dims.height;
                }
              }
            } else if (userDimsJson) {
              try {
                const userDims = JSON.parse(userDimsJson);
                if (widthWidget && typeof userDims.width === 'number') {
                  widthWidget.value = userDims.width;
                }
                if (heightWidget && typeof userDims.height === 'number') {
                  heightWidget.value = userDims.height;
                }
              } catch {}
            }

            if (!this.properties.userAdjustedDims) {
              this.properties.bgImageDims = dims;
            }
          }

          // Restore node size
          this.sizeManager.onConfigure(savedSize);

          // Update canvas dimensions
          if (this.editor && this.editor.vis) {
            const userDimsJson2 = this.uuid
              ? sessionStorage.getItem(`spline-editor-user-dims-${this.uuid}`)
              : null;
            const hasUserDims2 =
              this.properties.userAdjustedDims || !!userDimsJson2;
            const canvasWidth =
              dims && !hasUserDims2
                ? dims.width
                : this.properties.bgImageDims?.width ??
                  this.editor.widthWidget.value;
            const canvasHeight =
              dims && !hasUserDims2
                ? dims.height
                : this.properties.bgImageDims?.height ??
                  this.editor.heightWidget.value;

            this.editor.width = canvasWidth;
            this.editor.height = canvasHeight;
            this.editor.vis.width(canvasWidth);
            this.editor.vis.height(canvasHeight);
            this.editor.vis.render();

            // Update video position
            if (this.editor.videoElement && this.editor.videoMetadata) {
              const { recenterBackgroundVideo } = await import(
                './canvas/canvas_video_background.js'
              );
              recenterBackgroundVideo(this.editor);
            }

            // Scale spline points
            const oldWidth = this.editor.width || canvasWidth;
            const oldHeight = this.editor.height || canvasHeight;
            const scaleX = canvasWidth / oldWidth;
            const scaleY = canvasHeight / oldHeight;

            const splineWidgets = this.widgets?.filter(isLayerWidget);

            splineWidgets?.forEach(widget => {
              if (widget.value.points_store) {
                try {
                  let points = JSON.parse(widget.value.points_store);
                  const transformedPoints = points.map(point => ({
                    ...point,
                    x: point.x * scaleX,
                    y: point.y * scaleY
                  }));
                  widget.value.points_store = JSON.stringify(
                    transformedPoints
                  );
                } catch (e) {
                  console.error(
                    'Error updating spline points for new dimensions:',
                    e
                  );
                }
              }
            });

            if (this.editor.layerRenderer) {
              this.editor.layerRenderer.render();
            }
          }

          // Restore image from session
          if (this.uuid) {
            const sessionImgData = sessionStorage.getItem(
              `spline-editor-img-${this.uuid}`
            );
            if (sessionImgData) {
              this.imgData = JSON.parse(sessionImgData);
            } else if (this.properties.imgData) {
              this.imgData = this.properties.imgData;
              delete this.properties.imgData;
            }

            // Restore video from session
            const sessionVideoData = sessionStorage.getItem(
              `spline-editor-video-${this.uuid}`
            );
            if (sessionVideoData) {
              this.videoData = JSON.parse(sessionVideoData);
              console.log(
                '[PowerSplineEditor onConfigure] Restored video data from session:',
                this.videoData
              );
            }
          }

          // Create editor if needed
          if (!this.editor) {
            this.editor = new SplineEditor2(this);
          }

          // Restore max frames from session storage or properties
          if (this.dimensionManager) {
            const restoredFrames = this.dimensionManager.restoreMaxFrames();
            // If no saved frames, initialize from frames input
            if (!restoredFrames) {
              this.dimensionManager.initializeMaxFramesFromInput();
            }
          }

          // Restore video background
          if (this.videoData && !this.imgData && this.editor) {
            console.log('[PowerSplineEditor onConfigure] Restoring video background');
            const { loadBackgroundVideo } = await import(
              './canvas/canvas_video_background.js'
            );
            if (loadBackgroundVideo) {
              loadBackgroundVideo(this.editor, this.videoData);
            }
          }

          // Refresh background image
          if (this.editor && this.imgData) {
            this.editor?.refreshBackgroundImage?.();
          } else if (this.editor) {
            // Load reference image with current opacity
            await this.bgImageManager.updateBackgroundImage();
          }

          // Force active layer update
          if (this.editor) {
            const activeWidget = this.layerManager.getActiveWidget();
            if (activeWidget) {
              this.layerManager.activeWidget = null;
              this.layerManager.setActiveWidget(activeWidget);
            }
          }
        } catch (error) {
          console.error('An error occurred while configuring the editor:', error);
        }
      });

      // ============================================================== 
      // NODE EXECUTED
      // ============================================================
      chainCallback(nodeType.prototype, 'onExecuted', async function (message) {
        let ref_image = message['ref_image'];
        let coord_in = message['coord_in'];
        let ref_image_dims = message['ref_image_dims'];

        // ============================================================
        // == HANDLE VIDEO
        // ============================================================
        if (message.bg_video?.length > 0) {
          const videoInfo = message.bg_video[0];
          this.videoManager.handleVideoFromExecution(videoInfo);
        } else {
          console.log('[PowerSplineEditor] No bg_video in message');
          if (this.editor?.videoMetadata) {
            console.log(
              '[PowerSplineEditor] Clearing video metadata (switching to image)'
            );
            this.editor.videoMetadata = null;
            if (this.editor.videoElement) {
              this.editor.videoElement.pause();
              this.editor.videoElement.style.display = 'none';
            }
          }
          this.videoData = null;
        }

        // ============================================================== 
        // HANDLE DIMENSIONS
        // ============================================================
        if (ref_image_dims?.length > 0) {
          const dims = ref_image_dims[0];
          if (dims.width && dims.height) {
            this.properties = this.properties || {};
            if (!this.properties.userAdjustedDims) {
              this.properties.bgImageDims = {
                width: dims.width,
                height: dims.height
              };

              try {
                safeSetSessionItem(
                  `spline-editor-dims-${this.uuid}`,
                  JSON.stringify({
                    width: dims.width,
                    height: dims.height
                  })
                );
              } catch (e) {
                console.error('Could not save dimensions to session storage', e);
              }
            } else {
              console.log(
                'Skipped storing ref_image dimensions (user has manually adjusted)'
              );
            }
          }
        }

        // ============================================================== 
        // FINISH EXECUTION
        // ============================================================
        const finishExecution = (imgData) => {
          if (imgData) {
            this.imgData = imgData;
            try {
              const size = JSON.stringify(this.imgData).length;
              if (size < 640 * 480) {
                safeSetSessionItem(
                  `spline-editor-img-${this.uuid}`,
                  JSON.stringify(this.imgData)
                );
              }
            } catch (e) {
              console.error('Could not save image to session storage', e);
            }
            if (this.properties.imgData) {
              delete this.properties.imgData;
            }
          }

          // Initialize editor if needed
          if (!this.editor) {
            this.editor = new SplineEditor2(this, false);
          }

          // Restore max frames from session storage or properties
          if (this.dimensionManager) {
            const restoredFrames = this.dimensionManager.restoreMaxFrames();
            // If no saved frames, initialize from frames input
            if (!restoredFrames) {
              this.dimensionManager.initializeMaxFramesFromInput();
            }
          }

          const finishEditorSetup = async () => {
            if (coord_in) {
              const coord_in_str = Array.isArray(coord_in)
                ? coord_in.join('')
                : coord_in;
              this.editor.drawPreviousSpline(coord_in_str);
            }

            // ✅ Update box widgets with ref_image if available
            if (ref_image && this.editor?.refImageManager) {
              const dataUrl = ref_image.startsWith('data:') ? ref_image : `data:image/png;base64,${ref_image}`;
              const dims = await new Promise(resolve => {
                const img = new Image();
                img.onload = () => resolve({ width: img.width, height: img.height });
                img.onerror = () => resolve({ width: 1, height: 1 });
                img.src = dataUrl;
              });

              const attachment = {
                base64: ref_image.startsWith('data:') ? ref_image.split(',')[1] : ref_image,
                type: 'image/png',
                width: dims.width,
                height: dims.height
              };

              // Update all box widgets with the new ref_attachment
              const boxWidgets = this.layerManager?.getSplineWidgets?.().filter(w => w?.value?.type === 'box_layer') || [];
              boxWidgets.forEach(widget => {
                widget.value.ref_attachment = { entries: [attachment] };
                // Set selection to ref_1 if it's currently no_ref
                if (!widget.value.ref_selection || widget.value.ref_selection === 'no_ref') {
                  widget.value.ref_selection = 'ref_1';
                }
              });

              // Clear cache and render
              this.editor.layerRenderer?.clearRefImageCache?.();
            }

            // ✅ WAIT for video scale to be set before loading coordinates
            if (message.bg_video?.length > 0 && this.editor?.videoMetadata) {
              console.log('[PowerSplineEditor] Video detected, waiting for scale to be set...');

              // Wait for video to be ready with scale set
              await new Promise((resolve) => {
                const checkReady = () => {
                  // Check if video scale is set and stable
                  if (this.editor.videoScale && this.editor.scale && Math.abs(this.editor.scale - this.editor.videoScale) < 0.001) {
                    console.log('[PowerSplineEditor] Video scale ready:', this.editor.scale);
                    resolve();
                  } else {
                    // Poll every 100ms until ready
                    setTimeout(checkReady, 100);
                  }
                };

                // Start checking (with timeout of 5 seconds)
                const timeoutId = setTimeout(() => {
                  console.warn('[PowerSplineEditor] Video scale not ready after 5s, proceeding anyway');
                  resolve();
                }, 5000);

                checkReady();
              });
            }

            if (this.editor && this.imgData) {
              this.editor?.refreshBackgroundImage?.();
            } else if (this.editor) {
              this.editor?.vis?.render();
            }

            // ✅ Force render layer renderer to show ref images
            if (this.editor?.layerRenderer) {
              this.editor.layerRenderer.render();
            }
          };

          // Call the async function
          finishEditorSetup().catch(error => {
            console.error('[PowerSplineEditor] Error setting up editor:', error);
          });
        };

        // ============================================================
        // == HANDLE REFERENCE IMAGE
        // ============================================================
        if (message.bg_image_path?.length > 0) {
            const imagePath = message.bg_image_path[0];
            const imageName = imagePath.split('/').pop();
            const timestamp = new Date().getTime();
            const imageUrl = new URL(imagePath + '?t=' + timestamp, import.meta.url);

            console.log(`[onExecuted] Loading new background image from path: ${imageUrl.href}`);
            
            const targetWidth = ref_image_dims?.[0]?.width;
            const targetHeight = ref_image_dims?.[0]?.height;

            this.bgImageManager.loadBackgroundImageFromUrl(
                imageUrl.href,
                imageName,
                targetWidth,
                targetHeight
            );
        } else if (ref_image) {
          saveRefImageToCache(ref_image, 'bg_image.png').then(success => {
            if (success) {
              console.log('Ref image cached successfully for future use');
            } else {
              console.warn('Failed to cache ref image');
            }
          });

          // Store the reference image and apply current opacity
          this.originalRefImageData = {
            name: 'ref_image.png',
            base64: ref_image,
            type: 'image/png'
          };

          // Get current opacity and apply it to the reference image
          const bgOpacityWidget = this.widgets?.find(w => w.name === 'bg_opacity');
          const opacity = bgOpacityWidget ? bgOpacityWidget.value : 1.0;

          this.bgImageManager._applyOpacityToImage(ref_image, 'image/png', opacity)
            .then(() => finishExecution(this.imgData))
            .catch((error) => {
              console.error('Error applying opacity to reference image:', error);
              finishExecution(this.imgData);
            });
        } else {
          finishExecution(this.imgData);
        }
      });

      // ============================================================
      // == NODE CONTEXT MENU
      // ============================================================
      const originalOnContextMenu = nodeType.prototype.onContextMenu;
      nodeType.prototype.onContextMenu = function (x, y, menu, node) {
        for (const widget of this.layerManager.getSplineWidgets()) {
          if (widget.hitAreas?.drivenToggle) {
            const drivenToggleBounds = widget.hitAreas.drivenToggle.bounds;
            const widgetAbsX = this.pos[0];
            const widgetAbsY = this.pos[1] + widget.last_y;

            const toggleWidth = LiteGraph.NODE_WIDGET_HEIGHT * 0.72;
            const toggleAbsXStart = widgetAbsX + drivenToggleBounds[0];
            const toggleAbsXEnd = toggleAbsXStart + toggleWidth;
            const toggleAbsYStart = widgetAbsY;
            const toggleAbsYEnd = widgetAbsY + LiteGraph.NODE_WIDGET_HEIGHT;

            if (
              x >= toggleAbsXStart &&
              x <= toggleAbsXEnd &&
              y >= toggleAbsYStart &&
              y <= toggleAbsYEnd
            ) {
              showCustomDrivenToggleMenu(null, widget, { x, y });
              return false;
            }
          }
        }

        return originalOnContextMenu?.apply(this, arguments);
      };

      // ============================================================
      // == NODE SERIALIZATION
      // ============================================================
      const onSerialize = nodeType.prototype.onSerialize;
      nodeType.prototype.onSerialize = function (o) {
        const coordinatesWidget = this.widgets.find(w => w.name === 'coordinates');
        if (coordinatesWidget) {
          const splineWidgets = this.widgets.filter(isLayerWidget);
          const values = splineWidgets
            .map(w => w.value)
            .filter(v => v);
          coordinatesWidget.value = JSON.stringify(values);
        }
        onSerialize?.apply(this, arguments);
      };

      // Add context menu methods
      nodeType.prototype.getSlotInPosition = getSlotInPosition;
      nodeType.prototype.getSlotMenuOptions = getSlotMenuOptions;
    }
  }
});
