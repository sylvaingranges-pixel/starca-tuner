/* Helpers shared by the desktop and the mobile interfaces (no DOM here). */
(function (global) {
  'use strict';

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      : m + ':' + String(s).padStart(2, '0');
  }

  function fmtDelta(sec) {
    var s = Math.round(Math.abs(sec));
    var m = Math.floor(s / 60);
    return (sec >= 0 ? '−' : '+') + (m ? m + ' min ' : '') + (s % 60) + ' s';
  }

  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /** Summary of the track between two sample indices. */
  function segStats(track, i0, i1) {
    i0 = Math.max(0, Math.min(track.n - 1, i0));
    i1 = Math.max(0, Math.min(track.n - 1, i1));
    if (i1 < i0) { var s = i0; i0 = i1; i1 = s; }
    var dur = track.t[i1] - track.t[i0], dist = track.dist[i1] - track.dist[i0];
    var gain = 0, moving = 0, movDist = 0;
    for (var i = i0; i < i1; i++) {
      var de = track.eleSmooth[i + 1] - track.eleSmooth[i];
      if (de > 0) gain += de;
      if (!track.gap[i] && track.dSeg[i] / Math.max(0.001, track.dtSeg[i]) > 0.8) {
        moving += track.dtSeg[i]; movDist += track.dSeg[i];
      }
    }
    return {
      i0: i0, i1: i1, dur: dur, dist: dist, gain: gain,
      avg: dur > 0 ? dist / dur * 3.6 : 0,
      avgMoving: moving > 0 ? movDist / moving * 3.6 : 0,
      grade: dist > 0 ? Math.atan2(track.eleSmooth[i1] - track.eleSmooth[i0], dist) * 180 / Math.PI : 0
    };
  }

  function describeFilters(edit) {
    if (!edit.filters.length) return 'tous les points';
    return edit.filters.map(function (f) {
      var s = (f.label || f.key).toLowerCase();
      if (f.min != null && f.max != null) return s + ' ' + f.min + '–' + f.max + ' ' + (f.unit || '');
      if (f.min != null) return s + ' > ' + f.min + ' ' + (f.unit || '');
      return s + ' < ' + f.max + ' ' + (f.unit || '');
    }).join(', ');
  }

  /** Modified-speed curve (km/h) over the original samples; NaN where untouched. */
  function overlaySpeed(track, edits) {
    var comp = global.Edits.composeFactors(track, edits);
    var n = track.n, over = new Float64Array(n), any = false;
    for (var i = 0; i < n; i++) {
      var f = i === 0 ? comp.factor[0] : i >= n - 1 ? comp.factor[n - 2] : (comp.factor[i - 1] + comp.factor[i]) / 2;
      if (!isFinite(f)) f = 1;
      if (Math.abs(f - 1) > 1e-9) { any = true; over[i] = track.vSmooth[i] * 3.6 * f; }
      else over[i] = NaN;
    }
    return { data: any ? over : null, factor: comp.factor, perEdit: comp.perEdit };
  }

  /** Preview figures for an edit being configured. */
  function previewEdit(track, edit) {
    var r = global.Edits.resolveEdit(track, edit);
    var nInt = 0, sumT = 0, maxNew = 0, sumF = 0, fw = 0;
    for (var i = r.i0; i < r.i1; i++) {
      if (Math.abs(r.factors[i] - 1) < 1e-9) continue;
      nInt++; sumT += track.dtSeg[i];
      sumF += r.factors[i] * track.dtSeg[i]; fw += track.dtSeg[i];
      var v = global.Edits.intervalSpeedKmh(track, i) * r.factors[i];
      if (v > maxNew) maxNew = v;
    }
    var st = segStats(track, r.i0, r.i1);
    return {
      count: nInt, share: st.dur > 0 ? sumT / st.dur : 0, avgFactor: fw ? sumF / fw : 1,
      maxKmh: maxNew, saved: r.saved, warn: r.warn, segDur: st.dur
    };
  }

  /** Build the output file and its validation report. */
  function buildExport(track, source, edits, options, fileName) {
    var comp = global.Edits.composeFactors(track, edits);
    var res = global.Edits.rebuild(track, comp.factor, options);
    var text = global.GPX.build(source, res.points);
    var check = global.GPXValidate.validate(text);
    var name = (fileName || 'activite.gpx').replace(/\.gpx$/i, '') + '-retouche.gpx';
    return { res: res, text: text, check: check, name: name };
  }

  global.UI = {
    fmtClock: fmtClock, fmtDelta: fmtDelta, fmtDist: fmtDist, escapeHtml: escapeHtml,
    segStats: segStats, describeFilters: describeFilters, overlaySpeed: overlaySpeed,
    previewEdit: previewEdit, buildExport: buildExport
  };
})(typeof window !== 'undefined' ? window : globalThis);
