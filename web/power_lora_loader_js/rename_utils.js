// Shared utility functions for LoRA renaming

/**
 * Shows a temporary non-blocking message
 * @param {string} message - The message to display
 * @param {string} type - 'success', 'warning', or 'error'
 */
function showTemporaryMessage(message, type = 'success') {
    const messageElement = document.createElement('div');
    messageElement.style.cssText = `
        position: fixed !important;
        top: 20px !important;
        right: 20px !important;
        background-color: ${
            type === 'success' ? '#2a5a2a' :
            type === 'warning' ? '#5a5a2a' :
            '#5a2a2a'
        } !important;
        color: #ddd !important;
        padding: 12px 16px !important;
        border-radius: 6px !important;
        border: 1px solid ${
            type === 'success' ? '#4a7a4a' :
            type === 'warning' ? '#7a7a4a' :
            '#7a4a4a'
        } !important;
        font-family: Arial, sans-serif !important;
        font-size: 13px !important;
        z-index: 10002 !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
        opacity: 0 !important;
        transition: opacity 0.3s ease-in-out !important;
        max-width: 350px !important;
        word-wrap: break-word !important;
    `;

    messageElement.textContent = message;
    document.body.appendChild(messageElement);

    // Fade in
    setTimeout(() => {
        messageElement.style.opacity = '1';
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
        messageElement.style.opacity = '0';
        setTimeout(() => {
            if (messageElement.parentNode) {
                messageElement.parentNode.removeChild(messageElement);
            }
        }, 300);
    }, 3000);
}

/**
 * Renames a LoRA file and its associated files
 * @param {string} loraName - The current LoRA file path
 * @param {string} variant - 'high' for main LoRA, 'low' for low variant
 * @param {Function} [refreshCallback] - Optional callback to refresh the UI after renaming
 * @param {Function} [widgetCallback] - Optional widget callback for UI updates
 * @param {Object} [node] - Optional node for canvas updates
 * @param {Object} [widget] - Optional widget for value updates
 */
export async function renameLoRAFiles(loraName, variant = 'high', refreshCallback = null, widgetCallback = null, node = null, widget = null) {
    if (!loraName) {
        console.error('No LoRA name found for renaming');
        return;
    }

    // Extract filename without extension
    const fileName = loraName.includes('/') || loraName.includes('\\')
        ? loraName.split(/[\/\\]/).pop()
        : loraName;

    const baseName = fileName.replace(/\.safetensors$/, '');

    // Show a simple prompt for the new name
    const newName = prompt(`Enter new name for LoRA:`, baseName);

    if (!newName || newName.trim() === '') {
        return; // User cancelled or entered empty name
    }

    const finalNewName = newName.trim().replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize name

    if (finalNewName === baseName) {
        return; // No change
    }

    try {
        const response = await fetch('/wanvideo_wrapper/rename_lora', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                old_name: loraName,
                new_name: finalNewName,
                variant: variant
            })
        });

        // Check if response is ok before trying to parse JSON
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Server returned error:', response.status, errorText);
            throw new Error(`Server error ${response.status}: ${errorText}`);
        }

        // Try to parse JSON with better error handling
        let data;
        let responseText;
        try {
            responseText = await response.text();
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            console.error('Raw response text:', responseText);
            throw new Error(`Invalid JSON response from server: ${responseText ? responseText.substring(0, 200) : 'Empty response'}`);
        }

        if (data.success) {
            // Handle widget updates if widget and node are provided
            if (widget && node) {
                // Update the widget value(s) based on which variant was renamed
                if (variant === 'low') {
                    widget.value.low_variant_name = data.new_low_path;
                    if (widget.value.is_low && widget.value.low_variant_name) {
                        widget.value.lora_name = data.new_low_path;
                    }
                } else {
                    // The displayed/serialized value is `lora` (not lora_name)
                    widget.value.lora = data.new_high_path;
                    widget.value.lora_name = data.new_high_path;
                    // Also update low variant if it exists and is based on the high one
                    if (widget.value.is_low && widget.value.low_variant_name &&
                        widget.value.low_variant_name.includes(baseName)) {
                        widget.value.low_variant_name = data.new_low_path || data.new_high_path;
                    }
                }

                // Re-check low variant detection for the new name
                if (typeof widget.checkLowLoraVariant === 'function') {
                    widget.checkLowLoraVariant(widget.value.lora);
                }

                // Update the displayed name
                if (widgetCallback) {
                    widgetCallback(widget.value, null, null, null);
                }

                // Mark canvas as dirty to trigger redraw
                node.setDirtyCanvas(true, true);
            }

            // Handle refresh callback (for picker dialog)
            if (refreshCallback) {
                // Show success message in console and call refresh

                // Show a temporary success message instead of blocking alert
                showTemporaryMessage(`✅ LoRA renamed to: ${finalNewName}.safetensors`, 'success');

                try {
                    await refreshCallback();
                } catch (refreshError) {
                    console.warn('Refresh callback failed:', refreshError);
                    showTemporaryMessage('⚠️ List may need manual refresh to see updated name', 'warning');
                }
            } else if (!widget) {
                // Show success message for non-widget, non-picker contexts
                showTemporaryMessage(`✅ LoRA renamed to: ${finalNewName}.safetensors`, 'success');

                // If we have access to the dialog, refresh preview availability for blue dots
                const dialog = document.querySelector('.lora-picker-dialog');
                if (dialog && dialog.dialogInstance && dialog.dialogInstance.loadPreviewAvailability) {
                    try {
                        await dialog.dialogInstance.loadPreviewAvailability();
                        // Re-render list to update blue dots
                        if (dialog.dialogInstance.renderList) {
                            dialog.dialogInstance.renderList();
                        }
                    } catch (previewError) {
                        console.warn('Failed to refresh preview availability after rename:', previewError);
                    }
                }
            }
        } else {
            alert('Failed to rename LoRA: ' + (data.error || 'Unknown error'));
            console.error('Failed to rename LoRA:', data.error);
        }
    } catch (error) {
        alert('Error renaming LoRA: ' + error.message);
        console.error('Error renaming LoRA:', error);
    }
}