import { WanDialog } from "./dialog.js";
import { createElement as $el, empty, appendChildren, getClosestOrSelf, query, queryAll, setAttributes } from "./utils_dom.js";
import { logoCivitai, link, pencilColored, diskColored, dotdotdot } from "./svgs.js";
import { LORA_INFO_SERVICE } from "./model_info_service.js";
import { generateId, injectCss } from "./shared_utils.js";
import { rgthree } from "../rgthree/common/rgthree.js";
import { proxyImageUrl } from "./image_utils.js";

class WanInfoDialog extends WanDialog {
    constructor(file) {
        const dialogOptions = {
            class: "rgthree-info-dialog",
            title: `<h2>Loading...</h2>`,
            content: "<center>Loading..</center>",
            onBeforeClose: () => {
                return true;
            },
        };
        super(dialogOptions);
        this.modifiedModelData = false;
        this.modelInfo = null;
        this.init(file);
    }
    async init(file) {
        var _a, _b;
        const cssPromise = this.injectCss("wan-dialog-model-info.css");
        this.modelInfo = await this.getModelInfo(file);
        await cssPromise;
        this.setContent(this.getInfoContent());
        this.setTitle(((_a = this.modelInfo) === null || _a === void 0 ? void 0 : _a["name"]) || ((_b = this.modelInfo) === null || _b === void 0 ? void 0 : _b["file"]) || "Unknown");
        this.attachEvents();
    }

    async injectCss(fileName) {
        const css = `
            /* Base dialog styling - match power lora UI */
            .wan-dialog {
                outline: 0;
                border: 1px solid #000;
                border-radius: 0px;
                background: #1a1a1a;
                color: #ddd;
                box-shadow: 0 2px 6px rgba(0,0,0,0.8);
                max-width: 800px;
                box-sizing: border-box;
                font-family: Arial, sans-serif;
                font-size: 12px;
                padding: 0;
                max-height: calc(100% - 32px);
            }
            .wan-dialog *, .wan-dialog *::before, .wan-dialog *::after {
                box-sizing: inherit;
            }
            .wan-dialog-container > * {
                padding: 4px 8px;
            }
            .wan-dialog-container > *:first-child {
                padding-top: 8px;
            }
            .wan-dialog-container > *:last-child {
                padding-bottom: 8px;
            }
            .wan-dialog-container-title h2 {
                font-size: 14px;
                margin: 0;
                font-weight: bold;
                color: #ddd;
            }
            .wan-dialog-container-content {
                overflow: auto;
                max-height: calc(100vh - 200px);
            }
            .wan-dialog-container-footer {
                display: flex;
                align-items: center;
                justify-content: center;
            }
            body.wan-dialog-open > *:not(.wan-dialog) {
                filter: blur(5px);
            }

            /* Info dialog specific styling - match power lora UI */
            .rgthree-info-dialog {
                width: 90vw;
                max-width: 960px;
            }
            .rgthree-info-dialog .rgthree-info-area {
                list-style: none;
                padding: 0;
                margin: 0;
                display: flex;
            }
            .rgthree-info-dialog .rgthree-info-area > li {
                display: inline-flex;
                margin: 0;
                vertical-align: top;
            }
            .rgthree-info-dialog .rgthree-info-area > li + li {
                margin-left: 4px;
            }
            .rgthree-info-dialog .rgthree-info-area > li:not(.-link) + li.-link {
                margin-left: auto;
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > * {
                min-height: 20px;
                border-radius: 0px;
                line-height: 1;
                color: #ddd;
                background: #2a2a2a;
                font-size: 11px;
                font-weight: bold;
                text-decoration: none;
                display: flex;
                height: 1.4em;
                padding: 2px 6px;
                align-content: center;
                justify-content: center;
                align-items: center;
                border: 1px solid #333;
            }
            .rgthree-info-dialog .rgthree-info-area > li.-type > * {
                background: #2a2a2a;
                color: #89B;
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > * > svg {
                width: 16px;
                height: 16px;
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > *:empty {
                display: none;
            }

            /* Table styling - match power lora UI */
            .rgthree-info-dialog .rgthree-info-table {
                border-collapse: collapse;
                margin: 8px 0px;
                width: 100%;
                font-size: 11px;
            }
            .rgthree-info-dialog .rgthree-info-table td {
                position: relative;
                border: 1px solid #333;
                padding: 0;
                vertical-align: top;
                background: #1a1a1a;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child {
                background: #222;
                width: 10px;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child > *:first-child {
                white-space: nowrap;
                padding-right: 24px;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small {
                display: block;
                margin-top: 2px;
                opacity: 0.75;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small > [data-action] {
                text-decoration: underline;
                cursor: pointer;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small > [data-action]:hover {
                text-decoration: none;
            }
            .rgthree-info-dialog .rgthree-info-table td a,
            .rgthree-info-dialog .rgthree-info-table td a:hover,
            .rgthree-info-dialog .rgthree-info-table td a:visited {
                color: #89B;
            }
            .rgthree-info-dialog .rgthree-info-table td svg {
                width: 1.2em;
                height: 1.2em;
                vertical-align: -0.2em;
            }
            .rgthree-info-dialog .rgthree-info-table td svg.logo-civitai {
                margin-right: 0.2em;
            }
            .rgthree-info-dialog .rgthree-info-table td > *:first-child {
                display: block;
                padding: 4px 8px;
            }
            .rgthree-info-dialog .rgthree-info-table td > input,
            .rgthree-info-dialog .rgthree-info-table td > textarea {
                padding: 4px 6px;
                border: 1px solid #333;
                box-shadow: none;
                font-family: Arial, sans-serif;
                font-size: 11px;
                appearance: none;
                background: #222;
                color: #ddd;
                resize: vertical;
                width: 100%;
            }
            .rgthree-info-dialog .rgthree-info-table td > input:focus,
            .rgthree-info-dialog .rgthree-info-table td > textarea:focus {
                border-color: #555;
                background: #2a2a2a;
                outline: none;
            }
            .rgthree-info-dialog .rgthree-info-table tr[data-field-name=userNote] td > span:first-child {
                white-space: pre;
            }
            .rgthree-info-dialog .rgthree-info-table td .-help {
                border: 1px solid #555;
                position: absolute;
                right: 4px;
                top: 4px;
                line-height: 1;
                font-size: 10px;
                width: 12px;
                height: 12px;
                border-radius: 0px;
                display: flex;
                align-content: center;
                justify-content: center;
                cursor: help;
                background: #222;
            }
            .rgthree-info-dialog .rgthree-info-table td .-help::before {
                content: "?";
            }

            /* Button styling - match power lora UI */
            .rgthree-button {
                position: relative;
                cursor: pointer;
                border: 1px solid #000;
                border-radius: 0px;
                background: #1a1a1a;
                color: #ddd;
                font-family: Arial, sans-serif;
                font-size: 11px;
                line-height: 1;
                white-space: nowrap;
                text-decoration: none;
                margin: 2px;
                box-shadow: none;
                transition: all 0.1s ease-in-out;
                padding: 4px 8px;
                display: inline-flex;
                flex-direction: row;
                align-items: center;
                justify-content: center;
            }
            .rgthree-button:hover {
                background: #2a2a2a;
            }
            .rgthree-button:active {
                background: #333;
            }
            .rgthree-info-dialog .rgthree-info-table .rgthree-button[data-action=fetch-civitai] {
                font-size: inherit;
                padding: 4px 8px;
                margin: 2px;
            }

            /* Edit button styling */
            .rgthree-button-edit {
                background: none;
                border: none;
                cursor: pointer;
                padding: 2px;
                color: #ddd;
                opacity: 0.7;
                display: flex;
                width: 24px;
                height: 24px;
                align-items: center;
                justify-content: center;
            }
            .rgthree-button-edit:hover {
                opacity: 1;
                color: #89B;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable button svg + svg {
                display: none;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable.-rgthree-editing button svg {
                display: none;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable.-rgthree-editing button svg + svg {
                display: inline-block;
            }

            /* Trained words styling - match power lora UI */
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list {
                list-style: none;
                padding: 2px 4px;
                margin: 0;
                display: flex;
                flex-direction: row;
                flex-wrap: wrap;
                max-height: 15vh;
                overflow: auto;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li {
                display: inline-flex;
                margin: 1px;
                vertical-align: top;
                border-radius: 0px;
                line-height: 1;
                color: #ddd;
                background: #2a2a2a;
                font-size: 11px;
                font-weight: 600;
                text-decoration: none;
                display: flex;
                height: 1.4em;
                align-content: center;
                justify-content: center;
                align-items: center;
                border: 1px solid #333;
                cursor: pointer;
                white-space: nowrap;
                max-width: 183px;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li:hover {
                background: #333;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > svg {
                width: auto;
                height: 1em;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > span {
                padding-left: 0.3em;
                padding-right: 0.3em;
                padding-bottom: 0.1em;
                text-overflow: ellipsis;
                overflow: hidden;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > small {
                align-self: stretch;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 0.3em;
                background: rgba(0, 0, 0, 0.2);
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li.-rgthree-is-selected {
                background: #444;
                color: #89B;
            }

            /* Images styling - match power lora UI */
            .rgthree-info-dialog .rgthree-info-images {
                list-style: none;
                padding: 0;
                margin: 0;
                scroll-snap-type: x mandatory;
                display: flex;
                flex-direction: row;
                overflow: auto;
            }
            .rgthree-info-dialog .rgthree-info-images > li {
                scroll-snap-align: start;
                max-width: 90%;
                flex: 0 0 auto;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                overflow: hidden;
                padding: 0;
                margin: 4px;
                font-size: 0;
                position: relative;
                border: 1px solid #333;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure {
                margin: 0;
                position: static;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure video,
            .rgthree-info-dialog .rgthree-info-images > li figure img {
                max-height: 45vh;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption {
                position: absolute;
                left: 0;
                width: 100%;
                bottom: 0;
                padding: 8px;
                font-size: 11px;
                background: rgba(0, 0, 0, 0.9);
                opacity: 0;
                transform: translateY(50px);
                transition: all 0.25s ease-in-out;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span {
                display: inline-block;
                padding: 2px 4px;
                margin: 1px;
                border-radius: 0px;
                border: 1px solid #333;
                word-break: break-word;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span label {
                display: inline;
                padding: 0;
                margin: 0;
                opacity: 0.5;
                pointer-events: none;
                user-select: none;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a {
                color: #89B;
                text-decoration: underline;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a:hover {
                text-decoration: none;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a svg {
                height: 10px;
                margin-left: 4px;
                fill: currentColor;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption:empty {
                text-align: center;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption:empty::before {
                content: "No data.";
            }
            .rgthree-info-dialog .rgthree-info-images > li:hover figure figcaption {
                opacity: 1;
                transform: translateY(0px);
            }

            /* Constrain long prompt text (positive/negative) so the caption
               doesn't grow past the image and clip off the Copy+ button. */
            .rgthree-info-dialog .rgthree-info-images figure figcaption > span.-info-field-long {
                display: block;
                max-height: 8.8em; /* ~8 lines at 11px font */
                overflow-y: auto;
                overscroll-behavior: contain;
            }
            .rgthree-info-dialog .rgthree-info-images figure figcaption > span.-info-field-long > label {
                position: sticky;
                left: 0;
            }
            .rgthree-info-dialog .rgthree-info-images figure figcaption > span.-info-field-long::-webkit-scrollbar {
                width: 6px;
            }
            .rgthree-info-dialog .rgthree-info-images figure figcaption > span.-info-field-long::-webkit-scrollbar-thumb {
                background: #444;
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return Promise.resolve();
    }

    getCloseEventDetail() {
        const detail = {
            dirty: this.modifiedModelData,
        };
        return { detail };
    }

    attachEvents() {
        this.contentElement.addEventListener("click", async (e) => {
            const target = getClosestOrSelf(e.target, "[data-action]");
            const action = target === null || target === void 0 ? void 0 : target.getAttribute("data-action");
            if (!target || !action) {
                return;
            }
            await this.handleEventAction(action, target, e);
        });
    }

    async handleEventAction(action, target, e) {
        var _a, _b;
        const info = this.modelInfo;
        if (!(info === null || info === void 0 ? void 0 : info.file)) {
            return;
        }
        if (action === "refresh-info") {
            // Show loading state
            target.textContent = "Refreshing...";
            target.disabled = true;
            
            try {
                this.modelInfo = await this.refreshModelInfo(info.file);
                this.setContent(this.getInfoContent());
                this.setTitle(((_a = this.modelInfo) === null || _a === void 0 ? void 0 : _a["name"]) || ((_b = this.modelInfo) === null || _b === void 0 ? void 0 : _b["file"]) || "Unknown");

                // Generate preview image after successful refresh if we have image data
                if (this.modelInfo && this.modelInfo.images && this.modelInfo.images.length > 0) {
                    try {
                        // Extract LoRA name from file path
                        const loraName = info.file.replace(/\.[^/.]+$/, ""); // Remove extension
                        const loraPath = info.file.includes('/') ? info.file.substring(0, info.file.lastIndexOf('/')) : '';

                        // Import and use the preview generation function
                        const { generatePreviewFromFirstImage } = await import('./image_utils.js');
                        // Determine item type from dialog instance or default to 'loras'
                        const itemType = this.itemType || 'loras';
                        const previewResult = await generatePreviewFromFirstImage(this.modelInfo, loraName, loraPath, itemType);

                        // Add to success message
                        const itemTypeName = itemType === 'checkpoints' ? 'Model' : 'LoRA';
                        rgthree.showMessage({
                            id: "refresh-info-" + generateId(4),
                            type: "success",
                            message: `${itemTypeName} information refreshed successfully (preview image generated)`,
                            timeout: 3000,
                        });
                    } catch (previewError) {
                        // Still show success message for the refresh itself
                        rgthree.showMessage({
                            id: "refresh-info-" + generateId(4),
                            type: "success",
                            message: "LoRA information refreshed successfully",
                            timeout: 3000,
                        });
                    }
                } else {
                    // Show success message
                    rgthree.showMessage({
                        id: "refresh-info-" + generateId(4),
                        type: "success",
                        message: "LoRA information refreshed successfully",
                        timeout: 3000,
                    });
                }
            } catch (error) {
                // Show error message
                rgthree.showMessage({
                    id: "refresh-info-error-" + generateId(4),
                    type: "error",
                    message: "Failed to refresh LoRA information",
                    timeout: 3000,
                });
            }
        }
        else if (action === "fetch-civitai") {
            this.modelInfo = await this.refreshModelInfo(info.file);
            this.setContent(this.getInfoContent());
            this.setTitle(((_a = this.modelInfo) === null || _a === void 0 ? void 0 : _a["name"]) || ((_b = this.modelInfo) === null || _b === void 0 ? void 0 : _b["file"]) || "Unknown");

            // Generate preview image after successful Civitai fetch if we have image data
            if (this.modelInfo && this.modelInfo.images && this.modelInfo.images.length > 0) {
                try {
                    // Extract LoRA name from file path
                    const loraName = info.file.replace(/\.[^/.]+$/, ""); // Remove extension
                    const loraPath = info.file.includes('/') ? info.file.substring(0, info.file.lastIndexOf('/')) : '';

                    // Import and use the preview generation function
                    const { generatePreviewFromFirstImage } = await import('./image_utils.js');
                    // Determine item type from dialog instance or default to 'loras'
                    const itemType = this.itemType || 'loras';
                    const previewResult = await generatePreviewFromFirstImage(this.modelInfo, loraName, loraPath, itemType);
                } catch (previewError) {
                }
            }
        }
        else if (action === "copy-positive") {
            // Get the positive prompt from the data attribute
            const positivePrompt = target.getAttribute("data-positive") ? decodeURIComponent(target.getAttribute("data-positive")) : "";
            
            if (positivePrompt) {
                await navigator.clipboard.writeText(positivePrompt);
                rgthree.showMessage({
                    id: "copy-positive-" + generateId(4),
                    type: "success",
                    message: "Positive prompt copied to clipboard",
                    timeout: 3000,
                });
            } else {
                rgthree.showMessage({
                    id: "copy-positive-error-" + generateId(4),
                    type: "error",
                    message: "No positive prompt found to copy",
                    timeout: 3000,
                });
            }
        }
        else if (action === "copy-trained-words") {
            const selected = queryAll(".-rgthree-is-selected", target.closest("tr"));
            const text = selected.map((el) => el.getAttribute("data-word")).join(", ");
            await navigator.clipboard.writeText(text);
            rgthree.showMessage({
                id: "copy-trained-words-" + generateId(4),
                type: "success",
                message: `Successfully copied ${selected.length} key word${selected.length === 1 ? "" : "s"}.`,
                timeout: 4000,
            });
        }
        else if (action === "toggle-trained-word") {
            target === null || target === void 0 ? void 0 : target.classList.toggle("-rgthree-is-selected");
            const tr = target.closest("tr");
            if (tr) {
                const span = query("td:first-child > *", tr);
                let small = query("small", span);
                if (!small) {
                    small = $el("small", { parent: span });
                }
                const num = queryAll(".-rgthree-is-selected", tr).length;
                small.innerHTML = num
                    ? `${num} selected | <span role="button" data-action="copy-trained-words">Copy</span>`
                    : "";
            }
        }
        else if (action === "edit-row") {
            const tr = target.closest("tr");
            const td = query("td:nth-child(2)", tr);
            const input = td.querySelector("input,textarea");
            if (!input) {
                const fieldName = tr.dataset["fieldName"];
                tr.classList.add("-rgthree-editing");
                const isTextarea = fieldName === "userNote";
                const input = $el(`${isTextarea ? "textarea" : 'input[type="text"]'}`, {
                    value: td.textContent,
                });
                input.addEventListener("keydown", (e) => {
                    if (!isTextarea && e.key === "Enter") {
                        const modified = saveEditableRow(info, tr, true);
                        this.modifiedModelData = this.modifiedModelData || modified;
                        e.stopPropagation();
                        e.preventDefault();
                    }
                    else if (e.key === "Escape") {
                        const modified = saveEditableRow(info, tr, false);
                        this.modifiedModelData = this.modifiedModelData || modified;
                        e.stopPropagation();
                        e.preventDefault();
                    }
                });
                appendChildren(empty(td), [input]);
                input.focus();
            }
            else if (target.nodeName.toLowerCase() === "button") {
                const modified = saveEditableRow(info, tr, true);
                this.modifiedModelData = this.modifiedModelData || modified;
            }
            e === null || e === void 0 ? void 0 : e.preventDefault();
            e === null || e === void 0 ? void 0 : e.stopPropagation();
        }
    }

    getInfoContent() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        const info = this.modelInfo || {};
        const civitaiLink = (_a = info.links) === null || _a === void 0 ? void 0 : _a.find((i) => i.includes("civitai.com/models"));
        const html = `
      <ul class="rgthree-info-area">
        <li title="Type" class="rgthree-info-tag -type -type-${(info.type || "").toLowerCase()}"><span>${info.type || ""}</span></li>
        <li title="Base Model" class="rgthree-info-tag -basemodel -basemodel-${(info.baseModel || "").toLowerCase()}"><span>${info.baseModel || ""}</span></li>
        <li class="rgthree-info-menu" stub="menu"></li>
        ${""}
      </ul>

      <table class="rgthree-info-table">
        ${infoTableRow("File", `${info.file || ""} <button class="rgthree-button" data-action="refresh-info" style="margin-left: 8px; padding: 2px 6px; font-size: 10px;">↻ Refresh</button>`)}
        ${infoTableRow("Hash (sha256)", info.sha256 || "")}
        ${civitaiLink
            ? infoTableRow("Civitai", `<a href="${civitaiLink}" target="_blank">${logoCivitai}View on Civitai</a>`)
            : ((_c = (_b = info.raw) === null || _b === void 0 ? void 0 : _b.civitai) === null || _c === void 0 ? void 0 : _c.error) === "Model not found"
                ? infoTableRow("Civitai", '<i>Model not found</i> <span class="-help" title="The model was not found on civitai with the sha256 hash. It\'s possible the model was removed, re-uploaded, or was never on civitai to begin with."></span>')
                : ((_e = (_d = info.raw) === null || _d === void 0 ? void 0 : _d.civitai) === null || _e === void 0 ? void 0 : _e.error)
                    ? infoTableRow("Civitai", (_g = (_f = info.raw) === null || _f === void 0 ? void 0 : _f.civitai) === null || _g === void 0 ? void 0 : _g.error)
                    : !((_h = info.raw) === null || _h === void 0 ? void 0 : _h.civitai)
                        ? infoTableRow("Civitai", `<button class="rgthree-button" data-action="fetch-civitai">Fetch info from civitai</button>`)
                        : ""}

        ${infoTableRow("Name", info.name || ((_k = (_j = info.raw) === null || _j === void 0 ? void 0 : _j.metadata) === null || _k === void 0 ? void 0 : _k.ss_output_name) || "", "The name for display.", "name")}

        ${!info.baseModelFile && !info.baseModelFile
            ? ""
            : infoTableRow("Base Model", (info.baseModel || "") + (info.baseModelFile ? ` (${info.baseModelFile})` : ""))}


        ${!((_l = info.trainedWords) === null || _l === void 0 ? void 0 : _l.length)
            ? ""
            : infoTableRow("Trained Words", (_m = getTrainedWordsMarkup(info.trainedWords)) !== null && _m !== void 0 ? _m : "", "Trained words from the metadata and/or civitai. Click to select for copy.")}

        ${!((_p = (_o = info.raw) === null || _o === void 0 ? void 0 : _o.metadata) === null || _p === void 0 ? void 0 : _p.ss_clip_skip) || ((_r = (_q = info.raw) === null || _q === void 0 ? void 0 : _q.metadata) === null || _r === void 0 ? void 0 : _r.ss_clip_skip) == "None"
            ? ""
            : infoTableRow("Clip Skip", (_t = (_s = info.raw) === null || _s === void 0 ? void 0 : _s.metadata) === null || _t === void 0 ? void 0 : _t.ss_clip_skip)}
        ${infoTableRow("Strength Min", (_u = info.strengthMin) !== null && _u !== void 0 ? _u : "", "The recommended minimum strength, In the Power Lora Loader node, strength will signal when it is below this threshold.", "strengthMin")}
        ${infoTableRow("Strength Max", (_v = info.strengthMax) !== null && _v !== void 0 ? _v : "", "The recommended maximum strength. In the Power Lora Loader node, strength will signal when it is above this threshold.", "strengthMax")}
        ${""}
        ${infoTableRow("Additional Notes", (_w = info.userNote) !== null && _w !== void 0 ? _w : "", "Additional notes you'd like to keep and reference in the info dialog.", "userNote")}

      </table>

      <ul class="rgthree-info-images">${(_y = (_x = info.images) === null || _x === void 0 ? void 0 : _x.map((img) => {
        // Use proxy for Civitai images to avoid CSP violations
        const proxiedUrl = proxyImageUrl(img.url);
        return `
        <li>
          <figure>${img.type === 'video'
            ? `<video src="${proxiedUrl}" autoplay loop muted playsinline></video>`
            : `<img src="${proxiedUrl}" />`}
            <figcaption><!--
              -->${imgInfoField("", img.civitaiUrl
            ? `<a href="${img.civitaiUrl}" target="_blank">civitai${link}</a> ${img.positive ? `<button class="rgthree-button" data-action="copy-positive" data-positive="${encodeURIComponent(img.positive)}" style="margin-left: 4px; padding: 1px 4px; font-size: 9px;">Copy+</button>` : ""}`
            : undefined)}<!--
              -->${imgInfoField("seed", img.seed)}<!--
              -->${imgInfoField("steps", img.steps)}<!--
              -->${imgInfoField("cfg", img.cfg)}<!--
              -->${imgInfoField("sampler", img.sampler)}<!--
              -->${imgInfoField("model", img.model)}<!--
              -->${imgInfoField("positive", img.positive)}<!--
              -->${imgInfoField("negative", img.negative)}<!--
            --><!--${""}--></figcaption>
          </figure>
        </li>`;
      }).join("")) !== null && _y !== void 0 ? _y : ""}</ul>
    `;
        const div = $el("div", { html });
        if (rgthree.isDevMode()) {
            setAttributes(query('[stub="menu"]', div), {
                children: [
                    // Menu button functionality would go here
                ],
            });
        }
        return div;
    }
}

export class WanLoraInfoDialog extends WanInfoDialog {
    async getModelInfo(file) {
        return LORA_INFO_SERVICE.getInfo(file, false, false);
    }
    async refreshModelInfo(file) {
        return LORA_INFO_SERVICE.refreshInfo(file);
    }
    async clearModelInfo(file) {
        return LORA_INFO_SERVICE.clearFetchedInfo(file);
    }
}

function infoTableRow(name, value, help = "", editableFieldName = "") {
    return `
    <tr class="${editableFieldName ? "editable" : ""}" ${editableFieldName ? `data-field-name="${editableFieldName}"` : ""}>
      <td><span>${name} ${help ? `<span class="-help" title="${help}">ℹ️</span>` : ""}<span></td>
      <td ${editableFieldName ? "" : 'colspan="2"'}>${String(value).startsWith("<") ? value : `<span>${value}<span>`}</td>
      ${editableFieldName
        ? `<td style="width: 24px;"><button class="rgthree-button-edit" data-action="edit-row">${pencilColored}${diskColored}</button></td>`
        : ""}
    </tr>`;
}

function getTrainedWordsMarkup(words) {
    let markup = `<ul class="rgthree-info-trained-words-list">`;
    for (const wordData of words || []) {
        markup += `<li title="${wordData.word}" data-word="${wordData.word}" class="rgthree-info-trained-words-list-item" data-action="toggle-trained-word">
      <span>${wordData.word}</span>
      ${wordData.civitai ? logoCivitai : ""}
      ${wordData.count != null ? `<small>${wordData.count}</small>` : ""}
    </li>`;
    }
    markup += `</ul>`;
    return markup;
}

function saveEditableRow(info, tr, saving = true) {
    var _a;
    const fieldName = tr.dataset["fieldName"];
    const input = query("input,textarea", tr);
    let newValue = (_a = info[fieldName]) !== null && _a !== void 0 ? _a : "";
    let modified = false;
    if (saving) {
        newValue = input.value;
        if (fieldName.startsWith("strength")) {
            if (Number.isNaN(Number(newValue))) {
                alert(`You must enter a number into the ${fieldName} field.`);
                return false;
            }
            newValue = (Math.round(Number(newValue) * 100) / 100).toFixed(2);
        }
        LORA_INFO_SERVICE.savePartialInfo(info.file, { [fieldName]: newValue }, { generatePreview: true });
        modified = true;
    }
    tr.classList.remove("-rgthree-editing");
    const td = query("td:nth-child(2)", tr);
    appendChildren(empty(td), [$el("span", { text: newValue })]);
    return modified;
}

function imgInfoField(label, value) {
    if (value == null) return "";
    const isLong = label === "positive" || label === "negative";
    const cls = isLong ? ` class="-info-field-long"` : "";
    return `<span${cls}>${label ? `<label>${label} </label>` : ""}${value}</span>`;
}