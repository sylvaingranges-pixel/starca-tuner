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

  /** Epoch ms -> valeur d'un <input type="datetime-local"> (heure locale). */
  function toLocalInput(ms) {
    var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 19);
  }

  /** Valeur d'un <input type="datetime-local"> -> epoch ms. */
  function fromLocalInput(v) {
    if (!v) return NaN;
    var ms = new Date(v).getTime();
    return isFinite(ms) ? ms : NaN;
  }

  /** Décalage lisible entre deux dates. */
  function describeShift(deltaMs) {
    if (!deltaMs) return 'date d’origine';
    var s = Math.round(Math.abs(deltaMs) / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    var parts = [];
    if (d) parts.push(d + ' j');
    if (h) parts.push(h + ' h');
    if (m || !parts.length) parts.push(m + ' min');
    return (deltaMs > 0 ? 'décalée de +' : 'décalée de −') + parts.join(' ');
  }

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

  /** Rôle d'un canal d'extension : puissance, fréquence cardiaque, ou rien. */
  function channelRole(ch) {
    if (!ch.extKey) return null;
    var last = ch.extKey.split('/').pop().split(':').pop().toLowerCase();
    if (last === 'power' || last === 'watts' || last === 'powerinwatts') return 'power';
    if (last === 'hr' || last === 'heartrate') return 'hr';
    return null;
  }

  function pointFactor(factor, i, n) {
    var f = i === 0 ? factor[0] : i >= n - 1 ? factor[n - 2] : (factor[i - 1] + factor[i]) / 2;
    return isFinite(f) ? f : 1;
  }

  /**
   * Courbes « après retouche » superposées aux séries d'origine, sur les mêmes
   * abscisses : vitesse toujours, puissance et fréquence cardiaque quand leur
   * recalcul est demandé. NaN partout où rien ne change.
   * Le rapport de puissance vient du même calcul que l'export.
   */
  function overlays(track, edits, adjust) {
    adjust = adjust || {};
    var comp = global.Edits.composeFactors(track, edits);
    var phys = global.Edits.physFrom(adjust);
    var n = track.n;
    var speed = new Float64Array(n);
    var powerCh = null, hrCh = null;
    track.channels.forEach(function (ch) {
      var role = channelRole(ch);
      if (role === 'power' && !powerCh) powerCh = ch;
      if (role === 'hr' && !hrCh) hrCh = ch;
    });
    var power = adjust.power && powerCh ? new Float64Array(n) : null;
    var hr = adjust.hr && hrCh ? new Float64Array(n) : null;
    var any = false, anyPower = false, anyHr = false;

    for (var i = 0; i < n; i++) {
      var f = pointFactor(comp.factor, i, n);
      if (Math.abs(f - 1) <= 1e-9) {
        speed[i] = NaN;
        if (power) power[i] = NaN;
        if (hr) hr[i] = NaN;
        continue;
      }
      any = true;
      speed[i] = track.vSmooth[i] * 3.6 * f;
      if (power || hr) {
        var ratio = global.Edits.effortRatio(track, comp.factor, i, phys);
        if (power) {
          var p0 = powerCh.data[i];
          if (isFinite(p0)) { power[i] = Math.max(0, p0 * ratio); anyPower = true; }
          else power[i] = NaN;
        }
        if (hr) {
          var h0 = hrCh.data[i];
          if (isFinite(h0)) { hr[i] = global.Edits.adjustedHr(h0, ratio, adjust.hrMax); anyHr = true; }
          else hr[i] = NaN;
        }
      }
    }

    var data = {};
    data.speed = any ? speed : null;
    if (powerCh) data[powerCh.key] = anyPower ? power : null;
    if (hrCh) data[hrCh.key] = anyHr ? hr : null;
    return { data: data, factor: comp.factor, perEdit: comp.perEdit, powerKey: powerCh && powerCh.key, hrKey: hrCh && hrCh.key };
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

  /**
   * Construit le fichier de sortie et son rapport de validation.
   * `options.startMs` déplace toute la sortie à une autre date : chaque
   * horodatage — et la date de <metadata> — est décalé d'autant.
   */
  function buildExport(track, source, edits, options, fileName) {
    var comp = global.Edits.composeFactors(track, edits);
    var res = global.Edits.rebuild(track, comp.factor, options);
    var shift = options && options.startMs ? Math.round(options.startMs) - track.t0Ms : 0;
    if (shift) {
      for (var i = 0; i < res.points.length; i++) res.points[i].timeMs += shift;
    }
    var text = global.GPX.build(source, res.points, { metaShiftMs: shift });
    var check = global.GPXValidate.validate(text);
    var name = (fileName || 'activite.gpx').replace(/\.gpx$/i, '') + '-retouche.gpx';
    return { res: res, text: text, check: check, name: name };
  }

  global.UI = {
    fmtClock: fmtClock, fmtDelta: fmtDelta, fmtDist: fmtDist, escapeHtml: escapeHtml,
    toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, describeShift: describeShift,
    segStats: segStats, describeFilters: describeFilters, overlays: overlays, channelRole: channelRole,
    previewEdit: previewEdit, buildExport: buildExport
  };
})(typeof window !== 'undefined' ? window : globalThis);
