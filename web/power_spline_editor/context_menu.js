import { app } from '../../../scripts/app.js';
import { updateDrivenConfigValue, updateEasingConfigValue } from './persistence.js';
import { getLayerWidgetType, isLayerWidget } from './layer_widget_identity.js';

// Helper to create interactive number input with arrows and drag support
// For driven config (syncs to both driven and _drivenConfig)
function createNumberInput(widget, configObj, field, min, max, step, precision = 0) {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 2px !important;
        padding: 2px 2px !important;
        background-color: #1a1a1a !important;
        color: #aaa !important;
    `;

    // Left arrow
    const leftArrow = document.createElement('div');
    leftArrow.textContent = '◀';
    leftArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    leftArrow.onmouseover = () => leftArrow.style.color = '#fff';
    leftArrow.onmouseout = () => leftArrow.style.color = '#aaa';
    leftArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.max(min, configObj[field] - step);
        updateDrivenConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    // Number display (draggable and clickable)
    const numberDisplay = document.createElement('div');
    numberDisplay.textContent = configObj[field].toFixed(precision);
    numberDisplay.style.cssText = `
        min-width: 24px !important;
        text-align: center !important;
        cursor: ew-resize !important;
        user-select: none !important;
        outline: none !important;
        color: #ddd !important;
        font-size: 11px !important;
    `;

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startValue = 0;

    const onMouseMove = (e) => {
        if (isDragging) {
            e.stopPropagation();
            e.preventDefault();
            const deltaX = e.clientX - startX;
            // Only mark as dragged if movement exceeds threshold
            if (Math.abs(deltaX) > 3) {
                hasDragged = true;
            }
            const delta = Math.round(deltaX / 5) * step;
            const newValue = Math.max(min, Math.min(max, startValue + delta));
            updateDrivenConfigValue(widget, field, newValue);
            numberDisplay.textContent = newValue.toFixed(precision);
        }
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            numberDisplay.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onmousedown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 0) {
            isDragging = true;
            hasDragged = false;
            startX = e.clientX;
            startValue = configObj[field];
            numberDisplay.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onclick = (e) => {
        e.stopPropagation();
        // Only show prompt if user didn't drag
        if (!hasDragged) {
            const fieldLabel = field === 'd_scale' ? 'D Scale' : field.charAt(0).toUpperCase() + field.slice(1);
            app.canvas.prompt(fieldLabel, configObj[field], (v) => {
                const newValue = Math.max(min, Math.min(max, Number(v)));
                updateDrivenConfigValue(widget, field, newValue);
                numberDisplay.textContent = newValue.toFixed(precision);
            });
        }
        hasDragged = false;
    };

    // Right arrow
    const rightArrow = document.createElement('div');
    rightArrow.textContent = '▶';
    rightArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    rightArrow.onmouseover = () => rightArrow.style.color = '#fff';
    rightArrow.onmouseout = () => rightArrow.style.color = '#aaa';
    rightArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.min(max, configObj[field] + step);
        updateDrivenConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    container.appendChild(leftArrow);
    container.appendChild(numberDisplay);
    container.appendChild(rightArrow);

    return container;
}

// Helper to create interactive number input for easing config (syncs to easingConfig)
function createEasingNumberInput(widget, configObj, field, min, max, step, precision = 0) {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 2px !important;
        padding: 2px 2px !important;
        background-color: #1a1a1a !important;
        color: #aaa !important;
    `;

    // Left arrow
    const leftArrow = document.createElement('div');
    leftArrow.textContent = '◀';
    leftArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    leftArrow.onmouseover = () => leftArrow.style.color = '#fff';
    leftArrow.onmouseout = () => leftArrow.style.color = '#aaa';
    leftArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.max(min, configObj[field] - step);
        updateEasingConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    // Number display (draggable and clickable)
    const numberDisplay = document.createElement('div');
    numberDisplay.textContent = configObj[field].toFixed(precision);
    numberDisplay.style.cssText = `
        min-width: 24px !important;
        text-align: center !important;
        cursor: ew-resize !important;
        user-select: none !important;
        outline: none !important;
        color: #ddd !important;
        font-size: 11px !important;
    `;

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startValue = 0;

    const onMouseMove = (e) => {
        if (isDragging) {
            e.stopPropagation();
            e.preventDefault();
            const deltaX = e.clientX - startX;
            // Only mark as dragged if movement exceeds threshold
            if (Math.abs(deltaX) > 3) {
                hasDragged = true;
            }
            const delta = Math.round(deltaX / 5) * step;
            const newValue = Math.max(min, Math.min(max, startValue + delta));
            updateEasingConfigValue(widget, field, newValue);
            numberDisplay.textContent = newValue.toFixed(precision);
        }
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            numberDisplay.style.cursor = 'ew-resize';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onmousedown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 0) {
            isDragging = true;
            hasDragged = false;
            startX = e.clientX;
            startValue = configObj[field];
            numberDisplay.style.cursor = 'ew-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    };

    numberDisplay.onclick = (e) => {
        e.stopPropagation();
        // Only show prompt if user didn't drag
        if (!hasDragged) {
            const fieldLabel = field.charAt(0).toUpperCase() + field.slice(1);
            app.canvas.prompt(fieldLabel, configObj[field], (v) => {
                const newValue = Math.max(min, Math.min(max, Number(v)));
                updateEasingConfigValue(widget, field, newValue);
                numberDisplay.textContent = newValue.toFixed(precision);
            });
        }
        hasDragged = false;
    };

    // Right arrow
    const rightArrow = document.createElement('div');
    rightArrow.textContent = '▶';
    rightArrow.style.cssText = `
        cursor: pointer !important;
        user-select: none !important;
        padding: 0 1px !important;
        color: #aaa !important;
        font-size: 10px !important;
    `;
    rightArrow.onmouseover = () => rightArrow.style.color = '#fff';
    rightArrow.onmouseout = () => rightArrow.style.color = '#aaa';
    rightArrow.onclick = (e) => {
        e.stopPropagation();
        const newValue = Math.min(max, configObj[field] + step);
        updateEasingConfigValue(widget, field, newValue);
        numberDisplay.textContent = newValue.toFixed(precision);
    };

    container.appendChild(leftArrow);
    container.appendChild(numberDisplay);
    container.appendChild(rightArrow);

    return container;
}

// Helper to create text input field
function createTextInput(widget, configObj, field, placeholder = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = configObj[field] || '';
    input.placeholder = placeholder;
    input.style.cssText = `
        width: 100% !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        outline: none !important;
    `;
    input.onfocus = () => {
        input.style.borderColor = '#555';
        input.style.backgroundColor = '#222';
    };
    input.onblur = () => {
        input.style.borderColor = '#333';
        input.style.backgroundColor = '#1a1a1a';
    };
    input.oninput = (e) => {
        e.stopPropagation();
        // Use the centralized update function to ensure data is saved correctly
        updateDrivenConfigValue(widget, field, input.value);
    };
    input.onclick = (e) => e.stopPropagation();
    input.onmousedown = (e) => e.stopPropagation();

    return input;
}

// Function to display a custom HTML context menu with interactive inputs
export function showCustomDrivenToggleMenu(event, widget, position) {
    console.log("showCustomDrivenToggleMenu called.");
    // Stop native context menu if invoked from a right-click
    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-driven-toggle-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Work with the config object - either from driven (if on) or _drivenConfig (if off)
    // This ensures we preserve settings even when the toggle is off
    let configObj;
    if (widget.value.driven && typeof widget.value.driven === 'object') {
        // Driven is on - use the active config
        configObj = widget.value.driven;
    } else {
        // Driven is off - use the preserved config
        if (!widget.value._drivenConfig || typeof widget.value._drivenConfig !== 'object') {
            widget.value._drivenConfig = { driver: "", rotate: 0, d_scale: 1.0 };
        }
        configObj = widget.value._drivenConfig;
    }

    // Ensure all fields exist
    if (!configObj.driver) configObj.driver = "";
    if (typeof configObj.rotate !== 'number') configObj.rotate = 0;
    if (typeof configObj.d_scale !== 'number') configObj.d_scale = 1.0;

    const menu = document.createElement('div');
    menu.id = 'custom-driven-toggle-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 40}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 50 !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    // Create grid container
    const container = document.createElement('div');
    container.style.cssText = `
        display: grid !important;
        grid-template-columns: 1fr 0.5fr 0.5fr !important;
        grid-template-rows: auto auto !important;
        gap: 2px !important;
        width: 100% !important;
    `;

    // Helper to create header label
    const createHeader = (text) => {
        const header = document.createElement('div');
        header.textContent = text;
        header.style.cssText = `
            padding: 2px 4px !important;
            text-align: center !important;
            font-size: 11px !important;
            color: #888 !important;
            background-color: #1a1a1a !important;
            font-weight: normal !important;
        `;
        return header;
    };

    // Row 1: Headers
    container.appendChild(createHeader('Driver:'));
    container.appendChild(createHeader('Rotate:'));
    container.appendChild(createHeader('D_Scale:'));

    // Row 2: Interactive inputs
    const driverOptions = ["None", ...widget.parent.layerManager.getSplineWidgets()
        .map(w => w.value.name)
        .filter(name => name !== widget.value.name)];
    container.appendChild(createDropdown(driverOptions, configObj.driver || "None", widget, 'driver', updateDrivenConfigValue));
    container.appendChild(createNumberInput(widget, configObj, 'rotate', -360, 360, 1, 0));
    container.appendChild(createNumberInput(widget, configObj, 'd_scale', 0.0, 1.0, 0.01, 2));

    menu.appendChild(container);
    document.body.appendChild(menu);
    console.log("Menu appended to body, position:", position);

    // Prevent menu close and native context menu when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();
    menu.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); };

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding menu");
            menu.remove();
            document.removeEventListener('click', hideMenu);
            document.removeEventListener('contextmenu', hideMenu);
            document.removeEventListener('mousedown', hideMenu);
        }
    };

    // While menu is open, suppress browser context menu globally (capture)
    const preventBrowserMenu = (e) => { e.preventDefault(); };

    // Add listeners after a short delay to prevent immediate closure
    setTimeout(() => {
        document.addEventListener('click', hideMenu, true);
        document.addEventListener('contextmenu', hideMenu, true);
        document.addEventListener('mousedown', hideMenu, true);
        document.addEventListener('contextmenu', preventBrowserMenu, true);
    }, 100);

    // Ensure cleanup of global preventer when menu is removed
    const observer = new MutationObserver(() => {
        if (!document.getElementById('custom-driven-toggle-menu')) {
            document.removeEventListener('contextmenu', preventBrowserMenu, true);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: false });
}

// Helper to create a dropdown select element
function createDropdown(options, selectedValue, widget, field, updateCallback) {
    const select = document.createElement('select');
    select.style.cssText = `
        width: 100% !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        outline: none !important;
        cursor: pointer !important;
    `;
    select.onfocus = () => {
        select.style.borderColor = '#555';
        select.style.backgroundColor = '#222';
    };
    select.onblur = () => {
        select.style.borderColor = '#333';
        select.style.backgroundColor = '#1a1a1a';
    };
    select.onclick = (e) => e.stopPropagation();
    select.onmousedown = (e) => e.stopPropagation();
    select.onchange = (e) => {
        e.stopPropagation();
        if (updateCallback) {
            updateCallback(widget, field, select.value);
        }
    };

    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt === selectedValue) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    return select;
}

// Simple interpolation dropdown menu shown near click position
export function showInterpolationMenu(event, widget, position) {
    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}

    // Remove any existing menu
    const existing = document.getElementById('custom-interp-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'custom-interp-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 10}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 120px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        transform: translateX(-40%) !important;
    `;

    // Check if this is a box layer
    const isBoxLayer = widget.value && widget.value.type === 'box_layer';
    const options = isBoxLayer ? ['linear', 'basis'] : ['linear', 'cardinal', 'basis', 'points'];
    const current = isBoxLayer ? (widget.value.box_interpolation || 'linear') : (widget.value.interpolation || 'linear');

    const list = document.createElement('div');
    list.style.cssText = `
        display: flex !important;
        flex-direction: column !important;
        gap: 2px !important;
        padding: 2px !important;
    `;

    options.forEach(opt => {
        const item = document.createElement('div');
        item.textContent = opt;
        item.style.cssText = `
            padding: 4px 6px !important;
            cursor: pointer !important;
            color: ${opt === current ? '#fff' : '#ddd'} !important;
            background-color: ${opt === current ? '#333' : 'transparent'} !important;
        `;
        item.onmouseover = () => { item.style.backgroundColor = '#2a2a2a'; item.style.color = '#fff'; };
        item.onmouseout = () => { item.style.backgroundColor = (opt === current ? '#333' : 'transparent'); item.style.color = (opt === current ? '#fff' : '#ddd'); };
        item.onclick = (e) => {
            e.stopPropagation();
            const w = widget;
            // Check if this is a box layer to update the correct value field
            if (w.value && w.value.type === 'box_layer') {
                w.value.box_interpolation = opt;
            } else {
                w.value.interpolation = opt;
            }
            const node = w.parent;
            if (node?.layerManager?.getActiveWidget() === w && node.editor?.layerRenderer) {
                node.editor.layerRenderer.render();
            }
            node?.setDirtyCanvas?.(true, true);
            menu.remove();
        };
        list.appendChild(item);
    });
    menu.appendChild(list);
    document.body.appendChild(menu);

    // Prevent native context interactions inside
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();
    menu.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); };

    const hide = (e) => {
        if (menu && !menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', hide, true);
            document.removeEventListener('contextmenu', hide, true);
            document.removeEventListener('mousedown', hide, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('click', hide, true);
        document.addEventListener('contextmenu', hide, true);
        document.addEventListener('mousedown', hide, true);
    }, 50);
}

// Ref image selection dropdown menu
export function showRefSelectionMenu(event, widget, position, onSelect) {
    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}

    const existing = document.getElementById('ref-select-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'ref-select-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 10}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 140px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        transform: translateX(-40%) !important;
    `;

    const options = widget?._getRefOptions?.() || ['no_ref', 'ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
    const current = widget?.value?.ref_selection || 'no_ref';

    const list = document.createElement('div');
    list.style.cssText = `
        display: flex !important;
        flex-direction: column !important;
        gap: 2px !important;
        padding: 2px !important;
    `;

    options.forEach(opt => {
        const item = document.createElement('div');
        item.textContent = opt;
        item.style.cssText = `
            padding: 4px 6px !important;
            cursor: pointer !important;
            color: ${opt === current ? '#fff' : '#ddd'} !important;
            background-color: ${opt === current ? '#333' : 'transparent'} !important;
        `;
        item.onmouseover = () => { item.style.backgroundColor = '#2a2a2a'; item.style.color = '#fff'; };
        item.onmouseout = () => { item.style.backgroundColor = (opt === current ? '#333' : 'transparent'); item.style.color = (opt === current ? '#fff' : '#ddd'); };
        item.onclick = async (e) => {
            e.stopPropagation();
            if (typeof onSelect === 'function') {
                onSelect(opt);
            } else if (widget) {
                widget.value.ref_selection = opt;

                // Reload image dimensions from file when switching to a ref selection
                // This ensures we get the latest image data if the file was updated
                if (opt !== 'no_ref' && widget.value.ref_attachment?.entries) {
                    const parts = opt.split('_');
                    const idx = parts.length > 1 ? parseInt(parts[1], 10) : 1;
                    const arrayIndex = Number.isFinite(idx) ? Math.max(0, idx - 1) : 0;
                    const attachment = widget.value.ref_attachment.entries[arrayIndex];

                    if (attachment && attachment.path) {
                        // Reload dimensions from the actual image file
                        try {
                            const img = new Image();
                            const cacheBust = Date.now() + Math.random().toString(36).substring(2, 9);
                            const _extMatch = import.meta.url.match(/\/extensions\/([^/]+)\//);
                            const _extName = _extMatch ? _extMatch[1] : 'ComfyUI-SA-Nodes-QQ';
                            img.src = `/extensions/${_extName}/${attachment.path}?v=${cacheBust}`;
                            await new Promise((resolve, reject) => {
                                img.onload = () => {
                                    // Update attachment with fresh dimensions
                                    attachment.width = img.width;
                                    attachment.height = img.height;
                                    resolve();
                                };
                                img.onerror = (err) => reject(err);
                                // Timeout after 2 seconds
                                setTimeout(() => resolve(), 2000);
                            });
                        } catch (e) {
                            console.warn('Failed to reload image dimensions:', e);
                        }
                    }
                }

                widget.parent?.setDirtyCanvas?.(true, true);
                // Clear ref image cache to force reload with new selection
                widget.parent?.editor?.layerRenderer?.clearRefImageCache?.();
                // Force render to update the displayed reference image
                widget.parent?.editor?.layerRenderer?.render?.();
            }
            menu.remove();
        };
        list.appendChild(item);
    });

    menu.appendChild(list);
    document.body.appendChild(menu);

    const cleanup = (ev) => {
        const target = ev?.target;
        if (target && menu.contains(target)) return;
        menu.remove();
        document.removeEventListener('mousedown', cleanup, true);
        document.removeEventListener('contextmenu', cleanup, true);
        document.removeEventListener('keydown', onEsc, true);
    };
    const onEsc = (ev) => {
        if (ev.key === 'Escape') {
            menu.remove();
            document.removeEventListener('mousedown', cleanup, true);
            document.removeEventListener('contextmenu', cleanup, true);
            document.removeEventListener('keydown', onEsc, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('mousedown', cleanup, true);
        document.addEventListener('contextmenu', cleanup, true);
        document.addEventListener('keydown', onEsc, true);
    }, 0);
}

// Helper to create static number display (non-interactive for UI-only)
function createStaticNumberDisplay(value, min, max, precision = 1) {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 2px 3px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #333 !important;
        color: #ddd !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
        text-align: center !important;
    `;
    container.textContent = value.toFixed(precision);
    return container;
}

// Function to display a custom HTML context menu for easing configuration
export function showCustomEasingMenu(event, widget, position) {
    console.log("showCustomEasingMenu called.");
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-easing-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // Initialization is now handled by the widget's value setter.
    // We can rely on widget.value.easingConfig existing.
    const configObj = widget.value.easingConfig;

    // Ensure fields exist as a fallback.
    if (!configObj.path) configObj.path = "each";
    if (typeof configObj.strength !== 'number') configObj.strength = 1.0;

    const menu = document.createElement('div');
    menu.id = 'custom-easing-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y + 40}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 50 !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    // Create grid container (3 columns: Path | Strength | Accel)
    const container = document.createElement('div');
    container.style.cssText = `
        display: grid !important;
        grid-template-columns: 1fr 1fr 1fr !important;
        grid-template-rows: auto auto !important;
        gap: 2px !important;
        width: 100% !important;
    `;

    // Helper to create header label
    const createHeader = (text) => {
        const header = document.createElement('div');
        header.textContent = text;
        header.style.cssText = `
            padding: 2px 4px !important;
            text-align: center !important;
            font-size: 11px !important;
            color: #888 !important;
            background-color: #1a1a1a !important;
            font-weight: normal !important;
        `;
        return header;
    };

    // Row 1: Headers
    container.appendChild(createHeader('Path:'));
    container.appendChild(createHeader('Strength:'));
    container.appendChild(createHeader('Accel:'));

    // Row 2: Controls
    container.appendChild(createDropdown(['each', 'full', 'alternate'], configObj.path, widget, 'path', updateEasingConfigValue));
    container.appendChild(createEasingNumberInput(widget, configObj, 'strength', 0.0, 2.0, 0.1, 1));
    container.appendChild(createEasingNumberInput(widget, configObj, 'acceleration', -1.0, 1.0, 0.01, 2));

    menu.appendChild(container);
    document.body.appendChild(menu);
    console.log("Easing menu appended to body, position:", position);

    // Prevent menu close when interacting with inputs
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            console.log("Hiding easing menu");
            menu.remove();
            document.removeEventListener('click', hideMenu);
            document.removeEventListener('contextmenu', hideMenu);
            document.removeEventListener('mousedown', hideMenu);
        }
    };

    // Add listeners after a short delay to prevent immediate closure
    setTimeout(() => {
        document.addEventListener('click', hideMenu);
        document.addEventListener('contextmenu', hideMenu);
        document.addEventListener('mousedown', hideMenu);
    }, 100);
}

export function getSlotInPosition(canvasX, canvasY) {
    const slot = LGraphNode.prototype.getSlotInPosition?.call(this, canvasX, canvasY);
    if (!slot) {
        // Check if click is on a spline widget
        for (const widget of this.widgets || []) {
            if (!widget.last_y) continue;

            // Check if click Y is within this widget's bounds
            const widgetTop = this.pos[1] + widget.last_y;
            const widgetBottom = widgetTop + LiteGraph.NODE_WIDGET_HEIGHT;

            if (canvasY >= widgetTop && canvasY <= widgetBottom) {
                // Found the widget at this position
                const isSplineLike =
                    isLayerWidget(widget) ||
                    widget.name?.startsWith("spline_") ||
                    widget.name?.startsWith("box_");
                if (isSplineLike) {
                    // Use the actual hitAreas.drivenToggle.bounds from the widget
                    if (widget.hitAreas && widget.hitAreas.drivenToggle) {
                        const drivenToggleBounds = widget.hitAreas.drivenToggle.bounds;
                        // drivenToggleBounds is [posX, toggleBgWidth] relative to the widget's draw area
                        // We need to convert these to canvas coordinates

                        const toggleAbsXStart = this.pos[0] + drivenToggleBounds[0];
                        // Reduce the width of the hit area to be more precise - use the actual toggle width
                        // The toggle width is approximately height * 0.72 (toggle radius * 2)
                        const toggleWidth = LiteGraph.NODE_WIDGET_HEIGHT * 0.72;
                        const toggleAbsXEnd = toggleAbsXStart + toggleWidth;
                        const toggleAbsYStart = widgetTop; // The widget's top is the start Y
                        const toggleAbsYEnd = widgetBottom; // The widget's bottom is the end Y

                        if (canvasX >= toggleAbsXStart && canvasX <= toggleAbsXEnd &&
                            canvasY >= toggleAbsYStart && canvasY <= toggleAbsYEnd) {
                            return { widget: widget, output: { type: "DRIVEN_TOGGLE" } };
                        }
                    }

                    // Check for easing area (same pattern as driven toggle)
                    if (widget.hitAreas && widget.hitAreas.easingVal) {
                        const easingBounds = widget.hitAreas.easingVal.bounds;
                        // easingBounds is [posX, width] relative to the widget's draw area

                        const easingAbsXStart = this.pos[0] + easingBounds[0];
                        const easingAbsXEnd = easingAbsXStart + easingBounds[1];
                        const easingAbsYStart = widgetTop;
                        const easingAbsYEnd = widgetBottom;

                        if (canvasX >= easingAbsXStart && canvasX <= easingAbsXEnd &&
                            canvasY >= easingAbsYStart && canvasY <= easingAbsYEnd) {
                            return { widget: widget, output: { type: "EASING_AREA" } };
                        }
                    }
                }
                // If click is outside the toggle button, then select the spline widget
                return { widget: widget, output: { type: "SPLINE WIDGET" } };
            }
        }
    }
    return slot;
}

// Function to display custom HTML context menu for layer actions
export function showCustomLayerMenu(event, widget, node, position) {
    console.log("showCustomLayerMenu called.");
    // Stop native context menu if invoked from a right-click
    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}
    // Remove any existing custom menu to prevent duplicates
    const existingMenu = document.getElementById('custom-layer-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'custom-layer-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${position.x}px !important;
        top: ${position.y}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 120px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    const splineWidgets = node.widgets.filter(w =>
        isLayerWidget(w) ||
        w.name?.startsWith("spline_") ||
        w.name?.startsWith("box_")
    );
    const splineIndex = splineWidgets.indexOf(widget);
    const isBoxLayerWidget = getLayerWidgetType(widget) === 'box_layer' || widget.name?.startsWith("box_");
    const canMoveUp = splineIndex > 0;
    const canMoveDown = splineIndex < splineWidgets.length - 1;

    // Helper to create menu item
    const createMenuItem = (icon, text, onClick, disabled = false) => {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 4px 8px !important;
            cursor: ${disabled ? 'default' : 'pointer'} !important;
            color: ${disabled ? '#555' : '#ddd'} !important;
            background-color: #1a1a1a !important;
            user-select: none !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        `;

        if (!disabled) {
            item.onmouseover = () => {
                item.style.backgroundColor = '#2a2a2a';
            };
            item.onmouseout = () => {
                item.style.backgroundColor = '#1a1a1a';
            };
            item.onclick = (e) => {
                e.stopPropagation();
                onClick();
                menu.remove();
                document.removeEventListener('click', hideMenu);
                document.removeEventListener('contextmenu', hideMenu);
                document.removeEventListener('mousedown', hideMenu);
            };
        }

        const iconSpan = document.createElement('span');
        iconSpan.textContent = icon;
        iconSpan.style.cssText = `
            font-size: 12px !important;
            width: 16px !important;
            text-align: center !important;
        `;

        const textSpan = document.createElement('span');
        textSpan.textContent = text;

        item.appendChild(iconSpan);
        item.appendChild(textSpan);

        return item;
    };

    // Helper to create separator
    const createSeparator = () => {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px !important;
            background-color: #333 !important;
            margin: 2px 0 !important;
        `;
        return separator;
    };

    // Add menu items
    menu.appendChild(createMenuItem('✏️', 'Rename', () => {
        const canvas = app.canvas;
        // Ensure value container exists to avoid null access after refresh
        if (!widget.value) widget.value = {};
        const currentName = widget.value?.name || "Spline";
        canvas.prompt("Spline Name", currentName, (v) => {
            const newName = v || "Spline";
            const otherSplineWidgets = node.widgets.filter(w => w !== widget && w.name?.startsWith("spline_"));
            const existingNames = otherSplineWidgets.map(w => w?.value?.name).filter(n => !!n);
            const oldName = widget.value.name; // Store old name before changing
            widget.value.name = node.generateUniqueName(newName, existingNames);

            // Update driver references in other layers that were using this layer as a driver
            if (oldName && oldName !== widget.value.name) {
                node.widgets.forEach(w => {
                    if (w !== widget && w.name?.startsWith("spline_") && w.value) {
                        // Check both active driven config and preserved config
                        let needsUpdate = false;

                        // Check active driven config
                        if (w.value.driven && w.value.driven.driver === oldName) {
                            w.value.driven.driver = widget.value.name;
                            needsUpdate = true;
                        }

                        // Check preserved driven config (when toggle is off)
                        if (w.value._drivenConfig && w.value._drivenConfig.driver === oldName) {
                            w.value._drivenConfig.driver = widget.value.name;
                            needsUpdate = true;
                        }

                        // Log the update for debugging
                        if (needsUpdate) {
                            console.log(`Updated driver reference in layer "${w.value.name}" from "${oldName}" to "${widget.value.name}"`);
                        }
                    }
                });
            }

            node.setDirtyCanvas(true, true);
        });
    }));

    menu.appendChild(createSeparator());

    // Safely read/initialize toggle state
    const isOn = !!(widget.value && widget.value.on);
    menu.appendChild(createMenuItem(
        isOn ? '⚫' : '🟢',
        isOn ? 'Toggle Off' : 'Toggle On',
        () => {
            if (!widget.value) widget.value = {};
            if (typeof widget.value.on !== 'boolean') widget.value.on = false;
            widget.value.on = !widget.value.on;
            node.setDirtyCanvas(true, true);
        }
    ));

    menu.appendChild(createMenuItem('⬆️', 'Move Up', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(splineWidgets[splineIndex - 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveUp));

    menu.appendChild(createMenuItem('⬇️', 'Move Down', () => {
        const index = node.widgets.indexOf(widget);
        const otherIndex = node.widgets.indexOf(splineWidgets[splineIndex + 1]);
        const temp = node.widgets[otherIndex];
        node.widgets[otherIndex] = widget;
        node.widgets[index] = temp;
        node.setDirtyCanvas(true, true);
    }, !canMoveDown));

    if (isBoxLayerWidget) {
        const hasPoints = Array.isArray(widget.value?.box_keys) && widget.value.box_keys.length > 0;
        menu.appendChild(createMenuItem('[]', 'Clear All Points', () => {
            widget.onClearAllClick?.(event ?? null, null, node);
            node?.setDirtyCanvas?.(true, true);
        }, !hasPoints));
    }

    menu.appendChild(createMenuItem('🗑️', 'Remove', () => {
        node.layerManager.removeSpline(widget);
    }));


    document.body.appendChild(menu);
    console.log("Layer menu appended to body, position:", position);

    // Prevent menu close and native context menu when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();
    menu.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); };

    // Hide menu when clicking outside (but ignore clicks inside LiteGraph prompt/dialogs)
    const hideMenu = (e) => {
        const target = e && e.target;
        const withinDialog = target && (target.closest?.('.litegraph .dialog') || target.closest?.('.litegraph.liteprompt') || target.closest?.('.litedialog'));
        if (withinDialog) {
            return; // keep menu open while interacting with prompt
        }
        if (menu && !menu.contains(target)) {
            console.log("Hiding layer menu");
            menu.remove();
            document.removeEventListener('click', hideMenu, true);
            document.removeEventListener('contextmenu', hideMenu, true);
            document.removeEventListener('mousedown', hideMenu, true);
        }
    };

    // While menu is open, suppress browser context menu globally (capture)
    const preventBrowserMenu = (e) => { e.preventDefault(); };

    // Add listeners after a short delay to prevent immediate closure
    setTimeout(() => {
        // Use capture so we can filter early and not propagate into generic closers
        document.addEventListener('click', hideMenu, true);
        document.addEventListener('contextmenu', hideMenu, true);
        document.addEventListener('mousedown', hideMenu, true);
        document.addEventListener('contextmenu', preventBrowserMenu, true);
    }, 100);

    // Ensure cleanup of global preventer when menu is removed
    const observer = new MutationObserver(() => {
        if (!document.getElementById('custom-layer-menu')) {
            document.removeEventListener('contextmenu', preventBrowserMenu, true);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: false });
}

export function getSlotMenuOptions(slot, event) {
    // Prevent native context menu when we will show custom ones
    try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch {}
    // Check if the slot is specifically for the DRIVEN_TOGGLE
    if (slot?.output?.type === "DRIVEN_TOGGLE") {
        // Get position from canvas - LiteGraph stores the last pointer position
        const canvas = app.canvas;

        // Try multiple ways to get the screen position
        let x = 100;
        let y = 100;

        // Option 1: Try to get from last_mouse_position (canvas screen coords)
        if (canvas.last_mouse_position) {
            x = canvas.last_mouse_position[0];
            y = canvas.last_mouse_position[1];
        }
        // Option 2: Try canvas_mouse (might be available)
        else if (canvas.canvas_mouse) {
            x = canvas.canvas_mouse[0];
            y = canvas.canvas_mouse[1];
        }
        // Option 3: Convert graph coordinates to screen coordinates
        else if (canvas.graph_mouse && canvas.ds) {
            const graphX = canvas.graph_mouse[0];
            const graphY = canvas.graph_mouse[1];
            // Convert from graph space to canvas space
            x = graphX * canvas.ds.scale + canvas.ds.offset[0];
            y = graphY * canvas.ds.scale + canvas.ds.offset[1];
            // Convert from canvas space to screen space
            const canvasRect = canvas.canvas.getBoundingClientRect();
            x += canvasRect.left;
            y += canvasRect.top;
        }

        console.log("Menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomDrivenToggleMenu(event, slot.widget, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    // Check if the slot is specifically for the EASING_AREA
    if (slot?.output?.type === "EASING_AREA") {
        // Get position from canvas - same logic as driven toggle
        const canvas = app.canvas;

        // Try multiple ways to get the screen position
        let x = 100;
        let y = 100;

        // Option 1: Try to get from last_mouse_position (canvas screen coords)
        if (canvas.last_mouse_position) {
            x = canvas.last_mouse_position[0];
            y = canvas.last_mouse_position[1];
        }
        // Option 2: Try canvas_mouse (might be available)
        else if (canvas.canvas_mouse) {
            x = canvas.canvas_mouse[0];
            y = canvas.canvas_mouse[1];
        }
        // Option 3: Convert graph coordinates to screen coordinates
        else if (canvas.graph_mouse && canvas.ds) {
            const graphX = canvas.graph_mouse[0];
            const graphY = canvas.graph_mouse[1];
            // Convert from graph space to canvas space
            x = graphX * canvas.ds.scale + canvas.ds.offset[0];
            y = graphY * canvas.ds.scale + canvas.ds.offset[1];
            // Convert from canvas space to screen space
            const canvasRect = canvas.canvas.getBoundingClientRect();
            x += canvasRect.left;
            y += canvasRect.top;
        }

        console.log("Easing menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomEasingMenu(event, slot.widget, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    // Check if the slot is for a spline widget (layer right-click)
    const widget = slot?.widget;
    const isLayer = widget &&
        (isLayerWidget(widget) ||
            widget.name?.startsWith("spline_") ||
            widget.name?.startsWith("box_"));

    if (isLayer) {
        const canvas = app.canvas;

        // Try multiple ways to get the screen position
        let x = 100;
        let y = 100;

        // Option 1: Try to get from last_mouse_position (canvas screen coords)
        if (canvas.last_mouse_position) {
            x = canvas.last_mouse_position[0];
            y = canvas.last_mouse_position[1];
        }
        // Option 2: Try canvas_mouse (might be available)
        else if (canvas.canvas_mouse) {
            x = canvas.canvas_mouse[0];
            y = canvas.canvas_mouse[1];
        }
        // Option 3: Convert graph coordinates to screen coordinates
        else if (canvas.graph_mouse && canvas.ds) {
            const graphX = canvas.graph_mouse[0];
            const graphY = canvas.graph_mouse[1];
            // Convert from graph space to canvas space
            x = graphX * canvas.ds.scale + canvas.ds.offset[0];
            y = graphY * canvas.ds.scale + canvas.ds.offset[1];
            // Convert from canvas space to screen space
            const canvasRect = canvas.canvas.getBoundingClientRect();
            x += canvasRect.left;
            y += canvasRect.top;
        }

        console.log("Layer menu position calculated:", {x, y});

        // Use a slight delay to ensure the menu shows after the event completes
        setTimeout(() => {
            showCustomLayerMenu(event, widget, this, { x, y });
        }, 10);

        // Return false to prevent LiteGraph from showing its default menu
        return false;
    }

    return LGraphNode.prototype.getSlotMenuOptions?.call(this, slot);
}
