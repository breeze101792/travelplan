/* map-shim.mjs — minimal Leaflet (L) stub sufficient for map.js tests under
 * the Node DOM shim.  Provides the small surface that map.js actually uses:
 * L.map, L.tileLayer, L.circleMarker, L.polyline, L.latLngBounds, and the
 * common instance methods (setView, fitBounds, addLayer, removeLayer, etc.).
 *
 * Install before importing map.js:
 *   import './lib/map-shim.mjs';
 *   import { initMap } from '/static/js/map.js';
 *
 * After initMap completes, globalThis.__L_map holds the created map instance
 * for assertions.  Markers and polylines are tracked on the map stub so tests
 * can inspect them.
 */

class MapStub {
  constructor(container, opts) {
    this.container = container;
    this.options = opts || {};
    this._zoom = 0;
    this._center = [0, 0];
    this._layers = [];
    this._markers = [];
    this._polylines = [];
    this._tileLayers = [];
    this._listeners = {};
    this._callbacks = {};
    globalThis.__L_map = this;
    if (container && container.tagName) {
      container._map = this;
    }
  }
  setView(center, zoom, opts) {
    this._center = center;
    this._zoom = zoom;
    this._lastSetView = { center, zoom, opts };
    return this;
  }
  getCenter() { return { lat: this._center[0], lng: this._center[1] }; }
  getZoom() { return this._zoom; }
  fitBounds(bounds, opts) {
    this._lastFitBounds = { bounds, opts };
    return this;
  }
  invalidateSize() { this._invalidated = true; return this; }
  addLayer(layer) {
    this._layers.push(layer);
    if (layer._isMarker) this._markers.push(layer);
    if (layer._isPolyline) this._polylines.push(layer);
    if (layer._isTileLayer) this._tileLayers.push(layer);
  }
  removeLayer(layer) {
    this._layers = this._layers.filter(l => l !== layer);
    this._markers = this._markers.filter(l => l !== layer);
    this._polylines = this._polylines.filter(l => l !== layer);
    this._tileLayers = this._tileLayers.filter(l => l !== layer);
  }
  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
  }
  _fire(event, data) {
    for (const fn of (this._listeners[event] || [])) fn(data);
  }
}

class TileLayerStub {
  constructor(url, opts) {
    this._isTileLayer = true;
    this.url = url;
    this.options = opts;
  }
  addTo(map) { map.addLayer(this); return this; }
}

class CircleMarkerStub {
  constructor(latLng, opts) {
    this._isMarker = true;
    this._latLng = latLng;
    this._opts = Object.assign({}, opts);
    this._tooltip = null;
    this._tooltipOpts = null;
    this._listeners = {};
    this._map = null;
    this.coordIdx = 0;
    this.itemId = null;
    this.geoIdx = null;
  }
  bindTooltip(content, opts) {
    this._tooltip = content;
    this._tooltipOpts = opts || {};
    return this;
  }
  setStyle(style) {
    Object.assign(this._opts, style);
    return this;
  }
  addTo(map) { map.addLayer(this); this._map = map; return this; }
  remove() { if (this._map) this._map.removeLayer(this); }
  bringToFront() { this._broughtToFront = true; return this; }
  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
  }
  _fire(event, data) {
    for (const fn of (this._listeners[event] || [])) fn(data);
  }
}

class PolylineStub {
  constructor(latLngs, opts) {
    this._isPolyline = true;
    this._latLngs = latLngs;
    this._opts = Object.assign({}, opts);
    this._map = null;
  }
  addTo(map) { map.addLayer(this); this._map = map; return this; }
  remove() { if (this._map) this._map.removeLayer(this); }
}

class LatLngBoundsStub {
  constructor(coords) {
    this._coords = coords || [];
    this._isValid = coords && coords.length > 0;
  }
  isValid() { return this._isValid; }
  extend(other) { return this; }
}

globalThis.L = {
  map: (container, opts) => new MapStub(container, opts),
  tileLayer: (url, opts) => new TileLayerStub(url, opts),
  circleMarker: (latLng, opts) => new CircleMarkerStub(latLng, opts),
  polyline: (latLngs, opts) => new PolylineStub(latLngs, opts),
  latLngBounds: (coords) => new LatLngBoundsStub(coords),
  // Shorthand approximations for coordinate handling (minimal).
  DomUtil: { getClass: () => '', setClass: () => {} },
};
