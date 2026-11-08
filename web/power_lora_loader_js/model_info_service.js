import { vidApi } from "./wanvid_api.js";
import { api } from "../../../scripts/api.js";
import { generatePreviewFromFirstImage } from "./image_utils.js";

class BaseModelInfoService extends EventTarget {
    constructor() {
        super();
        this.fileToInfo = new Map();
        this.init();
    }
    init() {
        api.addEventListener(this.apiRefreshEventString, this.handleAsyncUpdate.bind(this));
    }
    async getInfo(file, refresh, light) {
        if (this.fileToInfo.has(file) && !refresh) {
            return this.fileToInfo.get(file);
        }
        return this.fetchInfo(file, refresh, light);
    }
    async refreshInfo(file) {
        return this.fetchInfo(file, true);
    }
    async clearFetchedInfo(file) {
        if (this.modelInfoType === 'loras') {
            await vidApi.clearSingleLoraInfo(file);
        } else if (this.modelInfoType === 'checkpoints') {
            await vidApi.clearSingleCheckpointInfo(file);
        }
        this.fileToInfo.delete(file);
        return null;
    }
    async savePartialInfo(file, data, options = {}) {
        let info = await vidApi.saveModelInfo(this.modelInfoType, file, data);
        this.fileToInfo.set(file, info);

        // Generate preview image for LoRAs ONLY if explicitly requested and we have image data
        const { generatePreview = false } = options;

        if (generatePreview && this.modelInfoType === 'loras' && info && info.images && info.images.length > 0) {
            try {
                // Extract LoRA name from file path
                const loraName = file.replace(/\.[^/.]+$/, ""); // Remove extension
                const loraPath = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';

                // Generate and save preview image
                const previewResult = await generatePreviewFromFirstImage(info, loraName, loraPath);
            } catch (error) {
                console.warn(`[LoraInfoService] Failed to generate preview image for ${file}:`, error);
                // Don't let preview generation failure stop the save operation
            }
        }

        return info;
    }
    handleAsyncUpdate(event) {
        var _a;
        const info = (_a = event.detail) === null || _a === void 0 ? void 0 : _a.data;
        if (info === null || info === void 0 ? void 0 : info.file) {
            this.setFreshInfo(info.file, info);
        }
    }
    async fetchInfo(file, refresh = false, light = false) {
        var _a;
        let info = null;
        if (!refresh) {
            info = await vidApi.getModelsInfo({ type: this.modelInfoType, files: [file], light });
        }
        else {
            info = await vidApi.refreshModelsInfo({ type: this.modelInfoType, files: [file] });
        }
        info = (_a = info === null || info === void 0 ? void 0 : info[0]) !== null && _a !== void 0 ? _a : null;
        if (!light) {
            this.fileToInfo.set(file, info);
        }
        return info;
    }
    setFreshInfo(file, info) {
        this.fileToInfo.set(file, info);
    }
}

class LoraInfoService extends BaseModelInfoService {
    constructor() {
        super(...arguments);
        this.apiRefreshEventString = "wanvid-refreshed-loras-info";
        this.modelInfoType = 'loras';
    }
}

class CheckpointInfoService extends BaseModelInfoService {
    constructor() {
        super(...arguments);
        this.apiRefreshEventString = "wanvid-refreshed-checkpoints-info";
        this.modelInfoType = 'checkpoints';
    }
}

export const LORA_INFO_SERVICE = new LoraInfoService();
export const CHECKPOINT_INFO_SERVICE = new CheckpointInfoService();