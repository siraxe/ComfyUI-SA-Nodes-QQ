class QQApi {
    constructor(baseUrl) {
        this.getCheckpointsPromise = null;
        this.getSamplersPromise = null;
        this.getSchedulersPromise = null;
        this.getLorasPromise = null;
        this.getWorkflowsPromise = null;
        this.setBaseUrl(baseUrl);
    }
    setBaseUrl(baseUrlArg) {
        var _a;
        let baseUrl = null;
        if (baseUrlArg) {
            baseUrl = baseUrlArg;
        }
        else if (window.location.pathname.includes("/wanvid/")) {
            const parts = (_a = window.location.pathname.split("/wanvid/")[1]) === null || _a === void 0 ? void 0 : _a.split("/");
            if (parts && parts.length) {
                baseUrl = parts.map(() => "../").join("") + "wanvid/api";
            }
        }
        this.baseUrl = baseUrl || "./wanvid/api";
        const comfyBasePathname = location.pathname.includes("/wanvid/")
            ? location.pathname.split("wanvid/")[0]
            : location.pathname;
        this.comfyBaseUrl = comfyBasePathname.split("/").slice(0, -1).join("/");
    }
    apiURL(route) {
        return `${this.baseUrl}${route}`;
    }
    fetchApi(route, options) {
        return fetch(this.apiURL(route), options);
    }
    async fetchJson(route, options) {
        const r = await this.fetchApi(route, options);
        return await r.json();
    }
    async postJson(route, json) {
        const body = new FormData();
        body.append("json", JSON.stringify(json));
        return await vidApi.fetchJson(route, { method: "POST", body });
    }
    getLoras(force = false) {
        if (!this.getLorasPromise || force) {
            // Add a timestamp to prevent caching when force is true
            const url = force ? `/loras?format=details&t=${Date.now()}` : "/loras?format=details";
            this.getLorasPromise = this.fetchJson(url, { cache: "no-store" });
        }
        return this.getLorasPromise;
    }
    getCheckpoints(force = false) {
        if (!this.getCheckpointsPromise || force) {
            // Add a timestamp to prevent caching when force is true
            const url = force ? `/checkpoints?format=details&t=${Date.now()}` : "/checkpoints?format=details";
            this.getCheckpointsPromise = this.fetchJson(url, { cache: "no-store" });
        }
        return this.getCheckpointsPromise;
    }
    async fetchApiJsonOrNull(route, options) {
        const response = await this.fetchJson(route, options);
        if (response.status === 200 && response.data) {
            return response.data || null;
        }
        return null;
    }
    async getModelsInfo(options) {
        var _a;
        const params = new URLSearchParams();
        if ((_a = options.files) === null || _a === void 0 ? void 0 : _a.length) {
            params.set("files", options.files.join(","));
        }
        if (options.light) {
            params.set("light", "1");
        }
        if (options.format) {
            params.set("format", options.format);
        }
        const path = `/${options.type}/info?` + params.toString();
        return (await this.fetchApiJsonOrNull(path)) || [];
    }
    async getLorasInfo(options = {}) {
        return this.getModelsInfo({ type: "loras", ...options });
    }
    async getCheckpointsInfo(options = {}) {
        return this.getModelsInfo({ type: "checkpoints", ...options });
    }
    async refreshModelsInfo(options) {
        // Always require files parameter - no bulk refresh allowed
        if (!options.files || !options.files.length) {
            throw new Error('refreshModelsInfo requires files parameter - bulk refresh is not supported');
        }

        const params = new URLSearchParams();
        params.set("files", options.files.join(","));

        const path = `/${options.type}/info/refresh?` + params.toString();
        const infos = await this.fetchApiJsonOrNull(path);
        return infos;
    }

    // Single file refresh functions - no bulk operations
    async refreshSingleLoraInfo(file) {
        if (!file) {
            throw new Error('refreshSingleLoraInfo requires file parameter');
        }

        const result = await this.refreshModelsInfo({ type: "loras", files: [file] });

        // Clear the specific file from cache
        this.getLorasPromise = null; // Force refresh of list

        return result;
    }

    async refreshSingleCheckpointInfo(file) {
        if (!file) {
            throw new Error('refreshSingleCheckpointInfo requires file parameter');
        }

        return this.refreshModelsInfo({ type: "checkpoints", files: [file] });
    }
    async clearModelsInfo(options) {
        // Always require files parameter - no bulk clearing allowed
        if (!options.files || !options.files.length) {
            throw new Error('clearModelsInfo requires files parameter - bulk clearing is not supported');
        }

        const params = new URLSearchParams();
        params.set("files", options.files.join(","));

        const path = `/${options.type}/info/clear?` + params.toString();
        await this.fetchApiJsonOrNull(path);
        return;
    }

    // Single file clear functions - no bulk operations
    async clearSingleLoraInfo(file) {
        if (!file) {
            throw new Error('clearSingleLoraInfo requires file parameter');
        }

        return this.clearModelsInfo({ type: "loras", files: [file] });
    }

    async clearSingleCheckpointInfo(file) {
        if (!file) {
            throw new Error('clearSingleCheckpointInfo requires file parameter');
        }

        return this.clearModelsInfo({ type: "checkpoints", files: [file] });
    }
    async saveModelInfo(type, file, data) {
        const body = new FormData();
        body.append("json", JSON.stringify(data));
        return await this.fetchApiJsonOrNull(`/${type}/info?file=${encodeURIComponent(file)}`, { cache: "no-store", method: "POST", body });
    }
    async saveLoraInfo(file, data) {
        return this.saveModelInfo("loras", file, data);
    }
    async saveCheckpointsInfo(file, data) {
        return this.saveModelInfo("checkpoints", file, data);
    }
    fetchComfyApi(route, options) {
        const url = this.comfyBaseUrl + "/api" + route;
        options = options || {};
        options.headers = options.headers || {};
        options.cache = options.cache || "no-cache";
        return fetch(url, options);
    }
}
export const vidApi = new QQApi();