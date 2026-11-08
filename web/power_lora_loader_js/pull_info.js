/**
 * Unified Data Management Module for LoRA and Model Previews
 * Eliminates code duplication across power_lora_loader.js, power_lora_loader_v2.js, and power_model_loader_v2.js
 */

import { vidApi } from "./wanvid_api.js";

// ============================================================================
// DIRECTORY STRUCTURE MANAGER
// ============================================================================

class DirectoryStructureManager {
    /**
     * Get the base directory for the given item type
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {string} The base directory name
     */
    static getBaseDirectory(type) {
        return type === 'checkpoints' ? 'checkpoints' : 'loras';
    }

    /**
     * Get the preview directory for the given item type
     * @returns {string} The preview directory path
     */
    static getPreviewDirectory() {
        // Both types use _power_preview in their respective directories
        return '_power_preview';
    }

    /**
     * Get API parameters for the given type
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {Object} API parameters
     */
    static getApiParams(type) {
        return {
            isModel: type === 'checkpoints',
            is_model: type === 'checkpoints'
        };
    }
}

// ============================================================================
// UI STATE MANAGER
// ============================================================================

class UIManager {
    /**
     * Get localStorage key for the given type and suffix
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {string} suffix - 'Cache', 'favorites', 'foldersVisible', etc.
     * @returns {string} localStorage key
     */
    static getStorageKey(type, suffix) {
        const prefix = type === 'checkpoints' ? 'powerModelLoaderV2' : 'wanVideoPowerLoraLoader';
        return `${prefix}.${suffix}`;
    }

    /**
     * Save favorites to localStorage
     * @param {Array} favorites - Array of favorite item names
     * @param {string} type - 'loras' or 'checkpoints'
     */
    static saveFavorites(favorites, type) {
        const key = this.getStorageKey(type, 'favorites');
        localStorage.setItem(key, JSON.stringify(favorites));
    }

    /**
     * Load favorites from localStorage
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {Array} Array of favorite item names
     */
    static loadFavorites(type) {
        const key = this.getStorageKey(type, 'favorites');
        const favorites = localStorage.getItem(key);
        return favorites !== null ? JSON.parse(favorites) : [];
    }

    /**
     * Save UI state to localStorage
     * @param {Object} state - UI state object
     * @param {string} type - 'loras' or 'checkpoints'
     */
    static saveUIState(state, type) {
        const key = this.getStorageKey(type, 'uiState');
        localStorage.setItem(key, JSON.stringify(state));
    }

    /**
     * Load UI state from localStorage
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {Object} UI state object
     */
    static loadUIState(type) {
        const key = this.getStorageKey(type, 'uiState');
        const state = localStorage.getItem(key);
        return state !== null ? JSON.parse(state) : {};
    }

    /**
     * Save individual UI state properties
     * @param {string} property - Property name
     * @param {any} value - Property value
     * @param {string} type - 'loras' or 'checkpoints'
     */
    static saveUIProperty(property, value, type) {
        const key = this.getStorageKey(type, property);
        localStorage.setItem(key, JSON.stringify(value));
    }

    /**
     * Load individual UI state properties
     * @param {string} property - Property name
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {any} defaultValue - Default value if not found
     * @returns {any} Property value or default
     */
    static loadUIProperty(property, type, defaultValue = null) {
        const key = this.getStorageKey(type, property);
        const value = localStorage.getItem(key);
        return value !== null ? JSON.parse(value) : defaultValue;
    }
}

// ============================================================================
// MODEL DATA MANAGER
// ============================================================================

class ModelDataManager {
    constructor() {
        this.caches = {
            loras: null,
            checkpoints: null
        };
        this.lastLoadTimes = {
            loras: 0,
            checkpoints: 0
        };
        this.previewLoadPromises = {
            loras: null,
            checkpoints: null
        };
        this.previewAvailabilityCaches = {
            loras: new Set(),
            checkpoints: new Set()
        };
    }

    /**
     * Get items (LoRAs or Models) with caching
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {boolean} forceRefresh - Force refresh from API
     * @returns {Promise<Array>} Array of items with name and mtime
     */
    async getItems(type = 'loras', forceRefresh = false) {
        // Check if we have cached data and it's not expired
        const now = Date.now();
        const cacheKey = type;
        const storageKey = UIManager.getStorageKey(type, 'Cache');

        if (!forceRefresh && this.caches[cacheKey]) {
            const cachedData = localStorage.getItem(storageKey);
            if (cachedData) {
                try {
                    const parsed = JSON.parse(cachedData);
                    if (parsed && parsed.length > 0) {
                        return this.caches[cacheKey];
                    }
                } catch (e) {
                    console.warn(`[${type.toUpperCase()}] Failed to parse cached data:`, e);
                }
            }
        }

        // Clear cache if force refresh is requested
        if (forceRefresh) {
            this.caches[cacheKey] = null;
            localStorage.removeItem(storageKey);
        }

        try {
            let itemsData;

            // Use appropriate vidApi method
            if (type === 'checkpoints') {
                itemsData = await vidApi.getCheckpoints(forceRefresh);
            } else {
                itemsData = await vidApi.getLoras(forceRefresh);
            }

            // Convert vidApi format to our expected format
            if (!itemsData || !Array.isArray(itemsData)) {
                this.caches[cacheKey] = [];
            } else {
                this.caches[cacheKey] = itemsData
                    .filter(item => item != null)
                    .map(item => {
                        if (typeof item === 'string') {
                            return { name: item, mtime: 0 };
                        }
                        return {
                            name: item.name || item.filename || item.file || JSON.stringify(item),
                            mtime: item.mtime || item.modified || item.modified_time || 0
                        };
                    });
            }

            // Cache the data in localStorage
            localStorage.setItem(storageKey, JSON.stringify(this.caches[cacheKey]));
            this.lastLoadTimes[cacheKey] = now;

            return this.caches[cacheKey];

        } catch (error) {
            console.error(`[${type.toUpperCase()}] Failed to fetch items:`, error);
            return [];
        }
    }

    /**
     * Get preview availability with caching and debouncing
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {Promise<Set>} Set of item names that have previews
     */
    async getPreviewAvailability(type = 'loras') {
        // Prevent multiple simultaneous calls only
        const cacheKey = type;
        if (this.previewLoadPromises[cacheKey]) {
            return this.previewLoadPromises[cacheKey];
        }

        this.previewLoadPromises[cacheKey] = this._loadPreviewAvailabilityInternal(type);

        try {
            const result = await this.previewLoadPromises[cacheKey];
            return result;
        } finally {
            this.previewLoadPromises[cacheKey] = null;
        }
    }

    /**
     * Internal method to load preview availability
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {Promise<Set>} Set of item names that have previews
     */
    async _loadPreviewAvailabilityInternal(type) {
        try {
            const apiParams = DirectoryStructureManager.getApiParams(type);
            const url = `/wanvid/api/loras/previews${apiParams.isModel ? '?is_model=true' : ''}`;
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                if (data.status === 200 && data.previews && Array.isArray(data.previews)) {
                    this.previewAvailabilityCaches[type].clear();
                    data.previews.forEach(preview => {
                        if (preview && preview.lora) {
                            this.previewAvailabilityCaches[type].add(preview.lora);
                        }
                    });
                    return this.previewAvailabilityCaches[type];
                }
            } else {
                console.warn(`[Preview] API returned non-OK status for ${type}:`, response.status);
            }
        } catch (error) {
            console.error(`[Preview] Error loading preview availability for ${type}:`, error);
            // Don't clear cache on error, keep existing data
        }

        return this.previewAvailabilityCaches[type];
    }

    /**
     * Check if an item has preview available
     * @param {string} itemName - Name of the item
     * @param {string} type - 'loras' or 'checkpoints'
     * @returns {boolean} True if preview is available
     */
    hasPreview(itemName, type = 'loras') {
        return this.previewAvailabilityCaches[type].has(itemName);
    }

    /**
     * Save a preview image for an item
     * @param {File} imageFile - The image file to save
     * @param {string} itemName - Name of the item
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {string} suffix - Optional suffix for the image
     * @param {string} subfolder - Optional subfolder path
     * @returns {Promise<Object>} Response from the API
     */
    async savePreviewImage(imageFile, itemName, type, suffix = '', subfolder = '') {
        const formData = new FormData();
        formData.append('image', imageFile);
        if (type === 'checkpoints') {
            formData.append('model_name', itemName);
            formData.append('model_path', subfolder);
        } else {
            formData.append('lora_name', itemName);
            formData.append('lora_path', subfolder);
        }
        formData.append('suffix', suffix);
        formData.append('is_model', type === 'checkpoints' ? 'true' : 'false');

        const response = await fetch('/wanvid/api/lora/preview-image', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Failed to save preview image: ${response.statusText}`);
        }

        return response.json();
    }

    /**
     * Save JSON data for an item
     * @param {Object} jsonData - JSON data to save
     * @param {string} itemName - Name of the item
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {string} subfolder - Optional subfolder path
     * @returns {Promise<Object>} Response from the API
     */
    async saveJsonData(jsonData, itemName, type, subfolder = '') {
        const formData = new FormData();
        formData.append('json', JSON.stringify(jsonData));
        formData.append(type === 'checkpoints' ? 'model_name' : 'lora_name', itemName);
        formData.append(type === 'checkpoints' ? 'model_path' : 'lora_path', subfolder);

        const endpoint = type === 'checkpoints' ?
            '/wanvid/api/model/preview-json' :
            '/wanvid/api/lora/preview-json';

        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Failed to save JSON data: ${response.statusText}`);
        }

        return response.json();
    }

    /**
     * Get preview image URL
     * @param {string} itemName - Name of the item (without extension)
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {string} suffix - Optional suffix
     * @param {string} subfolder - Optional subfolder
     * @returns {string} Preview image URL
     */
    getPreviewImageUrl(itemName, type, suffix = '', subfolder = '') {
        const apiParams = DirectoryStructureManager.getApiParams(type);
        const url = new URL('/wanvid/api/loras/preview', window.location.origin);
        url.searchParams.set('file', itemName);

        if (subfolder) {
            url.searchParams.set('subfolder', subfolder);
        }

        if (suffix) {
            url.searchParams.set('suffix', suffix);
        }

        if (apiParams.isModel) {
            url.searchParams.set('is_model', 'true');
        }

        const finalUrl = url.toString();
        return finalUrl;
    }

    /**
     * Get JSON data for an item
     * @param {string} itemName - Name of the item (without extension)
     * @param {string} type - 'loras' or 'checkpoints'
     * @param {string} subfolder - Optional subfolder
     * @returns {Promise<Object|null>} JSON data or null if not found
     */
    async getJsonData(itemName, type, subfolder = '') {
        const apiParams = DirectoryStructureManager.getApiParams(type);
        const jsonFilename = itemName + '.json';

        const attempts = [
            // Method 1: Try the modified preview endpoint that now supports JSON
            `/wanvid/api/loras/preview?file=${jsonFilename}${subfolder ? '&subfolder=' + subfolder : ''}${apiParams.isModel ? '&is_model=true' : ''}`,
        ];

        // Add type-specific fallbacks
        if (apiParams.isModel) {
            attempts.push(
                `/api/view?filename=${jsonFilename}&subfolder=_power_preview&type=models`,
                `/api/view?filename=${jsonFilename}&subfolder=_power_preview/${subfolder}&type=models`,
                `/api/view?filename=${jsonFilename}&subfolder=_power_preview&type=models`
            );
        } else {
            attempts.push(
                `/api/view?filename=${jsonFilename}&subfolder=${subfolder}/_power_preview&type=models`,
                `/api/view?filename=${jsonFilename}&subfolder=_power_preview/${subfolder}&type=models`,
                `/api/view?filename=${jsonFilename}&subfolder=_power_preview&type=models`
            );
        }

        for (const attempt of attempts) {
            try {
                const response = await fetch(attempt);
                if (response.ok) {
                    const jsonData = await response.json();
                    return jsonData;
                }
            } catch (attemptError) {
                continue;
            }
        }
        return null;
    }

    /**
     * Clear all caches
     * @param {string} type - 'loras', 'checkpoints', or 'all'
     */
    clearCaches(type = 'all') {
        if (type === 'all' || type === 'loras') {
            this.caches.loras = null;
            this.previewAvailabilityCaches.loras.clear();
            localStorage.removeItem(UIManager.getStorageKey('loras', 'Cache'));
        }

        if (type === 'all' || type === 'checkpoints') {
            this.caches.checkpoints = null;
            this.previewAvailabilityCaches.checkpoints.clear();
            localStorage.removeItem(UIManager.getStorageKey('checkpoints', 'Cache'));
        }
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

// Create singleton instance
const modelDataManager = new ModelDataManager();

export {
    ModelDataManager,
    UIManager,
    DirectoryStructureManager,
    modelDataManager
};