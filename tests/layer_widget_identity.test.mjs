import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getLayerWidgetType,
    isLayerWidget,
} from '../web/power_spline_editor/layer_widget_identity.js';

test('recognizes every persisted layer widget type after frontend adoption', () => {
    for (const type of ['spline', 'handdraw', 'box_layer']) {
        const adoptedWidget = { value: { type } };

        assert.equal(isLayerWidget(adoptedWidget), true);
        assert.equal(getLayerWidgetType(adoptedWidget), type);
    }
});

test('does not classify other custom widgets as layers', () => {
    for (const widget of [
        { value: { type: 'reference' } },
        { value: {} },
        { value: null },
        {},
        null,
    ]) {
        assert.equal(isLayerWidget(widget), false);
        assert.equal(getLayerWidgetType(widget), null);
    }
});
