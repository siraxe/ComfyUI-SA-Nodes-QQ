import { app } from "../../../scripts/app.js";

// Import batch fetch service
import { batchFetchService } from "./batch_fetch_service.js";
import { renameLoRAFiles } from "./rename_utils.js";
import { CHECKPOINT_INFO_SERVICE } from "./model_info_service.js";

// Function to show context menu for LoRA list items
function showLoraListContextMenu(event, loraName) {
    // Remove any existing context menu
    const existingMenu = document.getElementById('lora-list-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'lora-list-context-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${event.clientX}px !important;
        top: ${event.clientY}px !important;
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

    // Helper to create menu item
    const createMenuItem = (icon, text, onClick) => {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 4px 8px !important;
            cursor: pointer !important;
            color: #ddd !important;
            background-color: #1a1a1a !important;
            user-select: none !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        `;

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
        };

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

    // Function to show LoRA in Windows Explorer
    const showInExplorer = (loraName) => {
        // Use the ComfyUI API to open Explorer for the LoRA file
        fetch('/wanvideo_wrapper/open_explorer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ lora_name: loraName })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
            } else {
                console.error('Failed to open Explorer:', data.error || 'Unknown error');
            }
        })
        .catch(error => {
            console.error('Error opening Explorer:', error);
        });
    };

    // Check if we're in model mode by accessing the dialog instance
    const dialogElement = document.querySelector('.lora-picker-dialog');
    const dialogInstance = dialogElement && dialogElement.dialogInstance;
    const isModelMode = dialogInstance && dialogInstance.options && dialogInstance.options.isModelMode;

    // Add menu items
    menu.appendChild(createMenuItem('ℹ️', 'Show Info', () => {
        if (isModelMode) {
            showModelInfoDialog(loraName);
        } else {
            showLoraInfoDialog(loraName);
        }
    }));

    menu.appendChild(createMenuItem('📁', 'Show in Explorer', () => {
        if (isModelMode) {
            // For models, use the same API but the function is in power_model_loader_v2.js
            fetch('/wanvideo_wrapper/open_explorer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ lora_name: loraName }) // API expects lora_name but works for models too
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                } else {
                    console.error('Failed to open Explorer for model:', data.error || 'Unknown error');
                }
            })
            .catch(error => {
                console.error('Error opening Explorer for model:', error);
            });
        } else {
            showInExplorer(loraName);
        }
    }));

    menu.appendChild(createMenuItem('✏️', 'Rename', () => {
        // Use the same dialog instance to create refresh callback
        const refreshCallback = (dialogInstance && dialogInstance.refreshCallback)
            ? dialogInstance.refreshCallback
            : null;

        if (isModelMode) {
            // For models, we can use renameLoRAFiles with a different variant name
            // or create a model-specific rename function if needed
            renameLoRAFiles(loraName, 'model', refreshCallback);
        } else {
            renameLoRAFiles(loraName, 'high', refreshCallback);
        }
    }));

    document.body.appendChild(menu);

    // Prevent menu close when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
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

// Function to show LoRA info dialog
function showLoraInfoDialog(loraName) {
    // Import and show the LoRA info dialog
    import("./dialog_info.js").then(({ WanLoraInfoDialog }) => {
        const infoDialog = new WanLoraInfoDialog(loraName).show();
        // Store the item type for use in preview generation
        infoDialog.itemType = 'loras';
        infoDialog.addEventListener("close", ((e) => {
            if (e.detail.dirty) {
                // Dialog was modified, could trigger refresh if needed
            }
        }));
    }).catch(error => {
        // Fallback to simple alert if dialog fails to load
        console.error("Failed to load LoRA info dialog:", error);
        const loraInfo = `LoRA Information:

File: ${loraName}`;
        alert(loraInfo);
    });
}

// Function to show Model info dialog using the same simple approach as LoRA widgets
function showModelInfoDialog(modelName) {
    if (!modelName || modelName === "None") {
        app.ui.dialog.show("No model selected");
        return;
    }


    // Import the dialog dynamically and create a model-specific info dialog
    import("./dialog_info.js").then(({ WanLoraInfoDialog }) => {
        // Create a model-specific info dialog by extending WanLoraInfoDialog
        class WanModelInfoDialog extends WanLoraInfoDialog {
            async getModelInfo(file) {
                try {
                    const info = await CHECKPOINT_INFO_SERVICE.getInfo(file, false, false);
                    return info;
                } catch (error) {
                    console.error(`[LoraPickerDialog] Error fetching model info:`, error);
                    // Fallback to basic info
                    return {
                        file: file,
                        name: file,
                        info: {},
                        mtime: Date.now() / 1000
                    };
                }
            }

            // Override refreshModelInfo to use CHECKPOINT_INFO_SERVICE instead of LORA_INFO_SERVICE
            async refreshModelInfo(file) {
                try {
                    const info = await CHECKPOINT_INFO_SERVICE.refreshInfo(file);
                    return info;
                } catch (error) {
                    console.error(`[LoraPickerDialog] Error refreshing model info from Civitai:`, error);
                    // Return existing info on error instead of failing
                    return this.modelInfo || {
                        file: file,
                        name: file,
                        info: {},
                        mtime: Date.now() / 1000
                    };
                }
            }

            // Override the save method to use CHECKPOINT_INFO_SERVICE
            async savePartialInfo(info, fieldName, newValue) {
                try {
                    await CHECKPOINT_INFO_SERVICE.savePartialInfo(info.file, { [fieldName]: newValue });
                    return true;
                } catch (error) {
                    console.error(`[LoraPickerDialog] Error saving model info:`, error);
                    return false;
                }
            }
        }

        // Create and show the dialog
        const dialog = new WanModelInfoDialog(modelName);
        // Store the item type for use in preview generation
        dialog.itemType = 'checkpoints';
        dialog.show();
    }).catch(error => {
        // Fallback to simple alert if dialog fails to load
        console.error("Failed to load model info dialog:", error);
        const modelInfo = `Model Information:\n\nFile: ${modelName}`;
        alert(modelInfo);
    });
}



const style = document.createElement('style');
style.textContent = `
.lora-picker-dialog {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translate(-50%, 0);
    background-color: #1a1a1a !important;
    border: 1px solid #000 !important;
    box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
    z-index: 10000 !important;
    padding: 10px !important;
    border-radius: 0px !important;
    width: calc(25vw + 150px + 200px) !important; /* Width + sidebar width + preview width */
    min-width: 750px; /* Increased min-width for preview */
    max-height: 80vh;
    display: flex !important;
    flex-direction: column !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    color: #ddd !important;
    overflow: hidden !important;
}

.lora-picker-content-wrapper {
    display: flex !important;
    flex: 1 !important;
    overflow: hidden !important;
}

.lora-picker-sidebar {
    width: 150px !important; /* Will be updated dynamically */
    background-color: #222 !important;
    border-right: 1px solid #000 !important;
    flex-shrink: 0 !important;
    display: flex !important;
    flex-direction: column !important;
    transition: width 0.2s ease !important;
}

.lora-picker-sidebar.collapsed {
    width: 0 !important;
    overflow: hidden !important;
}

.lora-picker-sidebar-content {
    flex: 1 !important;
    overflow-y: auto !important;
    padding: 2px 0px !important;
}

.lora-picker-folder-item {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    padding: 2px 4px !important;
    cursor: pointer !important;
    border-radius: 0px !important;
    transition: background-color 0.2s !important;
    margin: 0 !important;
    border-left: 2px solid transparent !important;
    border-right: 2px solid transparent !important;
}

.lora-picker-folder-item:hover {
    background-color: #333 !important;
}

.lora-picker-folder-item.selected {
    background-color: #2a2a2a !important;
    border-left: 2px solid #89B !important;
    border-right: 2px solid #89B !important;
}

.lora-picker-folder-icon {
    font-size: 12px !important;
    margin-right: 4px !important;
    color: #89B !important;
    flex-shrink: 0 !important;
}

.lora-picker-folder-name {
    font-size: 11px !important;
    text-align: left !important;
    color: #ddd !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    user-select: none !important;
    flex: 1 !important;
}

.lora-picker-folder-arrow {
    font-size: 9px !important;
    color: #999 !important;
    margin-left: auto !important;
    margin-right: 2px !important;
    padding: 1px 4px !important;
    cursor: pointer !important;
    user-select: none !important;
    flex-shrink: 0 !important;
    border-radius: 2px !important;
    transition: color 0.2s !important;
}

.lora-picker-folder-arrow:hover {
    color: #fff !important;
    background-color: #3a3a3a !important;
}

.lora-picker-subfolder-item {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    padding: 2px 4px 2px 18px !important;
    cursor: pointer !important;
    border-radius: 0px !important;
    transition: background-color 0.2s !important;
    margin: 0 !important;
    border-left: 2px solid transparent !important;
    border-right: 2px solid transparent !important;
}

.lora-picker-subfolder-item:hover {
    background-color: #333 !important;
}

.lora-picker-subfolder-item.selected {
    background-color: #2a2a2a !important;
    border-left: 2px solid #89B !important;
    border-right: 2px solid #89B !important;
}

.lora-picker-subfolder-icon {
    font-size: 10px !important;
    margin-right: 4px !important;
    color: #89B !important;
    flex-shrink: 0 !important;
}

.lora-picker-subfolder-name {
    font-size: 10px !important;
    text-align: left !important;
    color: #bbb !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    user-select: none !important;
    flex: 1 !important;
}

.lora-picker-main-content {
    flex: 1 !important;
    display: flex !important;
    flex-direction: column !important;
    overflow: hidden !important;
}

.lora-picker-header {
    display: flex !important;
    gap: 10px !important;
    margin-bottom: 10px !important;
}

.lora-picker-search-container {
    position: relative !important;
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
}

.lora-picker-header input {
    width: 100% !important;
    padding: 4px 30px 4px 6px !important;
    background-color: #1a1a1a !important;
    border: 1px solid #333 !important;
    color: #ddd !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    outline: none !important;
}

.lora-picker-clear-button {
    position: absolute !important;
    right: 6px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    width: 16px !important;
    height: 16px !important;
    background: none !important;
    color: #888 !important;
    border: none !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 14px !important;
    font-weight: normal !important;
    user-select: none !important;
}

.lora-picker-clear-button:hover {
    color: #aaa !important;
}

.lora-picker-clear-button:active {
    color: #666 !important;
}

.lora-picker-header select {
    width: 80px !important;
    padding: 4px 6px !important;
    background-color: #1a1a1a !important;
    border: 1px solid #333 !important;
    color: #ddd !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    outline: none !important;
}

.lora-picker-header input:focus, .lora-picker-header select:focus {
    border-color: #555 !important;
    background-color: #222 !important;
}

.lora-picker-content {
    display: flex !important;
    flex-direction: column !important;
    height: calc(100% - 40px) !important; /* Account for header height */
    overflow: hidden !important;
}

.lora-picker-folder-area {
    background-color: #222 !important;
    border: 1px solid #333 !important;
    padding: 8px !important;
    margin-bottom: 8px !important;
    overflow-y: auto !important;
    display: none !important;
    height: 100px !important; /* Fixed height in pixels */
    flex-shrink: 0 !important;
}

.lora-picker-folder-area.visible {
    display: block !important;
}

.lora-picker-folder-grid {
    display: grid !important;
    grid-template-columns: repeat(5, 1fr) !important;
    gap: 8px !important;
    padding: 4px !important;
    min-height: 0 !important;
}


.lora-picker-list-container {
    flex: 1 !important;
    overflow: hidden !important;
    min-height: 0 !important;
    display: flex !important;
    flex-direction: column !important;
}

.lora-picker-list {
    list-style: none !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow-y: auto !important;
    height: 100% !important;
    flex: 1 !important;
}

.lora-picker-list li {
    padding: 6px 8px !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    user-select: none !important;
}

.lora-picker-list li:hover {
    background-color: #2a2a2a !important;
}

.lora-picker-list .favorite-star {
    cursor: pointer !important;
    font-size: 16px !important;
    user-select: none !important;
}

.lora-picker-preview-area {
    position: fixed;
    top: 20%; /* Same as dialog top */
    right: 0px;
    width: 200px;
    min-height: auto; /* Let content determine height */
    background-color: #1a1a1a !important;
    border: none !important; /* Remove blue outline */
    z-index: 10001 !important;
    padding: 8px !important;
    display: none !important;
    flex-direction: column !important;
    font-family: Arial, sans-serif !important;
    font-size: 11px !important;
    color: #ddd !important;
    transition: transform 0.2s ease !important;
    transform: translateX(100%);
}

.lora-picker-preview-area.visible {
    display: flex !important;
    transform: translateX(200px);
}

.lora-picker-preview-images-container {
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
    margin-bottom: 8px !important;
    width: 100% !important;
    max-height: 600px !important; /* 3 images * 200px each + gaps */
    overflow-y: auto !important;
}

.lora-picker-preview-image {
    width: 100% !important;
    height: auto !important;
    max-height: 180px !important; /* Slightly smaller for multiple images */
    object-fit: contain !important;
    border: 1px solid #333 !important;
    border-radius: 4px !important;
    flex-shrink: 0 !important;
}

.lora-picker-preview-info {
    flex: 1 !important;
    overflow-y: auto !important;
}

.lora-picker-preview-name {
    font-weight: bold !important;
    margin-bottom: 4px !important;
    word-break: break-all !important;
}

.lora-picker-preview-status {
    color: #aaa !important;
    font-size: 11px !important;
}

.lora-picker-preview-indicator {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 8px !important;
    height: 8px !important;
    background-color: #4488bb !important;
    border-radius: 50% !important;
    margin-left: auto !important;
    margin-right: 2px !important;
    flex-shrink: 0 !important;
}

.lora-picker-preview-image-container {
    position: relative !important;
    display: inline-block !important;
    width: 100% !important;
}

.lora-picker-copy-button {
    position: absolute !important;
    top: 4px !important;
    left: 4px !important;
    z-index: 10 !important;
    cursor: pointer !important;
    border: 1px solid #000 !important;
    border-radius: 0px !important;
    background: rgba(26, 26, 26, 0.9) !important;
    color: #ddd !important;
    font-family: Arial, sans-serif !important;
    font-size: 9px !important;
    line-height: 1 !important;
    white-space: nowrap !important;
    text-decoration: none !important;
    margin: 0 !important;
    box-shadow: none !important;
    transition: all 0.1s ease-in-out !important;
    padding: 2px 4px !important;
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: center !important;
    opacity: 0.8 !important;
}

.lora-picker-copy-button:hover {
    background: rgba(42, 42, 42, 0.95) !important;
    opacity: 1 !important;
}

.lora-picker-copy-button:active {
    background: rgba(34, 34, 34, 0.95) !important;
}
`;
document.head.appendChild(style);

// Persistence functions for favorites only state
function saveFavoritesOnly(favoritesOnly) {
    localStorage.setItem("wanVideoPowerLoraLoader.favoritesOnly", JSON.stringify(favoritesOnly));
}

function loadFavoritesOnly() {
    const favoritesOnly = localStorage.getItem("wanVideoPowerLoraLoader.favoritesOnly");
    return favoritesOnly !== null ? JSON.parse(favoritesOnly) : false;
}

// Persistence functions for folder toggle state
function saveFoldersVisible(foldersVisible) {
    localStorage.setItem("wanVideoPowerLoraLoader.foldersVisible", JSON.stringify(foldersVisible));
}

function loadFoldersVisible() {
    const foldersVisible = localStorage.getItem("wanVideoPowerLoraLoader.foldersVisible");
    return foldersVisible !== null ? JSON.parse(foldersVisible) : false;
}

// Persistence functions for selected folder
function saveSelectedFolder(selectedFolder) {
    localStorage.setItem("wanVideoPowerLoraLoader.selectedFolder", JSON.stringify(selectedFolder));
}

function loadSelectedFolder() {
    const selectedFolder = localStorage.getItem("wanVideoPowerLoraLoader.selectedFolder");
    return selectedFolder !== null ? JSON.parse(selectedFolder) : null;
}

// Persistence functions for selected subfolder
function saveSelectedSubfolder(selectedSubfolder) {
    localStorage.setItem("wanVideoPowerLoraLoader.selectedSubfolder", JSON.stringify(selectedSubfolder));
}

function loadSelectedSubfolder() {
    const selectedSubfolder = localStorage.getItem("wanVideoPowerLoraLoader.selectedSubfolder");
    return selectedSubfolder !== null ? JSON.parse(selectedSubfolder) : null;
}

// Persistence functions for eye refresh button state
function saveEyeRefreshState(eyeRefreshState) {
    localStorage.setItem("wanVideoPowerLoraLoader.eyeRefreshState", JSON.stringify(eyeRefreshState));
}

function loadEyeRefreshState() {
    const eyeRefreshState = localStorage.getItem("wanVideoPowerLoraLoader.eyeRefreshState");
    return eyeRefreshState !== null ? JSON.parse(eyeRefreshState) : false;
}

function saveAllUIState(dialog) {
    const uiState = {
        foldersVisible: dialog.options.foldersVisible,
        eyeRefreshState: dialog.eyeRefreshState,
        selectedFolder: dialog.selectedFolder,
        selectedSubfolder: dialog.selectedSubfolder || null,
        circleIconState: dialog.circleIconState
    };

    saveFoldersVisible(dialog.options.foldersVisible);
    saveEyeRefreshState(dialog.eyeRefreshState);
    saveSelectedFolder(dialog.selectedFolder);
    saveSelectedSubfolder(dialog.selectedSubfolder || null);

    if (dialog.parentNode && dialog.parentNode.widgets) {
        // Try both widget names to support both node types
        let uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "pll_ui_state");
        if (!uiStateWidget) {
            uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "ui_state");
        }
        if (uiStateWidget) {
            const stateString = JSON.stringify(uiState);
            uiStateWidget.value = stateString;
            if (typeof app !== 'undefined' && app.graph) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
    }
}

function loadAllUIState(dialog) {
    let uiState = {
        foldersVisible: undefined,
        eyeRefreshState: undefined,
        selectedFolder: undefined,
        selectedSubfolder: undefined,
        circleIconState: undefined
    };

    if (dialog.parentNode && dialog.parentNode.widgets) {
        // Try both widget names to support both node types
        let uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "pll_ui_state");
        if (!uiStateWidget) {
            uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "ui_state");
        }
        if (uiStateWidget && uiStateWidget.value) {
            try {
                uiState = JSON.parse(uiStateWidget.value);
            } catch (e) {
                console.warn("Failed to parse UI state from workflow:", e);
            }
        }
    }

    if (uiState.foldersVisible === undefined) {
        uiState.foldersVisible = loadFoldersVisible();
    }
    if (uiState.eyeRefreshState === undefined) {
        uiState.eyeRefreshState = loadEyeRefreshState();
    }
    if (uiState.selectedFolder === undefined) {
        uiState.selectedFolder = loadSelectedFolder();
    }
    if (uiState.selectedSubfolder === undefined) {
        uiState.selectedSubfolder = loadSelectedSubfolder();
    }
    if (uiState.circleIconState === undefined) {
        uiState.circleIconState = 0; // Default to 0 (empty circle)
    }

    dialog.options.foldersVisible = uiState.foldersVisible !== false;
    dialog.eyeRefreshState = uiState.eyeRefreshState || false;
    dialog.selectedFolder = uiState.selectedFolder || null;
    dialog.selectedSubfolder = uiState.selectedSubfolder || null;
    dialog.circleIconState = uiState.circleIconState || 0;

    if (dialog.parentNode && dialog.parentNode.widgets) {
        // Try both widget names to support both node types
        let uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "pll_ui_state");
        if (!uiStateWidget) {
            uiStateWidget = dialog.parentNode.widgets.find(w => w.name === "ui_state");
        }
        if (uiStateWidget && (uiState.foldersVisible !== undefined || uiState.eyeRefreshState !== undefined || uiState.selectedFolder !== undefined || uiState.circleIconState !== undefined)) {
            saveAllUIState(dialog);
        }
    }

    return uiState;
}

export class LoraPickerDialog {
    constructor(loras, options = {}) {
        // Filter out any "None" entries from the loras list
        this.loras = (loras || []).filter(l => {
            const name = typeof l === 'string' ? l : l.name;
            return name && name.toLowerCase() !== "none";
        });
        this.options = options;
        this.element = null;
        this.refreshCallback = options.refreshCallback || null;
        this.parentNode = options.parentNode || null;

        this.sidebarWidth = 150;

        // Subfolder support state (must exist before loadAllUIState restores it)
        this.expandedFolders = new Set();
        this.selectedSubfolder = null;

        loadAllUIState(this);

        // Initialize circle icon state if not already set
        this.circleIconState = this.circleIconState || 0;

        if (this.options.favoritesOnly === undefined) {
            this.options.favoritesOnly = loadFavoritesOnly();
        }

        this.previewArea = null;
        this.previewImage = null;
        this.previewName = null;
        this.previewStatus = null;
        this.currentPreviewTimeout = null;
        this.currentPreviewLora = null;
        this.previewAvailabilityCache = new Set();
        this.folders = this.extractFolders();

        // Note: Don't call loadPreviewAvailability() here - it will be called in show() method
        // This prevents race conditions and ensures proper async loading
    }

    getCircleIconSymbol() {
        // Returns the circle symbol based on current state (0: empty, 1: half, 2: full)
        switch(this.circleIconState) {
            case 0:
                return "◎"; // Empty circle with dot
            case 1:
                return "◐"; // Half circle (left half filled)
            case 2:
                return "◑"; // Half circle (right half filled)
            default:
                return "◎"; // Default to empty circle with dot
        }
    }

    show() {

        // Create overlay
        this.overlay = document.createElement("div");
        this.overlay.className = "lora-picker-overlay";
        this.overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 999;
        `;
        this.overlay.addEventListener("click", () => this.close());
        document.body.appendChild(this.overlay);

        // Create dialog element
        this.element = document.createElement("div");
        this.element.className = "lora-picker-dialog";

        // Create preview area
        this.createPreviewArea();

        // Add header
        const header = this.createHeader();
        this.element.appendChild(header);

        // Create content wrapper with sidebar and main content
        const contentWrapper = document.createElement("div");
        contentWrapper.className = "lora-picker-content-wrapper";
        
        // Create sidebar
        this.sidebar = document.createElement("div");
        this.sidebar.className = "lora-picker-sidebar";
        if (!this.options.foldersVisible) {
            this.sidebar.classList.add("collapsed");
        }
        
        // Set dynamic width
        this.sidebar.style.width = this.options.foldersVisible ? `${this.sidebarWidth}px` : '0px';
        
        // Create sidebar content with folders (no header)
        const sidebarContent = document.createElement("div");
        sidebarContent.className = "lora-picker-sidebar-content";
        this.renderFoldersInSidebar(sidebarContent);
        this.sidebar.appendChild(sidebarContent);
        
        // Create main content container
        this.mainContent = document.createElement("div");
        this.mainContent.className = "lora-picker-main-content";
        
        // Add content area with list (folder area removed)
        const content = this.createContentWithoutFolders();
        this.mainContent.appendChild(content);
        
        // Create invisible clickable zone between sidebar and main content
        const toggleZone = document.createElement("div");
        toggleZone.style.position = "absolute";
        toggleZone.style.left = this.options.foldersVisible ? `${this.sidebarWidth + 3}px` : "3px";
        toggleZone.style.top = "45px"; // Position below the header area
        toggleZone.style.width = "12px";
        toggleZone.style.height = "calc(100% - 50px)"; // Leave space at top for header
        toggleZone.style.zIndex = "10";
        toggleZone.style.cursor = "pointer";
        // Add click handler to toggle sidebar - trigger the same functionality as Folders button
        toggleZone.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent event bubbling

            // Trigger the same logic as the Folders button click
            this.options.foldersVisible = !this.options.foldersVisible;

            // Find and update the folders container (same as Folders button logic)
            const foldersContainer = this.element.querySelector(".lora-picker-header > div:nth-child(5)");
            if (foldersContainer) {
                const foldersText = foldersContainer.querySelector("span");
                const indicatorLine = foldersContainer.querySelector("div[style*='position: absolute']");
                foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
                foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
                indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            }

            // Save all UI state to both localStorage and workflow
            saveAllUIState(this);

            // Toggle the sidebar
            this.toggleSidebar();

            // Re-render list to ensure blue dots are visible
            this.renderList();
        });

        // Assemble the dialog
        contentWrapper.appendChild(this.sidebar);
        contentWrapper.appendChild(this.mainContent);
        contentWrapper.appendChild(toggleZone);
        this.element.appendChild(contentWrapper);

        // Add to body
        document.body.appendChild(this.element);

        // Store reference to dialog instance for access by rename function
        this.element.dialogInstance = this;

        // Position preview area relative to dialog
        this.updatePreviewPosition();

        // Wait for preview availability to load, then render the list
        this.loadPreviewAvailability().then(() => {
            // Now render the list with preview data available
            this.renderList();

            // Ensure sidebar is in the correct initial state based on saved preference
            this.toggleSidebar();

            // Restore preview panel visibility if eye refresh state is on
            if (this.eyeRefreshState) {
                // Make sure the preview area is in the correct initial state
                // It will be shown on first hover, but ensure it's properly positioned
                if (this.previewArea) {
                    // Start hidden, will show on hover
                    this.previewArea.classList.remove("visible");
                }
            }
        }).catch(error => {
            console.error('Error loading preview availability:', error);
            // Still render list even if preview loading fails
            this.renderList();
        });

        // Focus on the search input automatically
        setTimeout(() => {
            const searchInput = this.element.querySelector("input[type=text]");
            if (searchInput) {
                searchInput.focus();
            }
        }, 10);
        
        // Add keyboard listener for R key to refresh
        this.keydownHandler = (e) => {
            if (e.key === 'R' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
            }
        };
        document.addEventListener('keydown', this.keydownHandler);
    }

    createPreviewArea() {
        // Create preview area container
        this.previewArea = document.createElement("div");
        this.previewArea.className = "lora-picker-preview-area";

        // Create preview images container (will hold multiple images)
        this.previewImagesContainer = document.createElement("div");
        this.previewImagesContainer.className = "lora-picker-preview-images-container";
        this.previewImagesContainer.style.display = "none";

        // Create preview info container
        const previewInfo = document.createElement("div");
        previewInfo.className = "lora-picker-preview-info";

        // Create preview name element
        this.previewName = document.createElement("div");
        this.previewName.className = "lora-picker-preview-name";

        // Create preview status element
        this.previewStatus = document.createElement("div");
        this.previewStatus.className = "lora-picker-preview-status";

        // Assemble preview area
        previewInfo.appendChild(this.previewName);
        previewInfo.appendChild(this.previewStatus);
        this.previewArea.appendChild(this.previewImagesContainer);
        this.previewArea.appendChild(previewInfo);

        // Add mouse event listeners to keep preview visible when hovering
        this.previewArea.addEventListener("mouseenter", () => {
            // Preview remains visible when hovering over it
        });

        this.previewArea.addEventListener("mouseleave", (e) => {
            // Hide preview only if mouse leaves preview area and doesn't enter another lora item
            // Check if the related target is not another lora item
            const relatedTarget = e.relatedTarget;
            if (!relatedTarget || (!relatedTarget.closest('.lora-picker-list li') && !relatedTarget.closest('.lora-picker-preview-area'))) {
                this.hidePreview();
            }
        });

        // Add to document body (not dialog element) to avoid overflow constraints
        document.body.appendChild(this.previewArea);
    }

    createHeader() {
        const header = document.createElement("div");
        header.className = "lora-picker-header";

        // Search input container
        const searchContainer = document.createElement("div");
        searchContainer.className = "lora-picker-search-container";

        // Search input
        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = "Search (multiple words supported)...";
        searchInput.addEventListener("input", () => this.renderList());

        // Clear button
        const clearButton = document.createElement("button");
        clearButton.className = "lora-picker-clear-button";
        clearButton.textContent = "✕";
        clearButton.type = "button";
        clearButton.title = "Clear search";

        // Add click handler to clear button
        clearButton.addEventListener("click", () => {
            searchInput.value = "";
            searchInput.focus();
            this.renderList();
        });

        // Only show clear button when there's text
        searchInput.addEventListener("input", () => {
            clearButton.style.display = searchInput.value ? "flex" : "none";
            this.renderList();
        });

        // Initially hide clear button
        clearButton.style.display = "none";

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(clearButton);
        header.appendChild(searchContainer);

        // Sort dropdown
        const sortDropdown = document.createElement("select");
        const sortOptions = ["Latest", "Oldest", "A-Z", "Z-A"];
        for (const option of sortOptions) {
            const opt = document.createElement("option");
            opt.value = option;
            opt.textContent = option;
            if (this.options.sort === option) {
                opt.selected = true;
            }
            sortDropdown.appendChild(opt);
        }
        sortDropdown.addEventListener("change", (e) => {
            this.options.sort = e.target.value;
            this.renderList();
        });
        header.appendChild(sortDropdown);

        // Add refresh button
        const refreshContainer = document.createElement("div");
        refreshContainer.style.display = "flex";
        refreshContainer.style.alignItems = "center";
        refreshContainer.style.gap = "5px";
        refreshContainer.style.cursor = "pointer";
        refreshContainer.style.margin = "0 10px";
        refreshContainer.style.padding = "4px 8px";
        refreshContainer.style.borderRadius = "4px";
        refreshContainer.style.backgroundColor = "#1a1a1a";
        refreshContainer.style.userSelect = "none";
        refreshContainer.title = "Refresh LoRA List (R)";
        
        const refreshIcon = document.createElement("span");
        refreshIcon.textContent = "↻";
        refreshIcon.style.fontSize = "14px";
        refreshIcon.style.color = "#aaa";
        refreshIcon.style.userSelect = "none";
        
        refreshContainer.appendChild(refreshIcon);
        
        refreshContainer.addEventListener("click", () => {
            // Visual feedback when clicked
            refreshIcon.style.color = "#4488bb";
            refreshContainer.style.backgroundColor = "#2a2a2a";

            if (this.refreshCallback) {
                this.refreshCallback();
                // After refresh, reload preview availability to update blue dots
                this.loadPreviewAvailability().then(() => {
                    // Re-render the list to show updated blue indicators
                    this.renderList();
                    // Reset visual feedback after refresh completes
                    setTimeout(() => {
                        refreshIcon.style.color = "#aaa";
                        refreshContainer.style.backgroundColor = "#1a1a1a";
                    }, 300);
                }).catch(error => {
                    console.error('Error refreshing preview availability:', error);
                    // Still render list even if preview refresh fails
                    this.renderList();
                    // Reset visual feedback even if there's an error
                    setTimeout(() => {
                        refreshIcon.style.color = "#aaa";
                        refreshContainer.style.backgroundColor = "#1a1a1a";
                    }, 300);
                });
            } else {
                // Reset visual feedback if no refresh callback
                setTimeout(() => {
                    refreshIcon.style.color = "#aaa";
                    refreshContainer.style.backgroundColor = "#1a1a1a";
                }, 300);
            }
        });

        // Add context menu for refresh button
        refreshContainer.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showRefreshContextMenu(e);
        });
        
        header.appendChild(refreshContainer);

        // Eye refresh button
        const eyeRefreshContainer = document.createElement("div");
        eyeRefreshContainer.style.display = "flex";
        eyeRefreshContainer.style.alignItems = "center";
        eyeRefreshContainer.style.gap = "5px";
        eyeRefreshContainer.style.cursor = "pointer";
        eyeRefreshContainer.style.margin = "0 5px";
        eyeRefreshContainer.style.padding = "4px 8px";
        eyeRefreshContainer.style.borderRadius = "4px";
        eyeRefreshContainer.style.backgroundColor = this.eyeRefreshState ? "#2a2a2a" : "#1a1a1a";
        eyeRefreshContainer.style.userSelect = "none";
        eyeRefreshContainer.title = "Eye Refresh Toggle";

        const eyeRefreshIcon = document.createElement("span");
        eyeRefreshIcon.textContent = "👀";
        eyeRefreshIcon.style.fontSize = "14px";
        eyeRefreshIcon.style.color = this.eyeRefreshState ? "#4488bb" : "#aaa";
        eyeRefreshIcon.style.userSelect = "none";

        eyeRefreshContainer.appendChild(eyeRefreshIcon);

        eyeRefreshContainer.addEventListener("click", () => {
            this.eyeRefreshState = !this.eyeRefreshState;
            eyeRefreshIcon.style.color = this.eyeRefreshState ? "#4488bb" : "#aaa";
            eyeRefreshContainer.style.backgroundColor = this.eyeRefreshState ? "#2a2a2a" : "#1a1a1a";
            // Save all UI state to both localStorage and workflow
            saveAllUIState(this);

            // Hide preview if turning off
            if (!this.eyeRefreshState) {
                this.hidePreview();
            }

            // Call the refresh callback when toggled on
            if (this.eyeRefreshState && this.refreshCallback) {
                this.refreshCallback();
            }
        });

        header.appendChild(eyeRefreshContainer);

        // New 3-position circle icon
        const circleIconContainer = document.createElement("div");
        circleIconContainer.style.display = "flex";
        circleIconContainer.style.alignItems = "center";
        circleIconContainer.style.cursor = "pointer";
        circleIconContainer.style.margin = "0 5px";
        circleIconContainer.style.padding = "4px 8px";
        circleIconContainer.style.borderRadius = "4px";
        circleIconContainer.style.backgroundColor = this.circleIconState ? "#2a2a2a" : "#1a1a1a";
        circleIconContainer.style.userSelect = "none";
        circleIconContainer.title = "Circle Icon State (Empty/Half/Full)";

        const circleIcon = document.createElement("span");
        circleIcon.textContent = this.getCircleIconSymbol();
        circleIcon.style.fontSize = "14px";
        circleIcon.style.color = this.circleIconState ? "#4488bb" : "#aaa";
        circleIcon.style.userSelect = "none";

        circleIconContainer.appendChild(circleIcon);

        circleIconContainer.addEventListener("click", () => {
            // Cycle through states: 0 -> 1 -> 2 -> 0
            this.circleIconState = (this.circleIconState + 1) % 3;
            circleIcon.textContent = this.getCircleIconSymbol();
            circleIcon.style.color = this.circleIconState > 0 ? "#4488bb" : "#aaa";
            circleIconContainer.style.backgroundColor = this.circleIconState > 0 ? "#2a2a2a" : "#1a1a1a";
            // Save all UI state to both localStorage and workflow
            saveAllUIState(this);
            // Re-render the list to apply the new filter
            this.renderList();
        });

        header.appendChild(circleIconContainer);

        // Folders button
        const foldersContainer = document.createElement("div");
        foldersContainer.style.display = "flex";
        foldersContainer.style.alignItems = "center";
        foldersContainer.style.gap = "5px";
        foldersContainer.style.cursor = "pointer";
        foldersContainer.style.margin = "0 5px";
        foldersContainer.style.padding = "4px 8px";
        foldersContainer.style.borderRadius = "4px";
        foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
        foldersContainer.style.userSelect = "none";
        foldersContainer.style.position = "relative";

        const foldersText = document.createElement("span");
        foldersText.textContent = "Folders";
        foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
        foldersText.style.userSelect = "none";
        
        // Add blue gradient indicator line positioned at the bottom inside the button
        const indicatorLine = document.createElement("div");
        indicatorLine.style.position = "absolute";
        indicatorLine.style.bottom = "0";
        indicatorLine.style.left = "50%";
        indicatorLine.style.transform = "translateX(-50%)";
        indicatorLine.style.height = "1px";
        indicatorLine.style.width = "70%";
        indicatorLine.style.background = "linear-gradient(to right, transparent 0%, rgba(68, 136, 187, 0.2) 10%, rgba(68, 136, 187, 0.5) 20%, rgba(68, 136, 187, 0.8) 30%, #4488bb 40%, #4488bb 60%, rgba(68, 136, 187, 0.8) 70%, rgba(68, 136, 187, 0.5) 80%, rgba(68, 136, 187, 0.2) 90%, transparent 100%)";
        indicatorLine.style.borderRadius = "0.5px";
        indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";

        foldersContainer.appendChild(foldersText);
        foldersContainer.appendChild(indicatorLine);
        
        foldersContainer.addEventListener("click", () => {
            this.options.foldersVisible = !this.options.foldersVisible;
            foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
            foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
            // Update indicator line visibility
            indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            // Save all UI state to both localStorage and workflow
            saveAllUIState(this);
            this.toggleSidebar();
            // Re-render list to ensure blue dots are visible
            this.renderList();
        });
        
        header.appendChild(foldersContainer);

        // Favorites star
        const favoritesContainer = document.createElement("div");
        favoritesContainer.style.display = "flex";
        favoritesContainer.style.alignItems = "center";
        favoritesContainer.style.gap = "5px";
        favoritesContainer.style.cursor = "pointer";
        favoritesContainer.style.margin = "0 10px";
        favoritesContainer.style.padding = "4px 8px";
        favoritesContainer.style.borderRadius = "4px";
        favoritesContainer.style.backgroundColor = this.options.favoritesOnly ? "#2a2a2a" : "#1a1a1a";
        favoritesContainer.style.userSelect = "none";
        
        const favoritesStar = document.createElement("span");
        favoritesStar.className = "favorite-star";
        favoritesStar.textContent = "★";
        const isFavoritesOnly = this.options.favoritesOnly || false;
        favoritesStar.style.color = isFavoritesOnly ? "orange" : "#555";
        favoritesStar.style.userSelect = "none";
        
        const favoritesText = document.createElement("span");
        favoritesText.textContent = "Favorites";
        favoritesText.style.color = isFavoritesOnly ? "#89B" : "#aaa";
        favoritesText.style.userSelect = "none";
        
        favoritesContainer.appendChild(favoritesStar);
        favoritesContainer.appendChild(favoritesText);
        
        favoritesContainer.addEventListener("click", () => {
            this.options.favoritesOnly = !this.options.favoritesOnly;
            favoritesStar.style.color = this.options.favoritesOnly ? "orange" : "#555";
            favoritesText.style.color = this.options.favoritesOnly ? "#89B" : "#aaa";
            favoritesContainer.style.backgroundColor = this.options.favoritesOnly ? "#2a2a2a" : "#1a1a1a";
            // Save to persistence
            saveFavoritesOnly(this.options.favoritesOnly);
            this.renderList();
        });
        
        header.appendChild(favoritesContainer);

        return header;
    }

    createContent() {
        const content = document.createElement("div");
        content.className = "lora-picker-content";
        
        // Create list container
        const listContainer = document.createElement("div");
        listContainer.className = "lora-picker-list-container";
        
        // Create lora list
        this.list = document.createElement("ul");
        this.list.className = "lora-picker-list";
        this.renderList();
        listContainer.appendChild(this.list);
        
        content.appendChild(listContainer);
        
        return content;
    }
    
    createContentWithoutFolders() {
        const content = document.createElement("div");
        content.className = "lora-picker-content";
        
        // Create list container
        const listContainer = document.createElement("div");
        listContainer.className = "lora-picker-list-container";
        
        // Create lora list
        this.list = document.createElement("ul");
        this.list.className = "lora-picker-list";
        this.renderList();
        listContainer.appendChild(this.list);
        
        content.appendChild(listContainer);
        
        return content;
    }

    toggleSidebar() {
        if (this.options.foldersVisible) {
            this.sidebar.classList.remove("collapsed");
            this.sidebar.style.width = `${this.sidebarWidth}px`;
        } else {
            this.sidebar.classList.add("collapsed");
            this.sidebar.style.width = '0px';
        }
        // Update toggle zone position
        const toggleZone = this.element.querySelector("div[style*='z-index: 10']");
        if (toggleZone) {
            toggleZone.style.left = this.options.foldersVisible ? `${this.sidebarWidth + 3}px` : "3px";
        }
    }
    
    // Returns the distinct subfolder names (second path segment) under a given
    // top-level folder - only subfolders that directly contain loras.
    getSubfolders(parentFolder) {
        const subs = new Set();
        for (const lora of this.loras) {
            const name = typeof lora === 'string' ? lora : lora.name;
            if (!name) continue;
            const parts = name.split(/[\/\\]/);
            if (parts.length >= 3 && parts[0] === parentFolder && parts[1]) {
                subs.add(parts[1]);
            }
        }
        return [...subs].sort((a, b) => a.localeCompare(b));
    }

    renderFoldersInSidebar(container) {
        container.innerHTML = "";

        for (const folder of this.folders) {
            // Wrapper holds the folder row and (when expanded) its subfolders
            const wrapper = document.createElement("div");
            wrapper.className = "lora-picker-folder-wrapper";

            const folderItem = document.createElement("div");
            folderItem.className = "lora-picker-folder-item";
            if (this.selectedFolder === folder) {
                folderItem.classList.add("selected");
            }

            // Folder icon
            const folderIcon = document.createElement("div");
            folderIcon.className = "lora-picker-folder-icon";
            folderIcon.textContent = "📁";

            // Folder name
            const folderName = document.createElement("div");
            folderName.className = "lora-picker-folder-name";
            folderName.textContent = folder;

            folderItem.appendChild(folderIcon);
            folderItem.appendChild(folderName);

            // Add click handler for the folder row
            folderItem.addEventListener("click", () => {
                this.selectFolder(folder);
            });

            // Folder row goes first...
            wrapper.appendChild(folderItem);

            // Down arrow for folders that have subdirectories (right-aligned).
            // Only shows subfolders 1 level deep.
            const subfolders = folder === "root" ? [] : this.getSubfolders(folder);
            if (subfolders.length > 0) {
                const isExpanded = this.expandedFolders.has(folder);
                const arrow = document.createElement("div");
                arrow.className = "lora-picker-folder-arrow";
                arrow.textContent = isExpanded ? "▼" : "▶";
                arrow.title = isExpanded ? "Collapse subfolders" : "Show subfolders";
                arrow.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (this.expandedFolders.has(folder)) {
                        this.expandedFolders.delete(folder);
                    } else {
                        this.expandedFolders.add(folder);
                    }
                    this.renderFoldersInSidebar(container);
                });
                folderItem.appendChild(arrow);

                // ...then the subfolder rows underneath it
                if (isExpanded) {
                    for (const sub of subfolders) {
                        const subItem = document.createElement("div");
                        subItem.className = "lora-picker-subfolder-item";
                        if (this.selectedFolder === folder && this.selectedSubfolder === sub) {
                            subItem.classList.add("selected");
                        }

                        const subIcon = document.createElement("div");
                        subIcon.className = "lora-picker-subfolder-icon";
                        subIcon.textContent = "📂";

                        const subName = document.createElement("div");
                        subName.className = "lora-picker-subfolder-name";
                        subName.textContent = sub;

                        subItem.appendChild(subIcon);
                        subItem.appendChild(subName);

                        subItem.addEventListener("click", () => {
                            this.selectSubfolder(folder, sub);
                        });

                        wrapper.appendChild(subItem);
                    }
                }
            }

            container.appendChild(wrapper);
        }
    }

    getSidebarFolderContainer() {
        return this.sidebar
            ? (this.sidebar.querySelector(".lora-picker-sidebar-content") || this.sidebar)
            : null;
    }

    selectSubfolder(parentFolder, subfolder) {
        // Clicking the already selected subfolder deselects it (parent stays)
        if (this.selectedFolder === parentFolder && this.selectedSubfolder === subfolder) {
            this.selectedSubfolder = null;
            saveAllUIState(this);
            this.renderFoldersInSidebar(this.getSidebarFolderContainer());
            this.renderList();
            return;
        }

        this.selectedFolder = parentFolder;
        this.selectedSubfolder = subfolder;
        saveAllUIState(this);
        this.renderFoldersInSidebar(this.getSidebarFolderContainer());
        this.renderList();
    }

    extractFolders() {
        const folderSet = new Set();
        // Always add "root" folder
        const folders = ["root"];
        
        // Extract folder names from lora list
        for (const lora of this.loras) {
            const name = typeof lora === 'string' ? lora : lora.name;
            // Check for both forward slash and backslash
            if (name && (name.includes('/') || name.includes('\\'))) {
                const folderName = name.split(/[\/\\]/)[0];
                if (folderName && !folderSet.has(folderName)) {
                    folderSet.add(folderName);
                    folders.push(folderName);
                }
            }
        }
        
        // Sort folders alphabetically (keeping "root" first)
        return folders.sort((a, b) => {
            if (a === "root") return -1;
            if (b === "root") return 1;
            return a.localeCompare(b);
        });
    }


    selectFolder(folderName) {
        // Check if clicking on already selected folder - if so, unselect it
        if (this.selectedFolder === folderName) {
            const prevSelected = this.sidebar.querySelector(".lora-picker-folder-item.selected");
            if (prevSelected) {
                prevSelected.classList.remove("selected");
            }
            this.selectedFolder = null;
            this.selectedSubfolder = null;
            // Save all UI state to both localStorage and workflow
            saveAllUIState(this);
            // Update indicator line visibility
            this.updateFolderIndicator();
            this.renderFoldersInSidebar(this.getSidebarFolderContainer());
            this.renderList(); // Refresh the list
            return;
        }

        // Remove selection from previous folder
        const prevSelected = this.sidebar.querySelector(".lora-picker-folder-item.selected");
        if (prevSelected) {
            prevSelected.classList.remove("selected");
        }

        // Switching to a different folder clears any subfolder filter
        this.selectedSubfolder = null;

        // Add selection to new folder
        const folderItems = this.sidebar.querySelectorAll(".lora-picker-folder-item");
        for (const item of folderItems) {
            const name = item.querySelector(".lora-picker-folder-name").textContent;
            if (name === folderName) {
                item.classList.add("selected");
                break;
            }
        }

        this.selectedFolder = folderName;
        // Save all UI state to both localStorage and workflow
        saveAllUIState(this);
        // Update indicator line visibility
        this.updateFolderIndicator();
        this.renderFoldersInSidebar(this.getSidebarFolderContainer());
        this.renderList(); // Refresh the list
    }

    renderList() {
        this.list.innerHTML = "";
        let loras = this.loras;
        loras = this.filterLoras(loras);
        loras = this.sortLoras(loras);

        for (const lora of loras) {
            const item = document.createElement("li");
            const name = typeof lora === 'string' ? lora : lora.name;
            
            // Remove folder prefix for display purposes only (first level only)
            let displayName = name;
            if (this.selectedFolder && this.selectedFolder !== "root") {
                // Strip the subfolder prefix too when one is selected
                const prefix = this.selectedSubfolder
                    ? this.selectedFolder + "/" + this.selectedSubfolder + "/"
                    : this.selectedFolder + "/";
                const altPrefix = prefix.replace("/", "\\");
                if (name.startsWith(prefix)) {
                    displayName = name.substring(prefix.length);
                } else if (name.startsWith(altPrefix)) {
                    displayName = name.substring(altPrefix.length);
                } else if (!this.selectedSubfolder) {
                    const plainPrefix = this.selectedFolder + "/";
                    const plainAltPrefix = this.selectedFolder + "\\";
                    if (name.startsWith(plainPrefix)) {
                        displayName = name.substring(plainPrefix.length);
                    } else if (name.startsWith(plainAltPrefix)) {
                        displayName = name.substring(plainAltPrefix.length);
                    }
                }
            }

            // Create a container for the star with extended clickable area
            const starContainer = document.createElement("div");
            starContainer.style.display = "flex";
            starContainer.style.alignItems = "center";
            starContainer.style.marginRight = "8px"; // Same as the gap
            starContainer.style.cursor = "pointer";
            
            const star = document.createElement("span");
            star.className = "favorite-star";
            star.textContent = "★";
            const isFavorite = this.options.favorites.includes(name);
            star.style.color = isFavorite ? "orange" : "gray";
            star.style.userSelect = "none";

            star.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this.options.onFavoriteToggle) {
                    this.options.onFavoriteToggle(name);
                }
            });
            
            starContainer.appendChild(star);

            const nameSpan = document.createElement("span");
            nameSpan.textContent = displayName;
            nameSpan.style.userSelect = "none";

            // Add blue dot indicator if preview is available
            if (this.hasPreview(name)) {
                const previewIndicator = document.createElement("div");
                previewIndicator.className = "lora-picker-preview-indicator";
                previewIndicator.title = "Preview image available";

                item.appendChild(starContainer);
                item.appendChild(nameSpan);
                item.appendChild(previewIndicator);
            } else {
                item.appendChild(starContainer);
                item.appendChild(nameSpan);
            }

            // Add hover event handlers for preview
            item.addEventListener("mouseenter", () => {
                if (this.eyeRefreshState) {
                    if (this.hasPreview(name)) {
                        this.showPreview(name);
                    } else {
                        this.hidePreview();
                    }
                } else {
                    // Also hide preview if eye refresh is OFF
                    this.hidePreview();
                }
            });

            item.addEventListener("click", () => {
                if (this.options.callback) {
                    // Use the full name (including folder path) for the callback
                    // This ensures the Python code gets the complete path information
                    this.options.callback(name);
                }
                this.close();
            });

            // Add context menu event listener
            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showLoraListContextMenu(e, name); // Use the full name for context menu
            });

            this.list.appendChild(item);
        }
    }

    sortLoras(loras) {
        const sort = this.options.sort || "Latest";
        
        // Sort the loras array directly based on the sort option
        const sortedLoras = [...loras];
        
        if (sort === "Latest") {
            sortedLoras.sort((a, b) => {
                const aMtime = (typeof a === 'object' && a.mtime) ? a.mtime : 0;
                const bMtime = (typeof b === 'object' && b.mtime) ? b.mtime : 0;
                return bMtime - aMtime; // Descending order (newest first)
            });
        } else if (sort === "Oldest") {
            sortedLoras.sort((a, b) => {
                const aMtime = (typeof a === 'object' && a.mtime) ? a.mtime : 0;
                const bMtime = (typeof b === 'object' && b.mtime) ? b.mtime : 0;
                return aMtime - bMtime; // Ascending order (oldest first)
            });
        } else if (sort === "A-Z") {
            sortedLoras.sort((a, b) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                return aName.localeCompare(bName);
            });
        } else if (sort === "Z-A") {
            sortedLoras.sort((a, b) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                return bName.localeCompare(aName);
            });
        }
        
        return sortedLoras;
    }

    filterLoras(loras) {
        const favoritesOnly = this.options.favoritesOnly || false;
        const favorites = this.options.favorites || [];
        const searchInput = this.element.querySelector("input[type=text]");
        const query = searchInput ? searchInput.value.toLowerCase() : "";

        let filteredLoras = loras;

        // Filter by selected folder + subfolder (subfolder takes precedence)
        if (this.selectedFolder && this.selectedFolder !== "root" && this.selectedSubfolder) {
            const prefixFwd = this.selectedFolder + "/" + this.selectedSubfolder + "/";
            const prefixBck = this.selectedFolder + "\\" + this.selectedSubfolder + "\\";
            filteredLoras = filteredLoras.filter(l => {
                const name = typeof l === 'string' ? l : l.name;
                return !!name && (name.startsWith(prefixFwd) || name.startsWith(prefixBck));
            });
        } else if (this.selectedFolder && this.selectedFolder !== "root") {
            filteredLoras = filteredLoras.filter(l => {
                const name = typeof l === 'string' ? l : l.name;
                // Check if the lora is in the selected folder
                if (name && (name.includes('/') || name.includes('\\'))) {
                    const folderName = name.split(/[\/\\]/)[0];
                    return folderName === this.selectedFolder;
                }
                return false;
            });
        } else if (this.selectedFolder === "root") {
            // Show ALL items when root is selected (including those in subfolders)
            // No filtering needed - keep all loras
        }

        if (favoritesOnly) {
            filteredLoras = filteredLoras.filter(l => favorites.includes(typeof l === 'string' ? l : l.name));
        }

        if (query) {
            filteredLoras = filteredLoras.filter(l => this.matchesSearchQuery((typeof l === 'string' ? l : l.name), query));
        }

        // Apply circle icon filter (HIGH/LOW filtering)
        if (this.circleIconState > 0) {
            filteredLoras = filteredLoras.filter(l => {
                const name = typeof l === 'string' ? l : l.name;
                if (this.circleIconState === 1) {
                    // ◐ state: Show only HIGH variants
                    return this.isHighVariant(name);
                } else if (this.circleIconState === 2) {
                    // ◑ state: Show only LOW variants
                    return this.isLowVariant(name);
                }
                return true;
            });
        }

        return filteredLoras;
    }

    /**
     * Check if a LoRA name matches a multi-word search query
     * @param {string} loraName - The LoRA name to check
     * @param {string} query - The search query (can contain multiple words)
     * @returns {boolean} - True if the LoRA matches all words in the query
     */
    matchesSearchQuery(loraName, query) {
        if (!query || !loraName) return false;
        
        // Convert to lowercase for case-insensitive matching
        const lowerLoraName = loraName.toLowerCase();
        
        // Split the query into individual words, filtering out empty strings
        const searchWords = query.split(/\s+/).filter(word => word.length > 0);
        
        // If no valid words in query, don't filter
        if (searchWords.length === 0) return true;
        
        // Check if ALL search words are present in the LoRA name
        return searchWords.every(word => lowerLoraName.includes(word));
    }

    /**
     * Check if a LoRA name indicates it's a HIGH variant
     * @param {string} loraName - The LoRA name to check
     * @returns {boolean} - True if the LoRA is a HIGH variant
     */
    isHighVariant(loraName) {
        if (!loraName) return false;
        const name = loraName.toLowerCase();
        return name.includes('high') || name.includes('_h.') || name.includes('_h_');
    }

    /**
     * Check if a LoRA name indicates it's a LOW variant
     * @param {string} loraName - The LoRA name to check
     * @returns {boolean} - True if the LoRA is a LOW variant
     */
    isLowVariant(loraName) {
        if (!loraName) return false;
        const name = loraName.toLowerCase();
        return name.includes('low') || name.includes('_l.') || name.includes('_l_');
    }

    updateFolderIndicator() {
        // Find and update the indicator line in the folders button
        const foldersContainer = this.element.querySelector(".lora-picker-header > div:nth-child(5)");
        if (foldersContainer) {
            // Find the indicator line (it's now positioned absolutely at the bottom)
            const indicatorLine = foldersContainer.querySelector("div[style*='position: absolute']");
            if (indicatorLine) {
                // Show indicator only if a non-root folder is selected and sidebar is collapsed
                indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            }
        }
    }

    showPreview(loraName) {
        if (!this.hasPreview(loraName)) {
            return;
        }

        // If we're already showing preview for this LoRA, don't do anything
        if (this.currentPreviewLora === loraName) {
            return;
        }

        // Clear any existing timeout
        if (this.currentPreviewTimeout) {
            clearTimeout(this.currentPreviewTimeout);
        }

        // Track the currently being previewed LoRA
        this.currentPreviewLora = loraName;

        // Add a small delay to prevent flickering when quickly moving between items
        this.currentPreviewTimeout = setTimeout(() => {
            this.loadPreviewImage(loraName);
        }, 200);
    }

    hidePreview() {
        // Clear any pending preview timeout
        if (this.currentPreviewTimeout) {
            clearTimeout(this.currentPreviewTimeout);
            this.currentPreviewTimeout = null;
        }

        // Reset the currently previewed LoRA
        this.currentPreviewLora = null;

        // Hide preview area
        if (this.previewArea) {
            this.previewArea.classList.remove("visible");
        }
    }

    loadPreviewImage(loraName) {
        if (!this.previewArea || !this.previewImagesContainer || !this.previewName || !this.previewStatus) {
            return;
        }

        // Set the LoRA name
        this.previewName.textContent = loraName;
        this.previewStatus.textContent = "Loading preview...";

        // Show the preview area
        this.previewArea.classList.add("visible");

        // Clear any existing images
        this.previewImagesContainer.innerHTML = "";
        this.previewImagesContainer.style.display = "none";

        // Remove extension
        let loraPath = loraName.replace(/\.(safetensors|pt|ckpt)$/i, '');

        // Parse subfolder and filename
        let filename = loraPath;
        let subfolder = '';

        // Check if there's a subfolder path
        const pathSeparator = loraPath.includes('/') ? '/' : '\\';
        if (loraPath.includes(pathSeparator)) {
            const pathParts = loraPath.split(pathSeparator);
            filename = pathParts.pop(); // Get the last part as filename
            subfolder = pathParts.join('/'); // Join the rest with forward slashes
        }

        // Try to load multiple preview images (_01.jpg, _02.jpg, _03.jpg)
        this.loadMultiplePreviewImages(filename, subfolder);
    }

    async loadMultiplePreviewImages(filename, subfolder) {
        const imagePromises = [];

        // Create promises for each potential preview image
        for (let i = 1; i <= 3; i++) {
            const suffix = `_${String(i).padStart(2, '0')}`;
            const promise = this.loadSinglePreviewImage(filename, subfolder, suffix);
            imagePromises.push(promise);
        }

        try {
            // Wait for all images to load (or fail)
            const results = await Promise.allSettled(imagePromises);

            // Load JSON data for positive prompts
            const jsonData = await this.loadPreviewJsonData(filename, subfolder);

            // Filter successful results and create image elements with containers and copy buttons
            let loadedCount = 0;
            results.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value) {
                    // Create container for image and copy button
                    const imageContainer = document.createElement("div");
                    imageContainer.className = "lora-picker-preview-image-container";

                    // Create image element
                    const imgElement = document.createElement("img");
                    imgElement.className = "lora-picker-preview-image";
                    imgElement.src = result.value;
                    imgElement.style.display = "block";
                    imgElement.style.width = "100%";
                    imageContainer.appendChild(imgElement);

                    // Add Copy+ button if JSON data and positive prompt are available
                    if (jsonData && jsonData.images && jsonData.images[index] && jsonData.images[index].positive) {
                        const copyButton = document.createElement("button");
                        copyButton.className = "lora-picker-copy-button";
                        copyButton.textContent = "Copy+";
                        copyButton.title = "Copy positive prompt";

                        // Add click event listener for copy functionality
                        copyButton.addEventListener("click", async (e) => {
                            e.stopPropagation();
                            const positivePrompt = jsonData.images[index].positive;
                            if (positivePrompt) {
                                try {
                                    await navigator.clipboard.writeText(positivePrompt);
                                    this.showCopyMessage("Positive prompt copied to clipboard", "success", positivePrompt);
                                } catch (error) {
                                    console.error('Failed to copy to clipboard:', error);
                                    this.showCopyMessage("Failed to copy to clipboard", "error");
                                }
                            } else {
                                this.showCopyMessage("No positive prompt found", "error");
                            }
                        });

                        imageContainer.appendChild(copyButton);
                    }

                    this.previewImagesContainer.appendChild(imageContainer);
                    loadedCount++;
                }
            });

            if (loadedCount > 0) {
                this.previewImagesContainer.style.display = "flex";
                this.previewStatus.textContent = `Loaded ${loadedCount} preview${loadedCount > 1 ? 's' : ''}`;

                // Update preview area height after images are loaded
                setTimeout(() => this.updatePreviewPosition(), 100);
            } else {
                this.hidePreview();
            }
        } catch (error) {
            console.error('Error loading preview images:', error);
            this.hidePreview();
        }
    }

    async loadSinglePreviewImage(filename, subfolder, suffix) {
        try {
            // Determine item type based on options
            const itemType = this.options && this.options.itemType ? this.options.itemType :
                           (this.options && this.options.isModelMode ? 'checkpoints' : 'loras');

            // Use unified system from pull_info.js
            const { modelDataManager } = await import('./pull_info.js');
            const imageUrl = modelDataManager.getPreviewImageUrl(filename, itemType, suffix, subfolder);

            // Test if the image loads successfully
            return new Promise((resolve, reject) => {
                const testImage = new Image();
                testImage.onload = () => resolve(imageUrl);
                testImage.onerror = () => reject(new Error(`Failed to load image: ${imageUrl}`));
                testImage.src = imageUrl;
            });
        } catch (error) {
            throw new Error(`Error building preview URL: ${error.message}`);
        }
    }

    async loadPreviewAvailability() {
        // Determine item type based on options
        const itemType = this.options && this.options.itemType ? this.options.itemType :
                       (this.options && this.options.isModelMode ? 'checkpoints' : 'loras');

        // Use unified system from pull_info.js
        try {
                const { modelDataManager } = await import('./pull_info.js');
                const previewAvailability = await modelDataManager.getPreviewAvailability(itemType);

            // Update our cache
                this.previewAvailabilityCache.clear();
                previewAvailability.forEach(itemName => {
                    this.previewAvailabilityCache.add(itemName);
                });
            } catch (error) {
                console.error('[Preview] Error loading preview availability:', error);
                // Don't clear cache on error, keep existing data
            }
    }

    hasPreview(loraName) {
        return this.previewAvailabilityCache.has(loraName);
    }

    async loadPreviewJsonData(filename, subfolder) {
        try {
            // Determine item type based on options
            const itemType = this.options && this.options.itemType ? this.options.itemType :
                           (this.options && this.options.isModelMode ? 'checkpoints' : 'loras');

            // Use unified system from pull_info.js
            const { modelDataManager } = await import('./pull_info.js');
            const jsonData = await modelDataManager.getJsonData(filename, itemType, subfolder);
            return jsonData;
        } catch (error) {
            console.error('[Preview] Error loading JSON data:', error);
            return null;
        }
    }

    showCopyMessage(message, type = "success", copiedPrompt = null) {
        // Create message element
        const messageElement = document.createElement("div");
        messageElement.style.cssText = `
            position: fixed !important;
            top: 20px !important;
            right: 20px !important;
            background-color: ${type === "success" ? "#2a5a2a" : "#5a2a2a"} !important;
            color: #ddd !important;
            padding: 8px 12px !important;
            border-radius: 4px !important;
            border: 1px solid ${type === "success" ? "#4a7a4a" : "#7a4a4a"} !important;
            font-family: Arial, sans-serif !important;
            font-size: 12px !important;
            z-index: 10002 !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
            opacity: 0 !important;
            transition: opacity 0.2s ease-in-out !important;
            max-width: 400px !important;
        `;

        // Create message content
        let messageContent = message;
        if (copiedPrompt && type === "success") {
            messageContent += `:<br><div style="margin-top: 4px; font-style: italic; color: #aaa; font-size: 11px; word-break: break-word; max-height: 100px; overflow-y: auto;">${copiedPrompt}</div>`;
        }

        messageElement.innerHTML = messageContent;

        // Add to document
        document.body.appendChild(messageElement);

        // Fade in
        setTimeout(() => {
            messageElement.style.opacity = "1";
        }, 10);

        // Remove after 5 seconds (longer for readability)
        setTimeout(() => {
            messageElement.style.opacity = "0";
            setTimeout(() => {
                if (messageElement.parentNode) {
                    messageElement.parentNode.removeChild(messageElement);
                }
            }, 200);
        }, 3000);
    }

    
    close() {
        saveAllUIState(this);

        // Hide preview and clean up state
        this.hidePreview();

        if (this.element) {
            this.element.remove();
        }
        if (this.overlay) {
            this.overlay.remove();
        }
        // Remove preview area when dialog closes
        if (this.previewArea) {
            this.previewArea.remove();
        }
        if (this.keydownHandler) {
            document.removeEventListener('keydown', this.keydownHandler);
        }
    }

    updatePreviewPosition() {
        if (this.previewArea && this.element) {
            const dialogRect = this.element.getBoundingClientRect();
            // Position preview area to align with dialog's right edge
            this.previewArea.style.top = `${dialogRect.top + 10}px`; // +10 for dialog padding
            // Let height be determined by content
            this.previewArea.style.minHeight = 'auto';
            this.previewArea.style.right = `${window.innerWidth - dialogRect.right}px`;

            // Set height based on actual content, not scrollHeight to avoid cumulative growth
            if (this.previewArea.classList.contains('visible')) {
                // Reset height to auto first to get natural content height
                this.previewArea.style.height = 'auto';

                // Get the natural content height and add 50px
                const contentHeight = this.previewArea.offsetHeight;
                this.previewArea.style.height = `${contentHeight + 50}px`;
            }
        }
    }

    updateLoras(newLoras) {
        // Filter out any "None" entries from the new loras list
        this.loras = (newLoras || []).filter(l => {
            const name = typeof l === 'string' ? l : l.name;
            return name && name.toLowerCase() !== "none";
        });
        // Re-extract folders from the updated lora list
        this.folders = this.extractFolders();
        // Re-render folders in sidebar if it exists
        if (this.sidebar) {
            const sidebarContent = this.sidebar.querySelector(".lora-picker-sidebar-content");
            if (sidebarContent) {
                this.renderFoldersInSidebar(sidebarContent);
            }
        }
        // Re-render the list
        this.renderList();
    }

    showRefreshContextMenu(event) {
        // Remove any existing context menu
        const existingMenu = document.getElementById('refresh-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.id = 'refresh-context-menu';
        menu.className = 'litegraph litecontextmenu litemenubar-panel';
        menu.style.cssText = `
            position: absolute !important;
            left: ${event.clientX}px !important;
            top: ${event.clientY}px !important;
            background-color: #1a1a1a !important;
            border: 1px solid #000 !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
            z-index: 10000 !important;
            padding: 4px !important;
            border-radius: 0px !important;
            min-width: 150px !important;
            display: block !important;
            font-family: Arial, sans-serif !important;
            font-size: 11px !important;
        `;

        // Helper to create menu item
        const createMenuItem = (text, onClick, disabled = false) => {
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
                };
            }

            const textSpan = document.createElement('span');
            textSpan.textContent = text;

            item.appendChild(textSpan);
            return item;
        };

        // Add smart fetch menu items
        menu.appendChild(createMenuItem('📥 Fetch Missing', () => {
            this.startBatchFetch('missing');
        }));

        menu.appendChild(createMenuItem('🔄 Update Existing', () => {
            this.startBatchFetch('existing');
        }));

        menu.appendChild(createMenuItem('📥 Fetch All', () => {
            this.startBatchFetch('all');
        }));

        // Add separator
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px !important;
            background-color: #333 !important;
            margin: 2px 0 !important;
        `;
        menu.appendChild(separator);

        // Add "Refresh list" menu item
        menu.appendChild(createMenuItem('🔄 Refresh list', () => {
            if (this.refreshCallback) {
                this.refreshCallback();
            }
        }));

        // Add "Show Stats" menu item
        menu.appendChild(createMenuItem('📊 Show Stats', async () => {
            // Show comprehensive LoRA statistics
            try {

                // Get all available LoRA names from the system
                const allLoras = await fetch('/wanvid/api/loras')
                    .then(response => response.json())
                    .then(data => {
                        // Handle both direct array and wrapped response formats
                        return Array.isArray(data) ? data : (data.loras || data);
                    })
                    .catch(error => {
                        console.error('Error fetching LoRA list:', error);
                        return [];
                    });

                // Get the preview callback function from the current dialog
                const hasPreviewCallback = (loraName) => {
                    // Try to get the preview status from the dialog
                    if (this.hasPreviewCallback) {
                        return this.hasPreviewCallback(loraName);
                    }

                    // Fallback: check if preview files exist via API
                    return fetch(`/wanvid/api/loras/preview?file=${encodeURIComponent(loraName.replace(/\.[^/.]+$/, "") + '_01.jpg')}`)
                        .then(response => response.ok)
                        .catch(() => false);
                };

                // Gather comprehensive statistics
                const stats = await batchFetchService.gatherComprehensiveStats(hasPreviewCallback, allLoras);

                // Display the stats dialog
                batchFetchService.createStatsDialog(stats);

            } catch (error) {
                console.error('Error showing LoRA statistics:', error);

                // Show error dialog
                const errorDialog = document.createElement('div');
                errorDialog.style.cssText = `
                    position: fixed !important;
                    top: 50% !important;
                    left: 50% !important;
                    transform: translate(-50%, -50%) !important;
                    background: #2a2a2a !important;
                    border: 2px solid #f44336 !important;
                    border-radius: 8px !important;
                    padding: 20px !important;
                    z-index: 10000 !important;
                    color: #fff !important;
                    font-family: Arial, sans-serif !important;
                    text-align: center !important;
                `;
                errorDialog.innerHTML = `
                    <h3 style="color: #f44336; margin-top: 0;">❌ Error</h3>
                    <p>Failed to gather LoRA statistics:</p>
                    <p style="color: #ccc; font-size: 12px;">${error.message}</p>
                    <button onclick="this.parentElement.remove()" style="
                        background: #f44336 !important;
                        border: none !important;
                        color: white !important;
                        padding: 8px 16px !important;
                        border-radius: 4px !important;
                        cursor: pointer !important;
                        margin-top: 12px !important;
                    ">Close</button>
                `;
                document.body.appendChild(errorDialog);
            }
        }));

        document.body.appendChild(menu);

        // Prevent menu close when interacting with menu
        menu.onclick = (e) => e.stopPropagation();

        // Hide menu when clicking outside
        const hideMenu = (e) => {
            if (menu && !menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', hideMenu);
            }
        };

        // Add listeners after a short delay to prevent immediate closure
        setTimeout(() => {
            document.addEventListener('click', hideMenu);
        }, 100);
    }

    /**
     * Start batch fetch operation with progress UI
     * @param {string} filterType - 'missing', 'existing', or 'all'
     */
    async startBatchFetch(filterType) {
        if (!this.loras || this.loras.length === 0) {
            console.warn('No LoRAs available to fetch');
            return;
        }

        // Create progress UI
        const progressUI = this.createProgressUI(filterType);
        const { loadingOverlay, progressFill, progressText, cancelButton } = progressUI;

        // Progress callback functions
        const progressCallbacks = {
            updateProgress: (percentage) => {
                progressFill.style.width = `${percentage}%`;
            },
            updateText: (text) => {
                progressText.textContent = text;
            },
            showError: (error) => {
                progressText.textContent = error;
                progressFill.style.backgroundColor = '#ff4444';
            },
            showCompletion: (message) => {
                progressText.textContent = message;
            },
            checkCancelled: () => {
                return batchFetchService.cancelFlag;
            }
        };

        // Cancel button handler
        cancelButton.onclick = () => {
            batchFetchService.cancel();
            cancelButton.textContent = 'Cancelling...';
            cancelButton.disabled = true;
            cancelButton.style.backgroundColor = '#6c757d';
            cancelButton.style.cursor = 'default';
            progressText.textContent = 'Cancelling operation...';
        };

        try {
            // Start batch fetch using the service
            const result = await batchFetchService.fetchAllLoras(
                this.loras,
                filterType,
                this.hasPreview.bind(this),
                progressCallbacks
            );

            // Wait to show completion
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (error) {
            console.error('Batch fetch error:', error);
            progressCallbacks.showError(`Error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        } finally {
            // Clean up UI
            if (loadingOverlay.parentNode) {
                loadingOverlay.parentNode.removeChild(loadingOverlay);
            }

            // Update preview availability cache and refresh
            try {
                await this.loadPreviewAvailability();
            } catch (error) {
                console.warn('Failed to update preview availability cache:', error);
            }

            // Refresh the LoRA list to show new previews
            if (this.refreshCallback) {
                this.refreshCallback();
            }
        }
    }

    /**
     * Create progress UI for batch operations
     * @param {string} filterType - Type of operation being performed
     * @returns {Object} Progress UI elements
     */
    createProgressUI(filterType) {
        const loadingOverlay = document.createElement('div');
        loadingOverlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            background-color: rgba(0,0,0,0.8) !important;
            z-index: 10001 !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            align-items: center !important;
            font-family: Arial, sans-serif !important;
            color: #ddd !important;
        `;

        const loadingText = document.createElement('div');
        loadingText.style.cssText = `
            font-size: 18px !important;
            margin-bottom: 10px !important;
        `;
        loadingText.textContent = `Fetching ${filterType} Previews...`;

        const progressText = document.createElement('div');
        progressText.style.cssText = `
            font-size: 14px !important;
            color: #aaa !important;
        `;
        progressText.textContent = 'Initializing...';

        const progressBar = document.createElement('div');
        progressBar.style.cssText = `
            width: 300px !important;
            height: 20px !important;
            background-color: #333 !important;
            border: 1px solid #555 !important;
            border-radius: 10px !important;
            margin-top: 10px !important;
            overflow: hidden !important;
        `;

        const progressFill = document.createElement('div');
        progressFill.style.cssText = `
            height: 100% !important;
            background-color: #007acc !important;
            width: 0% !important;
            transition: width 0.3s ease !important;
        `;

        // Add cancel button
        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.style.cssText = `
            margin-top: 15px !important;
            padding: 8px 16px !important;
            background-color: #dc3545 !important;
            color: white !important;
            border: none !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            font-family: Arial, sans-serif !important;
            font-size: 14px !important;
            transition: background-color 0.2s ease !important;
        `;

        cancelButton.onmouseover = () => {
            cancelButton.style.backgroundColor = '#c82333';
        };

        cancelButton.onmouseout = () => {
            cancelButton.style.backgroundColor = '#dc3545';
        };

        progressBar.appendChild(progressFill);
        loadingOverlay.appendChild(loadingText);
        loadingOverlay.appendChild(progressText);
        loadingOverlay.appendChild(progressBar);
        loadingOverlay.appendChild(cancelButton);
        document.body.appendChild(loadingOverlay);

        return { loadingOverlay, progressFill, progressText, cancelButton };
    }
}
