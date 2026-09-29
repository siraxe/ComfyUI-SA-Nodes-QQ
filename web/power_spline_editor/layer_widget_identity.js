const LAYER_WIDGET_TYPES = new Set(['spline', 'handdraw', 'box_layer']);

export function isLayerWidget(widget) {
    return LAYER_WIDGET_TYPES.has(widget?.value?.type);
}

export function getLayerWidgetType(widget) {
    return isLayerWidget(widget) ? widget.value.type : null;
}
