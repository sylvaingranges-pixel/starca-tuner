/* Canvas slippy-map: raster background tiles + the track, the visible chart
 * window, the current selection and the cursor position.
 * No mapping library — only the tile servers are remote.
 */
(function (global) {
  'use strict';

  var SOURCES = {
    osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap contributors' },
    topo: { name: 'OpenTopoMap', url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, attr: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors' },
    cyclo: { name: 'CyclOSM', url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', max: 19, attr: '© CyclOSM, © OpenStreetMap contributors' },
    carto: { name: 'Carto sombre', url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', max: 19, attr: '© CARTO, © OpenStreetMap contributors' },
    none: { name: 'Aucun fond (hors ligne)', url: null, max: 22, attr: '' }
  };

  function lonToNx(lon) { return (lon + 180) / 360; }
  function latToNy(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function nyToLat(ny) {
    var y = (0.5 - ny) * 2 * Math.PI;
    return Math.atan(Math.sinh(y)) * 180 / Math.PI;
  }

  function TrackMap(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.track = null;
    this.cx = 0.5; this.cy = 0.5; this.z = 12;
    this.source = 'osm';
    this.tiles = new Map();
    this.pending = 0;
    this.view = null;
    this.selection = null;
    this.hover = null;
    this.selectMode = false;
    this._raf = null;
    this._bind();
    var self = this;
    if (global.ResizeObserver) {
      new ResizeObserver(function () { self.resize(); }).observe(canvas.parentElement || canvas);
    }
  }

  TrackMap.prototype.setSource = function (key) { this.source = key; this.tiles.clear(); this.tileErrors = 0; this.draw(); };
  TrackMap.prototype.sources = function () { return SOURCES; };

  TrackMap.prototype.setTrack = function (track) {
    this.track = track;
    var n = track.n;
    this.nx = new Float64Array(n); this.ny = new Float64Array(n);
    for (var i = 0; i < n; i++) { this.nx[i] = lonToNx(track.lon[i]); this.ny[i] = latToNy(track.lat[i]); }
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var j = 0; j < n; j++) {
      if (this.nx[j] < x0) x0 = this.nx[j];
      if (this.nx[j] > x1) x1 = this.nx[j];
      if (this.ny[j] < y0) y0 = this.ny[j];
      if (this.ny[j] > y1) y1 = this.ny[j];
    }
    this.bounds = { x0: x0, x1: x1, y0: y0, y1: y1 };
    this.resize();
    this.fitBounds(this.bounds);
  };

  TrackMap.prototype.fitBounds = function (b, pad) {
    if (!b || !this.canvas.clientWidth) return;
    pad = pad == null ? 28 : pad;
    var w = this.canvas.clientWidth - 2 * pad, h = this.canvas.clientHeight - 2 * pad;
    var dx = Math.max(1e-9, b.x1 - b.x0), dy = Math.max(1e-9, b.y1 - b.y0);
    var zx = Math.log2(w / (256 * dx)), zy = Math.log2(h / (256 * dy));
    this.z = Math.max(1, Math.min(SOURCES[this.source].max, Math.min(zx, zy)));
    this.cx = (b.x0 + b.x1) / 2; this.cy = (b.y0 + b.y1) / 2;
    this.draw();
  };

  TrackMap.prototype.boundsOf = function (i0, i1) {
    if (!this.track || i0 == null) return null;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
      if (this.nx[i] < x0) x0 = this.nx[i];
      if (this.nx[i] > x1) x1 = this.nx[i];
      if (this.ny[i] < y0) y0 = this.ny[i];
      if (this.ny[i] > y1) y1 = this.ny[i];
    }
    return isFinite(x0) ? { x0: x0, x1: x1, y0: y0, y1: y1 } : null;
  };

  TrackMap.prototype.scale = function () { return 256 * Math.pow(2, this.z); };
  TrackMap.prototype.toPx = function (nx, ny) {
    var s = this.scale();
    return [(nx - this.cx) * s + this.canvas.clientWidth / 2, (ny - this.cy) * s + this.canvas.clientHeight / 2];
  };
  TrackMap.prototype.fromPx = function (px, py) {
    var s = this.scale();
    return [(px - this.canvas.clientWidth / 2) / s + this.cx, (py - this.canvas.clientHeight / 2) / s + this.cy];
  };

  TrackMap.prototype.nearestIndex = function (px, py) {
    if (!this.track) return null;
    var n = this.track.n, s = this.scale();
    var w = this.canvas.clientWidth / 2, h = this.canvas.clientHeight / 2;
    var best = -1, bestD = Infinity;
    for (var i = 0; i < n; i++) {
      var dx = (this.nx[i] - this.cx) * s + w - px;
      var dy = (this.ny[i] - this.cy) * s + h - py;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, dist: Math.sqrt(bestD) };
  };

  TrackMap.prototype._bind = function () {
    var self = this, drag = null;
    var c = this.canvas;
    c.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var r = c.getBoundingClientRect();
      var px = ev.clientX - r.left, py = ev.clientY - r.top;
      var before = self.fromPx(px, py);
      self.z = Math.max(1, Math.min(SOURCES[self.source].max, self.z - ev.deltaY * 0.0025));
      var after = self.fromPx(px, py);
      self.cx += before[0] - after[0];
      self.cy += before[1] - after[1];
      self.draw();
    }, { passive: false });

    c.addEventListener('pointerdown', function (ev) {
      c.setPointerCapture(ev.pointerId);
      var r = c.getBoundingClientRect();
      var px = ev.clientX - r.left, py = ev.clientY - r.top;
      var selecting = self.selectMode !== ev.shiftKey;  // shift inverts the mode
      if (selecting) {
        var near = self.nearestIndex(px, py);
        if (near && near.dist < 40) {
          drag = { select: true, anchor: near.index };
          if (self.opts.onSelect) self.opts.onSelect(near.index, near.index);
        } else drag = { select: false, px: px, py: py, cx: self.cx, cy: self.cy };
      } else {
        drag = { select: false, px: px, py: py, cx: self.cx, cy: self.cy };
      }
    });
    c.addEventListener('pointermove', function (ev) {
      var r = c.getBoundingClientRect();
      var px = ev.clientX - r.left, py = ev.clientY - r.top;
      if (drag && drag.select) {
        var near = self.nearestIndex(px, py);
        if (near && self.opts.onSelect) self.opts.onSelect(drag.anchor, near.index);
      } else if (drag) {
        var s = self.scale();
        self.cx = drag.cx - (px - drag.px) / s;
        self.cy = drag.cy - (py - drag.py) / s;
        self.draw();
      } else if (self.opts.onHover) {
        var nr = self.nearestIndex(px, py);
        self.opts.onHover(nr && nr.dist < 30 ? nr.index : null);
      }
    });
    function end() {
      if (drag && drag.select && self.opts.onSelectEnd) self.opts.onSelectEnd();
      drag = null;
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', function () { if (self.opts.onHover) self.opts.onHover(null); });
    c.addEventListener('dblclick', function () { self.fitBounds(self.bounds); });
  };

  TrackMap.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var c = this.canvas;
    c.width = Math.max(1, Math.round(c.clientWidth * dpr));
    c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    this.draw();
  };

  TrackMap.prototype.setView = function (i0, i1) { this.view = i0 == null ? null : [i0, i1]; this.draw(); };
  TrackMap.prototype.setSelection = function (i0, i1) { this.selection = i0 == null ? null : [i0, i1]; this.draw(); };
  TrackMap.prototype.setHover = function (i) { this.hover = i; this.draw(); };

  TrackMap.prototype.draw = function () {
    var self = this;
    if (this._raf) return;
    this._raf = global.requestAnimationFrame(function () { self._raf = null; self._draw(); });
  };

  TrackMap.prototype._tile = function (z, x, y) {
    var src = SOURCES[this.source];
    if (!src.url) return null;
    var max = Math.pow(2, z);
    x = ((x % max) + max) % max;
    if (y < 0 || y >= max) return null;
    var key = this.source + '/' + z + '/' + x + '/' + y;
    var img = this.tiles.get(key);
    if (img) return img.complete && img.naturalWidth ? img : null;
    if (this.tiles.size > 600) this.tiles.clear();
    img = new Image();
    img.crossOrigin = 'anonymous';
    var self = this;
    img.onload = function () { self.draw(); };
    img.onerror = function () { img.failed = true; self.tileErrors = (self.tileErrors || 0) + 1; self.draw(); };
    img.src = src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    this.tiles.set(key, img);
    return null;
  };

  TrackMap.prototype._draw = function () {
    var ctx = this.ctx, c = this.canvas;
    var dpr = global.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = c.clientWidth, h = c.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, w, h);
    if (!this.track) return;

    // --- tiles
    var src = SOURCES[this.source];
    if (src.url) {
      var zi = Math.max(0, Math.min(src.max, Math.round(this.z)));
      var scale = Math.pow(2, this.z - zi);
      var ts = 256 * scale;
      var world = 256 * Math.pow(2, zi);
      var originX = this.cx * world * scale - w / 2;
      var originY = this.cy * world * scale - h / 2;
      var tx0 = Math.floor(originX / ts), tx1 = Math.floor((originX + w) / ts);
      var ty0 = Math.floor(originY / ts), ty1 = Math.floor((originY + h) / ts);
      ctx.imageSmoothingEnabled = true;
      for (var ty = ty0; ty <= ty1; ty++) {
        for (var tx = tx0; tx <= tx1; tx++) {
          var img = this._tile(zi, tx, ty);
          var dx = Math.round(tx * ts - originX), dy = Math.round(ty * ts - originY);
          if (img) ctx.drawImage(img, dx, dy, Math.ceil(ts), Math.ceil(ts));
          else { ctx.fillStyle = '#101a24'; ctx.fillRect(dx, dy, Math.ceil(ts), Math.ceil(ts)); }
        }
      }
    }

    // --- track
    var self = this;
    function polyline(i0, i1, color, width, alpha) {
      if (i1 <= i0) return;
      var s = self.scale();
      ctx.save();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      var lastX = -1e9, lastY = -1e9, started = false;
      for (var i = i0; i <= i1; i++) {
        var px = (self.nx[i] - self.cx) * s + w / 2;
        var py = (self.ny[i] - self.cy) * s + h / 2;
        if (started && Math.abs(px - lastX) < 1.2 && Math.abs(py - lastY) < 1.2 && i !== i1) continue;
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        lastX = px; lastY = py;
      }
      ctx.stroke();
      ctx.restore();
    }

    polyline(0, this.track.n - 1, '#7dd3fc', 2.4, 0.55);
    if (this.view) polyline(this.view[0], this.view[1], '#38bdf8', 3.6, 1);
    if (this.selection) polyline(Math.min(this.selection[0], this.selection[1]), Math.max(this.selection[0], this.selection[1]), '#f59e0b', 5, 1);

    function marker(i, fill, r) {
      if (i == null) return;
      var s = self.scale();
      var px = (self.nx[i] - self.cx) * s + w / 2;
      var py = (self.ny[i] - self.cy) * s + h / 2;
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b1119'; ctx.stroke();
    }
    marker(0, '#22c55e', 5);
    marker(this.track.n - 1, '#ef4444', 5);
    if (this.selection) {
      marker(Math.min(this.selection[0], this.selection[1]), '#fbbf24', 4);
      marker(Math.max(this.selection[0], this.selection[1]), '#fbbf24', 4);
    }
    if (this.hover != null) marker(this.hover, '#ffffff', 4.5);

    // --- scale bar
    var mPerPx = 156543.03392 * Math.cos(nyToLat(this.cy) * Math.PI / 180) / Math.pow(2, this.z);
    var target = 90 * mPerPx;
    var pow = Math.pow(10, Math.floor(Math.log10(target)));
    var mult = target / pow >= 5 ? 5 : target / pow >= 2 ? 2 : 1;
    var barM = mult * pow, barPx = barM / mPerPx;
    ctx.fillStyle = 'rgba(11,17,25,0.72)';
    ctx.fillRect(8, h - 26, barPx + 16, 18);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(16, h - 12); ctx.lineTo(16 + barPx, h - 12); ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(barM >= 1000 ? (barM / 1000) + ' km' : barM + ' m', 18, h - 14);

    if (this.tileErrors > 6 && src.url) {
      var msg = 'Fond de carte indisponible (hors ligne ?) — le tracé reste utilisable.';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      var mw = ctx.measureText(msg).width;
      ctx.fillStyle = 'rgba(11,17,25,0.82)';
      ctx.fillRect(w / 2 - mw / 2 - 8, 44, mw + 16, 20);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(msg, w / 2, 47);
    }

    if (src.attr) {
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      var txt = src.attr;
      var tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(11,17,25,0.7)';
      ctx.fillRect(w - tw - 10, h - 16, tw + 10, 16);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(txt, w - 5, h - 3);
    }
  };

  global.TrackMap = TrackMap;
})(typeof window !== 'undefined' ? window : globalThis);
