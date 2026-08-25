import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI-SA-Nodes-QQ.TextMultiline",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "TextMultiline") {
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated?.apply(this, arguments);
                const widget = this.widgets?.find(w => w.name === "text");
                if (widget?.inputEl) {
                    widget.inputEl.spellcheck = true;
                    widget.inputEl.focus();
                    widget.inputEl.blur();
                }
                return r;
            };
        }
    },
});
