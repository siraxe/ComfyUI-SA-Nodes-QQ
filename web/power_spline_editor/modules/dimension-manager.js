/**
 * Dimension Manager Module
 * Handles canvas dimensions, frame scaling, and keyframe management
 */

import { safeSetSessionItem } from './image-cache.js';
import { recenterBackgroundVideo } from '../canvas/canvas_video_background.js';
import { isLayerWidget } from '../layer_widget_identity.js';

/**
 * Create dimension manager instance
 * @param {Object} node - The PowerSplineEditor node instance
 * @returns {Object} - Manager with methods for handling dimensions
 */
export function createDimensionManager(node) {
  return {
    /**
     * Handle frames refresh and keyframe scaling
     */
    async handleFramesRefresh() {
      try {
        // Step 1: Find all box type layers
        const boxLayers = this._getBoxLayers();
        if (boxLayers.length === 0) {
          return;
        }

        // Step 2: Check which box layers have keyframes
        const boxLayersWithKeys = boxLayers.filter(layer => {
          return (
            layer.value.box_keys &&
            Array.isArray(layer.value.box_keys) &&
            layer.value.box_keys.length > 0
          );
        });

        // Step 3: Determine target frames
        const targetFrames = this._getTargetFrames();
        if (!targetFrames) {
          return;
        }

        // Step 4: Get current max frames from timeline
        try {
          const module = await import('../canvas/canvas_constants.js');
          const currentMaxFrames =
            node.editor?._getMaxFrames?.() ?? module.BOX_TIMELINE_MAX_POINTS ?? 50;

          // Step 5: Decide scaling behavior
          await this._scaleFrames(
            boxLayersWithKeys,
            targetFrames,
            currentMaxFrames
          );

          // Step 6: Refresh editor
          if (node.editor?.redraw) {
            node.editor.redraw();
          }

          node.setDirtyCanvas(true, true);
        } catch (error) {
          console.error('[DimensionManager] Error importing canvas_constants:', error);
        }
      } catch (error) {
        console.error('[DimensionManager] Error handling frames refresh:', error);
      }
    },

    /**
     * Get all box layers from node widgets
     */
    _getBoxLayers() {
      const boxLayers = [];
      if (node.widgets) {
        for (const widget of node.widgets) {
          if (widget.value && widget.value.type === 'box_layer') {
            boxLayers.push(widget);
          }
        }
      }
      return boxLayers;
    },

    /**
     * Get target frames from input or property
     */
    _getTargetFrames() {
      const framesInputValue = this.getInputOrProperty('frames');
      const hasFramesInput =
        typeof framesInputValue === 'number' &&
        !Number.isNaN(framesInputValue) &&
        framesInputValue > 0;

      if (!hasFramesInput) {
        return null;
      }

      return Math.max(1, Math.round(framesInputValue));
    },

    /**
     * Scale frames based on target frames
     */
    async _scaleFrames(boxLayersWithKeys, targetFrames, currentMaxFrames) {
      const persistMaxFrames = (frames) => {
        if (node.editor) {
          node.editor._maxFrames = frames;
        }

        node.properties = node.properties || {};
        node.properties.box_max_frames = frames;

        if (node.uuid) {
          safeSetSessionItem(`spline-editor-maxframes-${node.uuid}`, String(frames));
        }
      };

      // Determine last keyframe
      const lastKeyFrame =
        boxLayersWithKeys.length > 0
          ? Math.max(
              ...boxLayersWithKeys.map(layer =>
                Math.max(
                  ...layer.value.box_keys.map(k =>
                    Math.max(1, Number(k.frame) || 1)
                  )
                )
              )
            )
          : 0;

      if (targetFrames > currentMaxFrames) {
        // Expand canvas
        persistMaxFrames(targetFrames);
      } else {
        // Contract or maintain canvas
        if (lastKeyFrame <= targetFrames) {
          // Can safely set to target frames
          persistMaxFrames(targetFrames);
        } else {
          // Need to scale keyframes
          const scaleRatio = targetFrames / currentMaxFrames;

          if (boxLayersWithKeys.length > 0) {
            for (const layer of boxLayersWithKeys) {
              const originalKeys = layer.value.box_keys;
              const scaledKeys = originalKeys.map(key => {
                const newFrame = Math.max(
                  1,
                  Math.min(targetFrames, Math.round(key.frame * scaleRatio))
                );
                return { ...key, frame: newFrame };
              });

              // Remove duplicate frames (keep last one for each frame)
              const keysByFrame = new Map();
              for (const key of scaledKeys) {
                keysByFrame.set(key.frame, key);
              }

              layer.value.box_keys = Array.from(keysByFrame.values()).sort(
                (a, b) => a.frame - b.frame
              );
            }
          }

          persistMaxFrames(targetFrames);
        }
      }
    },

    /**
     * Get input value or property value
     */
    getInputOrProperty(name) {
      const coerceNumber = val => {
        if (val === null || val === undefined) return val;
        const num = Number(val);
        return Number.isNaN(num) ? val : num;
      };

      // Try to get from connected input
      if (node.inputs) {
        const inputIndex = node.inputs.findIndex(i => i.name === name);
        if (inputIndex >= 0 && node.inputs[inputIndex].link != null) {
          const link = app.graph.links.get(node.inputs[inputIndex].link);

          // Prefer explicit link data
          if (link?.data !== undefined) {
            return coerceNumber(link.data);
          }

          if (link) {
            // Get source node
            const sourceNode = app.graph._nodes.find(
              n => n.id === link.origin_id
            );

            if (sourceNode?.outputs?.[link.origin_slot]) {
              const outputName = sourceNode.outputs[link.origin_slot].name;
              const widget = sourceNode.widgets?.find(
                w => w.name === outputName || w.name === name
              );

              if (widget) {
                return coerceNumber(widget.value);
              }

              // Fallback to output value
              const outputVal = sourceNode.outputs[link.origin_slot].value;
              if (outputVal !== undefined) {
                return coerceNumber(outputVal);
              }

              // Fallback to first numeric widget
              const firstNumericWidget = sourceNode.widgets?.find(w => {
                const num = coerceNumber(w.value);
                return typeof num === 'number' && !Number.isNaN(num);
              });

              if (firstNumericWidget) {
                return coerceNumber(firstNumericWidget.value);
              }

              // Fallback to first numeric property
              if (sourceNode.properties) {
                for (const val of Object.values(sourceNode.properties)) {
                  const num = coerceNumber(val);
                  if (typeof num === 'number' && !Number.isNaN(num)) {
                    return num;
                  }
                }
              }
            }
          }

          // Fallback to direct input value
          const directInputVal = node.inputs[inputIndex].value;
          if (directInputVal !== undefined) {
            return coerceNumber(directInputVal);
          }
        }
      }

      // Fallback to property
      if (node.properties?.[name] !== undefined) {
        return coerceNumber(node.properties[name]);
      }

      // Fallback to widget
      const widget = node.widgets?.find(w => w.name === name);
      if (widget) {
        return coerceNumber(widget.value);
      }

      return null;
    },

    /**
     * Update canvas dimensions
     */
    updateCanvasDimensions(width, height) {
      if (!node.editor) {
        console.warn('[DimensionManager] Editor not initialized');
        return;
      }

      // Update editor dimensions
      node.editor.width = width;
      node.editor.height = height;

      // Update visualization
      if (node.editor.vis) {
        node.editor.vis.width(width);
        node.editor.vis.height(height);
        node.editor.vis.render();
      }

      // Update video position if video is loaded
      if (node.editor.videoElement && node.editor.videoMetadata) {
        recenterBackgroundVideo(node.editor);
      }

      // Refresh layers
      if (node.editor.layerRenderer) {
        node.editor.layerRenderer.render();
      }
    },

    /**
     * Scale spline points based on dimension change
     */
    scaleSplinePoints(oldWidth, oldHeight, newWidth, newHeight) {
      const scaleX = newWidth / oldWidth;
      const scaleY = newHeight / oldHeight;

      const splineWidgets = node.widgets?.filter(isLayerWidget);

      if (!splineWidgets?.length) {
        return;
      }

      splineWidgets.forEach(widget => {
        if (widget.value?.points_store) {
          try {
            let points = JSON.parse(widget.value.points_store);

            const transformedPoints = points.map(point => ({
              ...point,
              x: point.x * scaleX,
              y: point.y * scaleY
            }));

            widget.value.points_store = JSON.stringify(transformedPoints);
          } catch (e) {
            console.error(
              '[DimensionManager] Error updating spline points:',
              e
            );
          }
        }
      });
    },

    /**
     * Get current canvas dimensions
     */
    getCanvasDimensions() {
      const widthWidget = node.widgets?.find(w => w.name === 'mask_width');
      const heightWidget = node.widgets?.find(w => w.name === 'mask_height');

      return {
        width: widthWidget?.value || 640,
        height: heightWidget?.value || 480
      };
    },

    /**
     * Restore dimensions from session storage
     */
    async restoreDimensionsFromSession() {
      try {
        if (!node.uuid) return null;

        const savedDims = sessionStorage.getItem(
          `spline-editor-dims-${node.uuid}`
        );
        if (savedDims) {
          const dims = JSON.parse(savedDims);
          return dims;
        }
      } catch (error) {
        console.error('[DimensionManager] Error restoring dimensions:', error);
      }

      return null;
    },

    /**
     * Save dimensions to session storage
     */
    saveDimensionsToSession(width, height) {
      try {
        if (!node.uuid) return;

        safeSetSessionItem(
          `spline-editor-dims-${node.uuid}`,
          JSON.stringify({ width, height })
        );
      } catch (error) {
        console.error('[DimensionManager] Error saving dimensions:', error);
      }
    },

    /**
     * Check if user has manually adjusted dimensions
     */
    hasUserAdjustedDimensions() {
      return node.properties?.userAdjustedDims || false;
    },

    /**
     * Mark dimensions as user-adjusted
     */
    markDimensionsAsUserAdjusted(width, height) {
      node.properties = node.properties || {};
      node.properties.userAdjustedDims = true;
      node.properties.bgImageDims = { width, height };

      try {
        const userDims = { width: Number(width), height: Number(height) };
        if (node.uuid) {
          safeSetSessionItem(
            `spline-editor-user-dims-${node.uuid}`,
            JSON.stringify(userDims)
          );
        }
      } catch {}
    },

    /**
     * Restore max frames from session storage or properties
     */
    restoreMaxFrames() {
      try {
        // First check node properties
        if (node.properties?.box_max_frames) {
          const savedFrames = Number(node.properties.box_max_frames);
          if (!Number.isNaN(savedFrames) && savedFrames > 0 && node.editor) {
            node.editor._maxFrames = savedFrames;
            console.log(`[DimensionManager] Restored max frames from properties: ${savedFrames}`);
            return savedFrames;
          }
        }

        // Then check session storage
        if (node.uuid) {
          const sessionValue = sessionStorage.getItem(`spline-editor-maxframes-${node.uuid}`);
          if (sessionValue) {
            const savedFrames = Number(sessionValue);
            if (!Number.isNaN(savedFrames) && savedFrames > 0 && node.editor) {
              node.editor._maxFrames = savedFrames;
              // Also update properties for persistence
              node.properties = node.properties || {};
              node.properties.box_max_frames = savedFrames;
              console.log(`[DimensionManager] Restored max frames from session: ${savedFrames}`);
              return savedFrames;
            }
          }
        }
      } catch (error) {
        console.warn('[DimensionManager] Error restoring max frames:', error);
      }
      return null;
    },

    /**
     * Initialize max frames from the frames input/property
     * This sets the initial max frames based on what's connected to the frames input
     */
    initializeMaxFramesFromInput() {
      try {
        const targetFrames = this._getTargetFrames();
        if (targetFrames && node.editor) {
          node.editor._maxFrames = targetFrames;
          node.properties = node.properties || {};
          node.properties.box_max_frames = targetFrames;
          if (node.uuid) {
            safeSetSessionItem(`spline-editor-maxframes-${node.uuid}`, String(targetFrames));
          }
          console.log(`[DimensionManager] Initialized max frames from input: ${targetFrames}`);
          return targetFrames;
        }
      } catch (error) {
        console.warn('[DimensionManager] Error initializing max frames:', error);
      }
      return null;
    }
  };
}
