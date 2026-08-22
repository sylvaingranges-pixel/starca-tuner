/* Synchronised time-series stack drawn on canvases.
 * All rows share the same X window; each row has its own Y scaling (auto on the
 * visible window, or a manual min/max).
 */
(function (global) {
  'use strict';

  var GUTTER = 56;

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max) || min === max) { min = min - 1; max = max + 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = span / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return out;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      : m + ':' + String(s).padStart(2, '0');
  }

  function ChartStack(container, opts) {
    this.el = container;
    this.footEl = (opts && opts.footer) || container;
    this.opts = opts || {};
    this.track = null;
    this.xMode = 'time';
    this.rows = [];
    this.view = [0, 1];
    this.selection = null;
    this.hoverX = null;
    this.overlays = {};
    this.rowHeight = 108;
    this._raf = null;
    this._drag = null;
    var self = this;
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(container);
    } else {
      global.addEventListener('resize', function () { self.resize(); });
    }
  }

  ChartStack.prototype.setTrack = function (track) {
    this.track = track;
    this.rows = [];
    this.overlays = {};
    this.selection = null;
    var self = this;
    this.el.innerHTML = '';
    track.channels.forEach(function (ch) {
      self.rows.push({
        ch: ch, visible: ch.visible !== false, yMode: 'auto', yMin: null, yMax: null,
        el: null, canvas: null, ctx: null
      });
    });
    this._buildDom();
    this.view = [0, this.xMax()];
    this.resize();
  };

  ChartStack.prototype.xArray = function () { return this.xMode === 'dist' ? this.track.dist : this.track.t; };
  ChartStack.prototype.xMax = function () { var a = this.xArray(); return a[a.length - 1]; };
  ChartStack.prototype.fmtX = function (v) {
    return this.xMode === 'dist' ? (v / 1000).toFixed(v < 10000 ? 2 : 1) + ' km' : fmtClock(v);
  };

  /** Index of the sample at (or just before) x. */
  ChartStack.prototype.idxAt = function (x) {
    var a = this.xArray(), lo = 0, hi = a.length - 1;
    if (x <= a[0]) return 0;
    if (x >= a[hi]) return hi;
    while (lo < hi - 1) { var m = (lo + hi) >> 1; if (a[m] <= x) lo = m; else hi = m; }
    return lo;
  };

  ChartStack.prototype._buildDom = function () {
    var self = this;
    this.rows.forEach(function (row) {
      var wrap = document.createElement('div');
      wrap.className = 'chart-row';
      wrap.dataset.key = row.ch.key;
      wrap.innerHTML =
        '<div class="chart-head">' +
        '<span class="dot" style="background:' + row.ch.color + '"></span>' +
        '<span class="lbl">' + row.ch.label + '</span>' +
        '<span class="unit">' + (row.ch.unit ? '(' + row.ch.unit + ')' : '') + '</span>' +
        '<span class="cursor-val"></span>' +
        '<span class="spacer"></span>' +
        '<label class="yauto"><input type="checkbox" checked> auto Y</label>' +
        '<input class="ymin" type="number" step="any" placeholder="min" disabled>' +
        '<input class="ymax" type="number" step="any" placeholder="max" disabled>' +
        '<button class="hidebtn" title="Masquer ce graphe">✕</button>' +
        '</div>' +
        '<canvas></canvas>';
      self.el.appendChild(wrap);
      row.el = wrap;
      row.canvas = wrap.querySelector('canvas');
      row.ctx = row.canvas.getContext('2d');
      row.valEl = wrap.querySelector('.cursor-val');
      var auto = wrap.querySelector('.yauto input'), ymin = wrap.querySelector('.ymin'), ymax = wrap.querySelector('.ymax');
      auto.addEventListener('change', function () {
        row.yMode = auto.checked ? 'auto' : 'fixed';
        ymin.disabled = ymax.disabled = auto.checked;
        if (!auto.checked) {
          var r = self._yRange(row);
          if (ymin.value === '') ymin.value = r[0].toFixed(row.ch.decimals);
          if (ymax.value === '') ymax.value = r[1].toFixed(row.ch.decimals);
          row.yMin = parseFloat(ymin.value); row.yMax = parseFloat(ymax.value);
        }
        self.draw();
      });
      function onY() {
        row.yMin = ymin.value === '' ? null : parseFloat(ymin.value);
        row.yMax = ymax.value === '' ? null : parseFloat(ymax.value);
        self.draw();
      }
      ymin.addEventListener('input', onY);
      ymax.addEventListener('input', onY);
      wrap.querySelector('.hidebtn').addEventListener('click', function () {
        row.visible = false; wrap.style.display = 'none';
        if (self.opts.onRowsChanged) self.opts.onRowsChanged();
      });
      self._bindCanvas(row.canvas);
    });

    this.footEl.innerHTML = '';
    var axis = document.createElement('div');
    axis.className = 'chart-axis';
    axis.innerHTML = '<canvas></canvas>';
    this.footEl.appendChild(axis);
    this.axisCanvas = axis.querySelector('canvas');
    this.axisCtx = this.axisCanvas.getContext('2d');
    this._bindCanvas(this.axisCanvas);

    var ov = document.createElement('div');
    ov.className = 'chart-overview';
    ov.innerHTML = '<canvas></canvas>';
    this.footEl.appendChild(ov);
    this.ovCanvas = ov.querySelector('canvas');
    this.ovCtx = this.ovCanvas.getContext('2d');
    this._bindOverview(this.ovCanvas);
  };

  ChartStack.prototype.setRowVisible = function (key, vis) {
    var row = this.rows.find(function (r) { return r.ch.key === key; });
    if (!row) return;
    row.visible = vis;
    row.el.style.display = vis ? '' : 'none';
    this.resize();
  };

  ChartStack.prototype.plotWidth = function (canvas) { return canvas.clientWidth - GUTTER - 8; };

  ChartStack.prototype.xToPix = function (x, canvas) {
    var w = this.plotWidth(canvas);
    return GUTTER + (x - this.view[0]) / (this.view[1] - this.view[0]) * w;
  };
  ChartStack.prototype.pixToX = function (px, canvas) {
    var w = this.plotWidth(canvas);
    return this.view[0] + (px - GUTTER) / w * (this.view[1] - this.view[0]);
  };

  ChartStack.prototype._bindCanvas = function (canvas) {
    var self = this;
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var x = self.pixToX(ev.offsetX, canvas);
      var k = Math.pow(1.0015, ev.deltaY);
      self.zoomAround(x, k);
    }, { passive: false });

    canvas.addEventListener('pointerdown', function (ev) {
      if (ev.button === 2) return;
      canvas.setPointerCapture(ev.pointerId);
      var pan = ev.shiftKey || ev.button === 1;
      self._drag = { canvas: canvas, pan: pan, startPx: ev.offsetX, startX: self.pixToX(ev.offsetX, canvas), moved: false };
      if (!pan) { self.selection = null; self.draw(); }
    });
    canvas.addEventListener('pointermove', function (ev) {
      var x = self.pixToX(ev.offsetX, canvas);
      if (self._drag && self._drag.canvas === canvas) {
        var d = self._drag;
        if (Math.abs(ev.offsetX - d.startPx) > 2) d.moved = true;
        if (d.pan) {
          var dx = (d.startX - x);
          self.setView([self.view[0] + dx, self.view[1] + dx]);
        } else if (d.moved) {
          self.setSelection([Math.min(d.startX, x), Math.max(d.startX, x)], true);
        }
      }
      self.setHover(x);
    });
    function endDrag(ev) {
      if (self._drag && self._drag.canvas === canvas) {
        var d = self._drag;
        self._drag = null;
        if (!d.moved && !d.pan) { self.setSelection(null, true); }
        else if (!d.pan && self.opts.onSelectEnd) self.opts.onSelectEnd(self.selection);
      }
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', function () { self.setHover(null); });
    canvas.addEventListener('dblclick', function () { self.resetView(); });
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); self.resetView(); });
  };

  ChartStack.prototype._bindOverview = function (canvas) {
    var self = this;
    function xOf(px) {
      var w = self.plotWidth(canvas);
      return Math.max(0, Math.min(self.xMax(), (px - GUTTER) / w * self.xMax()));
    }
    var drag = null;
    canvas.addEventListener('pointerdown', function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      var x = xOf(ev.offsetX);
      var span = self.view[1] - self.view[0];
      drag = { x: x, span: span };
      self.setView([x - span / 2, x + span / 2]);
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var x = xOf(ev.offsetX);
      self.setView([x - drag.span / 2, x + drag.span / 2]);
    });
    canvas.addEventListener('pointerup', function () { drag = null; });
    canvas.addEventListener('dblclick', function () { self.resetView(); });
  };

  ChartStack.prototype.setXMode = function (mode) {
    if (!this.track || mode === this.xMode) return;
    var a0 = this.xArray();
    var i0 = this.idxAt(this.view[0]), i1 = this.idxAt(this.view[1]);
    var s = this.selection ? [this.idxAt(this.selection[0]), this.idxAt(this.selection[1])] : null;
    void a0;
    this.xMode = mode;
    var b = this.xArray();
    this.view = [b[i0], b[Math.min(b.length - 1, i1)]];
    if (s) this.selection = [b[s[0]], b[Math.min(b.length - 1, s[1])]];
    this.draw();
    if (this.opts.onView) this.opts.onView(this.viewIndices());
  };

  ChartStack.prototype.zoomAround = function (x, k) {
    var v = this.view, span = (v[1] - v[0]) * k;
    var min = this.xMode === 'dist' ? 20 : 5;
    span = Math.max(min, Math.min(this.xMax(), span));
    var f = (x - v[0]) / (v[1] - v[0]);
    this.setView([x - f * span, x + (1 - f) * span]);
  };

  ChartStack.prototype.setView = function (v, silent) {
    var max = this.xMax();
    var span = Math.min(max, v[1] - v[0]);
    var a = v[0], b = a + span;
    if (a < 0) { a = 0; b = span; }
    if (b > max) { b = max; a = max - span; }
    this.view = [a, b];
    this.draw();
    if (!silent && this.opts.onView) this.opts.onView(this.viewIndices());
  };

  ChartStack.prototype.resetView = function () { this.setView([0, this.xMax()]); };

  ChartStack.prototype.viewIndices = function () {
    return { i0: this.idxAt(this.view[0]), i1: this.idxAt(this.view[1]), x0: this.view[0], x1: this.view[1] };
  };

  ChartStack.prototype.setSelection = function (sel, silent) {
    this.selection = sel;
    this.draw();
    void silent;
    if (this.opts.onSelect) this.opts.onSelect(this.selectionIndices());
  };

  ChartStack.prototype.selectionIndices = function () {
    if (!this.selection) return null;
    return { i0: this.idxAt(this.selection[0]), i1: this.idxAt(this.selection[1]) };
  };

  ChartStack.prototype.setSelectionIndices = function (i0, i1) {
    if (i0 == null) { this.setSelection(null); return; }
    var a = this.xArray();
    i0 = Math.max(0, Math.min(a.length - 1, i0));
    i1 = Math.max(0, Math.min(a.length - 1, i1));
    this.setSelection([a[Math.min(i0, i1)], a[Math.max(i0, i1)]]);
  };

  ChartStack.prototype.zoomToSelection = function () {
    if (!this.selection) return;
    var pad = (this.selection[1] - this.selection[0]) * 0.08;
    this.setView([this.selection[0] - pad, this.selection[1] + pad]);
  };

  ChartStack.prototype.setHover = function (x) {
    this.hoverX = x;
    this._updateCursorValues();
    this.draw();
    if (this.opts.onHover) this.opts.onHover(x == null ? null : this.idxAt(x));
  };

  ChartStack.prototype.setHoverIndex = function (i) {
    if (i == null) { this.hoverX = null; } else { this.hoverX = this.xArray()[i]; }
    this._updateCursorValues();
    this.draw();
  };

  ChartStack.prototype.setOverlay = function (key, data) {
    if (data) this.overlays[key] = data; else delete this.overlays[key];
    this.draw();
  };

  ChartStack.prototype._updateCursorValues = function () {
    var i = this.hoverX == null ? null : this.idxAt(this.hoverX);
    this.rows.forEach(function (row) {
      if (!row.valEl) return;
      if (i == null) { row.valEl.textContent = ''; return; }
      var v = row.ch.data[i];
      row.valEl.textContent = isFinite(v) ? v.toFixed(row.ch.decimals) : '—';
    });
  };

  ChartStack.prototype.resize = function () {
    if (!this.track) return;
    var dpr = global.devicePixelRatio || 1;
    var w = this.el.clientWidth;
    var nVis = this.rows.filter(function (r) { return r.visible; }).length || 1;
    var heads = 0;
    this.rows.forEach(function (r) {
      if (!r.visible || !r.el) return;
      var hd = r.el.querySelector('.chart-head');
      heads += (hd ? hd.offsetHeight : 22) + 1;
    });
    var avail = this.el.clientHeight - 2 - heads;
    var rowH = Math.max(64, Math.min(150, Math.floor(avail / nVis)));
    this.rows.forEach(function (row) {
      if (!row.visible) return;
      var c = row.canvas;
      c.style.height = rowH + 'px';
      c.style.width = '100%';
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    });
    [this.axisCanvas, this.ovCanvas].forEach(function (c) {
      if (!c) return;
      c.style.width = '100%';
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    });
    this.draw();
  };

  ChartStack.prototype.draw = function () {
    var self = this;
    if (this._raf) return;
    this._raf = global.requestAnimationFrame(function () { self._raf = null; self._draw(); });
  };

  ChartStack.prototype._yRange = function (row) {
    var i0 = this.idxAt(this.view[0]), i1 = this.idxAt(this.view[1]);
    var d = row.ch.data, min = Infinity, max = -Infinity;
    for (var i = i0; i <= i1; i++) {
      var v = d[i];
      if (!isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var ov = this.overlays[row.ch.key];
    if (ov) for (var j = i0; j <= i1; j++) {
      var w = ov[j];
      if (!isFinite(w)) continue;
      if (w < min) min = w;
      if (w > max) max = w;
    }
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  };

  ChartStack.prototype._draw = function () {
    if (!this.track) return;
    var self = this;
    this.rows.forEach(function (row) { if (row.visible) self._drawRow(row); });
    this._drawAxis();
    this._drawOverview();
  };

  ChartStack.prototype._drawRow = function (row) {
    var self = this;
    var ctx = row.ctx, c = row.canvas;
    var dpr = global.devicePixelRatio || 1;
    var W = c.width, H = c.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = W / dpr, h = H / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d141c';
    ctx.fillRect(0, 0, w, h);

    var yr = row.yMode === 'fixed' && isFinite(row.yMin) && isFinite(row.yMax) && row.yMax > row.yMin
      ? [row.yMin, row.yMax] : this._yRange(row);
    var y0 = yr[0], y1 = yr[1];
    var plotW = w - GUTTER - 8, plotH = h - 6;
    var toY = function (v) { return 3 + plotH - (v - y0) / (y1 - y0) * plotH; };
    var toX = function (x) { return GUTTER + (x - self.view[0]) / (self.view[1] - self.view[0]) * plotW; };

    // grid + y labels
    var ticks = niceTicks(y0, y1, Math.max(2, Math.round(plotH / 26)));
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ticks.forEach(function (tv) {
      var py = toY(tv);
      if (py < 2 || py > h - 2) return;
      ctx.strokeStyle = (tv === 0 && row.ch.zero) ? '#33465a' : '#18222d';
      ctx.beginPath(); ctx.moveTo(GUTTER, py + 0.5); ctx.lineTo(w - 8, py + 0.5); ctx.stroke();
      ctx.fillStyle = '#6b7f93';
      ctx.fillText(Math.abs(tv) >= 1000 ? tv.toFixed(0) : tv.toFixed(row.ch.decimals), GUTTER - 6, py);
    });

    // x grid
    var xt = niceTicks(this.view[0], this.view[1], Math.max(2, Math.round(plotW / 110)));
    ctx.strokeStyle = '#151f29';
    xt.forEach(function (xv) {
      var px = Math.round(toX(xv)) + 0.5;
      if (px < GUTTER || px > w - 8) return;
      ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, h - 2); ctx.stroke();
    });

    this._drawSeries(ctx, row.ch.data, row.ch, toX, toY, plotW, h, false);
    var ov = this.overlays[row.ch.key];
    if (ov) this._drawSeries(ctx, ov, row.ch, toX, toY, plotW, h, true);

    // selection
    if (this.selection) {
      var sa = toX(this.selection[0]), sb = toX(this.selection[1]);
      ctx.fillStyle = 'rgba(249,168,37,0.13)';
      ctx.fillRect(Math.max(GUTTER, sa), 0, Math.min(w - 8, sb) - Math.max(GUTTER, sa), h);
      ctx.strokeStyle = 'rgba(249,168,37,0.75)';
      ctx.beginPath();
      [sa, sb].forEach(function (px) {
        if (px >= GUTTER && px <= w - 8) { ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, h); }
      });
      ctx.stroke();
    }

    // hover
    if (this.hoverX != null) {
      var hx = toX(this.hoverX);
      if (hx >= GUTTER && hx <= w - 8) {
        ctx.strokeStyle = 'rgba(226,240,255,0.45)';
        ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, 0); ctx.lineTo(Math.round(hx) + 0.5, h); ctx.stroke();
      }
    }
    ctx.strokeStyle = '#1c2733';
    ctx.strokeRect(GUTTER + 0.5, 0.5, plotW - 1, h - 1);
  };

  /** Draws a series, decimated to one min/max column per pixel when dense. */
  ChartStack.prototype._drawSeries = function (ctx, data, ch, toX, toY, plotW, h, overlay) {
    var x = this.xArray();
    var i0 = this.idxAt(this.view[0]), i1 = this.idxAt(this.view[1]);
    if (i1 <= i0) return;
    var span = this.view[1] - this.view[0];
    var a = Math.max(0, i0 - 1), b = Math.min(x.length - 1, i1 + 1);
    var dense = (i1 - i0) / plotW > 1.2;
    var cols = [], cur = null, col = -1, hole = false;

    for (var i = a; i <= b; i++) {
      var v = data[i];
      if (!isFinite(v)) { if (cur) { cols.push(cur); cur = null; } col = -1; hole = true; continue; }
      if (dense) {
        var pc = Math.floor((x[i] - this.view[0]) / span * plotW);
        if (pc !== col || !cur) {
          if (cur) cols.push(cur);
          col = pc;
          cur = { px: GUTTER + pc + 0.5, mn: v, mx: v, first: v, last: v, brk: hole };
          hole = false;
        } else {
          if (v < cur.mn) cur.mn = v;
          if (v > cur.mx) cur.mx = v;
          cur.last = v;
        }
      } else {
        cols.push({ px: toX(x[i]), mn: v, mx: v, first: v, last: v, brk: hole });
        hole = false;
      }
    }
    if (cur) cols.push(cur);
    if (!cols.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, plotW, h);
    ctx.clip();

    if (ch.fill && !overlay) {
      ctx.beginPath();
      ctx.moveTo(cols[0].px, h);
      for (var k = 0; k < cols.length; k++) ctx.lineTo(cols[k].px, toY(cols[k].mx));
      ctx.lineTo(cols[cols.length - 1].px, h);
      ctx.closePath();
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = ch.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = overlay ? 1.7 : 1.2;
    ctx.strokeStyle = overlay ? '#f97316' : ch.color;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var started = false;
    for (var c2 = 0; c2 < cols.length; c2++) {
      var o = cols[c2];
      if (!started || o.brk) { ctx.moveTo(o.px, toY(o.first)); started = true; }
      else ctx.lineTo(o.px, toY(o.first));
      if (o.mn !== o.mx) { ctx.lineTo(o.px, toY(o.mn)); ctx.lineTo(o.px, toY(o.mx)); }
      ctx.lineTo(o.px, toY(o.last));
    }
    ctx.stroke();
    ctx.restore();
  };

  ChartStack.prototype._drawAxis = function () {
    var ctx = this.axisCtx, c = this.axisCanvas;
    if (!ctx) return;
    var dpr = global.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);
    var plotW = w - GUTTER - 8;
    var ticks = niceTicks(this.view[0], this.view[1], Math.max(2, Math.round(plotW / 110)));
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#7b8fa3';
    ctx.textBaseline = 'top';
    var self = this;
    ticks.forEach(function (tv) {
      var px = GUTTER + (tv - self.view[0]) / (self.view[1] - self.view[0]) * plotW;
      if (px < GUTTER - 1 || px > w - 8) return;
      ctx.textAlign = 'center';
      ctx.fillText(self.fmtX(tv), px, 3);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4d6070';
    ctx.fillText(this.xMode === 'dist' ? 'distance' : 'temps', 4, 3);
  };

  ChartStack.prototype._drawOverview = function () {
    var ctx = this.ovCtx, c = this.ovCanvas;
    if (!ctx) return;
    var dpr = global.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, w, h);
    var plotW = w - GUTTER - 8;
    var x = this.xArray(), max = this.xMax();
    var ele = this.track.eleSmooth;
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < ele.length; i++) { if (ele[i] < mn) mn = ele[i]; if (ele[i] > mx) mx = ele[i]; }
    if (mx <= mn) mx = mn + 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER, h);
    for (var j = 0; j < x.length; j += Math.max(1, Math.floor(x.length / plotW))) {
      ctx.lineTo(GUTTER + x[j] / max * plotW, h - 2 - (ele[j] - mn) / (mx - mn) * (h - 6));
    }
    ctx.lineTo(GUTTER + plotW, h);
    ctx.closePath();
    ctx.fillStyle = '#1c2c3b';
    ctx.fill();

    if (this.selection) {
      ctx.fillStyle = 'rgba(249,168,37,0.30)';
      var sa = GUTTER + this.selection[0] / max * plotW, sb = GUTTER + this.selection[1] / max * plotW;
      ctx.fillRect(sa, 0, Math.max(1, sb - sa), h);
    }
    var va = GUTTER + this.view[0] / max * plotW, vb = GUTTER + this.view[1] / max * plotW;
    ctx.fillStyle = 'rgba(56,189,248,0.16)';
    ctx.fillRect(va, 0, Math.max(2, vb - va), h);
    ctx.strokeStyle = '#38bdf8';
    ctx.strokeRect(va + 0.5, 0.5, Math.max(2, vb - va) - 1, h - 1);
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#4d6070';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('vue', 6, h / 2);
  };

  global.ChartStack = ChartStack;
  global.ChartUtils = { fmtClock: fmtClock, niceTicks: niceTicks };
})(typeof window !== 'undefined' ? window : globalThis);
