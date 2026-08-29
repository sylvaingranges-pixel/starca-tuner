/* Speed-editing engine.
 *
 * Model: the route geometry (the polyline) and the timestamp grid are fixed.
 * Each edit multiplies the speed of the intervals it selects, which shortens
 * the time needed to reach every later point. The track is then re-sampled on
 * the original timestamp grid, so positions stay consistent with the new
 * speeds while the timestamps remain exactly those of the input file.
 */
(function (global) {
  'use strict';

  var G = 9.80665;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function defaultEdit(track, i0, i1) {
    return {
      id: 'e' + Math.random().toString(36).slice(2, 8),
      enabled: true,
      i0: i0, i1: i1,
      mode: 'target',            // 'target' | 'factor' | 'delta' | 'speed'
      targetSec: 60,             // mode 'target': seconds to save on the segment
      factor: 1.1,               // mode 'factor'
      deltaKmh: 3,               // mode 'delta'
      speedKmh: 30,              // mode 'speed'
      filters: [],               // [{key,min,max}]
      maxSpeedKmh: 0,            // 0 = no clamp
      minSpeedKmh: 5,            // never touch intervals slower than this
      maxFactor: 2.5,
      rampSec: 15,               // smooth in/out at the segment edges
      smoothSec: 10              // smooth the factor inside the segment
    };
  }

  /** Channel value representative of interval i (between points i and i+1). */
  function intervalValue(track, key, i) {
    var ch = null;
    for (var c = 0; c < track.channels.length; c++) if (track.channels[c].key === key) { ch = track.channels[c]; break; }
    if (!ch) return NaN;
    var a = ch.data[i], b = ch.data[i + 1];
    if (!isFinite(a)) return b;
    if (!isFinite(b)) return a;
    return (a + b) / 2;
  }

  function intervalSpeedKmh(track, i) {
    return track.dtSeg[i] > 0 ? track.dSeg[i] / track.dtSeg[i] * 3.6 : 0;
  }

  /** Build the 0..1 weight of each interval for one edit (filters + ramp + smoothing). */
  function shapeFor(track, edit) {
    var n = track.n, m = n - 1;
    var shape = new Float64Array(m);
    var i0 = clamp(Math.min(edit.i0, edit.i1), 0, n - 1);
    var i1 = clamp(Math.max(edit.i0, edit.i1), 0, n - 1);
    var count = 0;

    for (var i = i0; i < i1; i++) {
      if (track.gap[i]) continue;
      var v = intervalSpeedKmh(track, i);
      if (v < (edit.minSpeedKmh || 0)) continue;
      var ok = true;
      for (var f = 0; f < edit.filters.length; f++) {
        var flt = edit.filters[f];
        if (flt.enabled === false) continue;
        var val = flt.key === 'speed' ? v : intervalValue(track, flt.key, i);
        if (!isFinite(val)) { ok = false; break; }
        if (flt.min != null && val < flt.min) { ok = false; break; }
        if (flt.max != null && val > flt.max) { ok = false; break; }
      }
      if (!ok) continue;
      shape[i] = 1; count++;
    }

    // Smooth the mask (in seconds) so the speed change is progressive.
    if (edit.smoothSec > 0) shape = smoothInRange(track, shape, i0, i1, edit.smoothSec);
    // Ramp in / out at the segment boundaries.
    if (edit.rampSec > 0) {
      var tStart = track.t[i0], tEnd = track.t[i1];
      for (var j = i0; j < i1; j++) {
        if (!shape[j]) continue;
        var tm = (track.t[j] + track.t[j + 1]) / 2;
        var wIn = clamp((tm - tStart) / edit.rampSec, 0, 1);
        var wOut = clamp((tEnd - tm) / edit.rampSec, 0, 1);
        var w = Math.min(wIn, wOut);
        shape[j] *= 0.5 - 0.5 * Math.cos(Math.PI * w);
      }
    }
    return { shape: shape, count: count, i0: i0, i1: i1 };
  }

  function smoothInRange(track, shape, i0, i1, seconds) {
    var out = new Float64Array(shape.length);
    out.set(shape);
    var half = seconds / 2;
    for (var i = i0; i < i1; i++) {
      var tm = (track.t[i] + track.t[i + 1]) / 2;
      var sum = 0, wsum = 0;
      for (var j = i; j >= i0; j--) {
        var tj = (track.t[j] + track.t[j + 1]) / 2;
        if (tm - tj > half) break;
        sum += shape[j]; wsum++;
      }
      for (var k = i + 1; k < i1; k++) {
        var tk = (track.t[k] + track.t[k + 1]) / 2;
        if (tk - tm > half) break;
        sum += shape[k]; wsum++;
      }
      out[i] = wsum ? sum / wsum : shape[i];
    }
    return out;
  }

  /** Per-interval factor of one edit for a given strength k. */
  function factorsForStrength(track, edit, shape, i0, i1, k) {
    var f = new Float64Array(track.n - 1);
    f.fill(1);
    var maxV = edit.maxSpeedKmh > 0 ? edit.maxSpeedKmh : Infinity;
    for (var i = i0; i < i1; i++) {
      var s = shape[i];
      if (!s) continue;
      var v = intervalSpeedKmh(track, i);
      if (v <= 0) continue;
      var target;
      switch (edit.mode) {
        case 'delta': target = v + s * edit.deltaKmh * k; break;
        case 'speed': target = v + s * (Math.max(v, edit.speedKmh * k) - v); break;
        case 'factor': target = v * (1 + s * (edit.factor * k - 1)); break;
        default: target = v * (1 + s * (k - 1)); break;   // 'target'
      }
      if (target > maxV) target = Math.max(v, maxV);
      var fi = target / v;
      fi = clamp(fi, 1 / Math.max(1.01, edit.maxFactor), edit.maxFactor);
      f[i] = fi;
    }
    return f;
  }

  function savedTime(track, f, i0, i1) {
    var s = 0;
    for (var i = i0; i < i1; i++) if (f[i] > 0) s += track.dtSeg[i] * (1 - 1 / f[i]);
    return s;
  }

  /** Resolve one edit into per-interval factors (solving for the target time saving). */
  function resolveEdit(track, edit) {
    var sh = shapeFor(track, edit);
    var i0 = sh.i0, i1 = sh.i1;
    var warn = null, k = 1;

    if (edit.mode === 'target') {
      var goal = edit.targetSec;
      var lo = goal >= 0 ? 1 : 0.2, hi = goal >= 0 ? edit.maxFactor : 1;
      var best = factorsForStrength(track, edit, sh.shape, i0, i1, goal >= 0 ? hi : lo);
      var reach = savedTime(track, best, i0, i1);
      if ((goal >= 0 && reach < goal - 1e-6) || (goal < 0 && reach > goal + 1e-6)) {
        warn = 'Objectif non atteignable : ' + fmtDur(Math.abs(reach)) + ' seulement (limite de facteur / vitesse max).';
        return { factors: best, saved: reach, count: sh.count, i0: i0, i1: i1, warn: warn, k: goal >= 0 ? hi : lo };
      }
      for (var it = 0; it < 60; it++) {
        k = (lo + hi) / 2;
        var f = factorsForStrength(track, edit, sh.shape, i0, i1, k);
        var sv = savedTime(track, f, i0, i1);
        if (sv < goal) lo = k; else hi = k;
      }
      var ff = factorsForStrength(track, edit, sh.shape, i0, i1, (lo + hi) / 2);
      return { factors: ff, saved: savedTime(track, ff, i0, i1), count: sh.count, i0: i0, i1: i1, warn: null, k: (lo + hi) / 2 };
    }

    var fx = factorsForStrength(track, edit, sh.shape, i0, i1, 1);
    return { factors: fx, saved: savedTime(track, fx, i0, i1), count: sh.count, i0: i0, i1: i1, warn: null, k: 1 };
  }

  /** Compose every enabled edit into a single per-interval factor array. */
  function composeFactors(track, edits) {
    var m = Math.max(0, track.n - 1);
    var total = new Float64Array(m); total.fill(1);
    var perEdit = [];
    for (var e = 0; e < edits.length; e++) {
      var ed = edits[e];
      if (!ed.enabled) { perEdit.push({ id: ed.id, saved: 0, count: 0, warn: null, disabled: true }); continue; }
      var r = resolveEdit(track, ed);
      for (var i = r.i0; i < r.i1; i++) total[i] *= r.factors[i];
      perEdit.push({ id: ed.id, saved: r.saved, count: r.count, warn: r.warn, k: r.k, factors: r.factors, i0: r.i0, i1: r.i1 });
    }
    for (var g = 0; g < m; g++) if (track.gap[g]) total[g] = 1;
    return { factor: total, perEdit: perEdit };
  }

  /** Scale (factor-1) globally so the total time saved becomes an exact number of seconds. */
  function alignToWholeSeconds(track, factor) {
    var raw = savedTime(track, factor, 0, factor.length);
    var goal = Math.round(raw);
    // Nothing to align, already exact, or a gain smaller than a second: leave as is.
    if (Math.abs(raw) < 1e-9 || goal === 0 || Math.abs(raw - goal) < 1e-9) return factor;
    var up = raw > 0;                       // saved time grows with the strength
    var lo = 0, hi = 2, best = factor;
    for (var it = 0; it < 80; it++) {
      var a = (lo + hi) / 2;
      var f = new Float64Array(factor.length);
      for (var i = 0; i < factor.length; i++) f[i] = 1 + (factor[i] - 1) * a;
      var s = savedTime(track, f, 0, f.length);
      best = f;
      if (up ? s < goal : s > goal) lo = a; else hi = a;
    }
    return best;
  }

  /** New cumulative time (s) at every original point, under the given factors. */
  function newTimeline(track, factor) {
    var n = track.n, T = new Float64Array(n);
    for (var i = 0; i < n - 1; i++) {
      var f = factor[i];
      var dur = (!isFinite(f) || f <= 0 || track.gap[i]) ? track.dtSeg[i] : track.dtSeg[i] / f;
      T[i + 1] = T[i] + dur;
    }
    return T;
  }

  function powerRequired(vms, gradeDeg, cfg) {
    if (vms <= 0) return 0;
    var slope = Math.tan(gradeDeg * Math.PI / 180);
    var theta = Math.atan(slope);
    var roll = cfg.mass * G * cfg.crr * Math.cos(theta);
    var grav = cfg.mass * G * Math.sin(theta);
    var aero = 0.5 * cfg.rho * cfg.cda * vms * vms;
    var p = (roll + grav + aero) * vms / cfg.eff;
    return Math.max(0, p);
  }

  function lerp(a, b, u) { return a + (b - a) * u; }

  /** Split the ride into runs of continuous recording, separated by pauses/gaps. */
  function findRuns(track) {
    var runs = [], a = 0;
    for (var i = 0; i < track.n - 1; i++) {
      if (track.gap[i]) { runs.push({ a: a, b: i }); a = i + 1; }
    }
    runs.push({ a: a, b: track.n - 1 });
    return runs.filter(function (r) { return r.b >= r.a; });
  }

  function medianDt(track, a, b) {
    var arr = [];
    for (var i = a; i < b; i++) if (track.dtSeg[i] > 0) arr.push(track.dtSeg[i]);
    if (!arr.length) return 1;
    arr.sort(function (x, y) { return x - y; });
    return arr[Math.floor(arr.length / 2)];
  }

  /**
   * Re-sample the track with the new speeds.
   *
   * The recording cadence (1 Hz on a Garmin Edge) and the recording pauses are
   * preserved, and every timestamp stays on the original whole-second grid.
   * Everything before the first edit keeps its exact original timestamps; what
   * follows is shifted earlier by the (whole number of seconds) saved.
   *
   * Returns { points, factor, timeline, stats }.
   */
  function rebuild(track, factor, options) {
    options = options || {};
    var align = options.align !== false;
    var f = align ? alignToWholeSeconds(track, factor) : factor;
    var T = newTimeline(track, f);
    var n = track.n, src = track.source, pts = src.points;

    var adjust = options.adjust || {};
    var phys = physFrom(adjust);
    var powerKey = null, hrKey = null;
    for (var c = 0; c < track.channels.length; c++) {
      var ch = track.channels[c];
      if (!ch.extKey) continue;
      var loc = src.extMeta[ch.extKey].local.toLowerCase();
      if (!powerKey && (loc === 'power' || loc === 'watts' || loc === 'powerinwatts')) powerKey = ch.extKey;
      if (!hrKey && (loc === 'hr' || loc === 'heartrate')) hrKey = ch.extKey;
    }
    var doAdjust = (adjust.power && powerKey) || (adjust.hr && hrKey);

    var runs = findRuns(track);
    var out = [];
    var interpolated = 0;
    var EPS = 1e-6;
    var lastTau = -Infinity;

    function emitAt(tau, j0) {
      var j = j0;
      while (j < n - 2 && T[j + 1] < tau - EPS) j++;
      var p;
      if (Math.abs(tau - T[j]) < EPS) p = clonePoint(pts[j]);
      else if (Math.abs(tau - T[j + 1]) < EPS) p = clonePoint(pts[j + 1]);
      else {
        var span = T[j + 1] - T[j];
        var u = span > 0 ? clamp((tau - T[j]) / span, 0, 1) : 0;
        p = interpolatePoint(src, track, j, u);
        interpolated++;
      }
      p.timeMs = track.t0Ms + Math.round(tau * 1000);
      p.seg = track.segOf ? track.segOf[j] : 0;
      if (doAdjust) applyEffortAdjust(track, src, f, j, p, powerKey, hrKey, phys, adjust);
      out.push(p);
      return j;
    }

    for (var r = 0; r < runs.length; r++) {
      var a = runs[r].a, b = runs[r].b;
      var start = Math.round(T[a]);
      if (start <= lastTau) start = lastTau + 1;

      var modified = false;
      for (var m = a; m < b; m++) if (Math.abs(f[m] - 1) > 1e-9) { modified = true; break; }

      if (!modified) {
        // Untouched stretch: copy the original samples verbatim, just shifted.
        var shift = start - track.t[a];
        for (var q = a; q <= b; q++) {
          var cp = clonePoint(pts[q]);
          cp.seg = track.segOf ? track.segOf[q] : 0;
          var tq = track.t[q] + shift;
          cp.timeMs = track.t0Ms + Math.round(tq * 1000);
          out.push(cp);
          lastTau = tq;
        }
        continue;
      }

      var dt = medianDt(track, a, b);
      var end = T[b];
      var j = a, k = 0, tau = start;
      var guard = Math.ceil((end - T[a]) / dt) + 8;
      while (k <= guard) {
        tau = start + k * dt;
        if (tau > T[a] + (end - T[a]) + EPS) break;
        j = emitAt(Math.min(tau, end), j);
        lastTau = tau;
        k++;
      }
      // Make sure the last vertex of the run is reached (the pause must start there).
      if (end - (start + (k - 1) * dt) > 0.4 * dt) {
        var extra = clonePoint(pts[b]);
        extra.seg = track.segOf ? track.segOf[b] : 0;
        var te = start + k * dt;
        extra.timeMs = track.t0Ms + Math.round(te * 1000);
        out.push(extra);
        lastTau = te;
      }
    }

    // Drop any non-increasing timestamp (defensive; can only happen on odd inputs).
    var clean = [];
    for (var z = 0; z < out.length; z++) {
      if (clean.length && out[z].timeMs <= clean[clean.length - 1].timeMs) continue;
      clean.push(out[z]);
    }
    out = clean;

    var newDuration = out.length ? (out[out.length - 1].timeMs - out[0].timeMs) / 1000 : 0;
    var savedSec = track.t[n - 1] - newDuration;
    return {
      points: out,
      factor: f,
      timeline: T,
      runs: runs,
      stats: {
        savedSec: savedSec,
        newDuration: newDuration,
        oldDuration: track.t[n - 1],
        pointsOut: out.length,
        pointsIn: n,
        interpolated: interpolated,
        distance: track.dist[n - 1],
        newAvgKmh: newDuration > 0 ? track.dist[n - 1] / newDuration * 3.6 : 0
      }
    };
  }

  function clonePoint(p) {
    var ext = {};
    for (var key in p.ext) ext[key] = p.ext[key];
    var other = {};
    for (var o in p.other) other[o] = p.other[o];
    return {
      lat: p.lat, lon: p.lon, rawLat: p.rawLat, rawLon: p.rawLon,
      ele: p.ele, rawEle: p.rawEle, timeMs: p.timeMs, seg: p.seg || 0, ext: ext, other: other
    };
  }

  function interpolatePoint(src, track, j, u) {
    var a = src.points[j], b = src.points[j + 1];
    var ext = {};
    for (var key in a.ext) {
      var va = a.ext[key], vb = b.ext[key];
      var meta = src.extMeta[key];
      if (meta && meta.numeric) {
        var fa = parseFloat(va), fb = vb !== undefined ? parseFloat(vb) : NaN;
        if (isFinite(fa) && isFinite(fb)) ext[key] = String(lerp(fa, fb, u));
        else if (isFinite(fa)) ext[key] = String(fa);
        else if (isFinite(fb)) ext[key] = String(fb);
      } else {
        ext[key] = u < 0.5 ? va : (vb !== undefined ? vb : va);
      }
    }
    for (var key2 in b.ext) if (ext[key2] === undefined) ext[key2] = b.ext[key2];
    var other = {};
    var srcOther = u < 0.5 ? a.other : b.other;
    for (var o in srcOther) other[o] = srcOther[o];
    return {
      lat: lerp(a.lat, b.lat, u), lon: lerp(a.lon, b.lon, u),
      rawLat: null, rawLon: null,
      ele: lerp(isFinite(a.ele) ? a.ele : b.ele, isFinite(b.ele) ? b.ele : a.ele, u), rawEle: null,
      timeMs: 0, ext: ext, other: other
    };
  }

  /**
   * Rapport puissance nouvelle / puissance d'origine au point j, d'après le
   * modèle physique. Sert à la fois à l'aperçu dans les graphes et à l'export,
   * pour que les deux racontent exactement la même chose.
   */
  function effortRatio(track, factor, j, phys) {
    var f = factor[Math.min(j, factor.length - 1)];
    if (!isFinite(f) || Math.abs(f - 1) < 1e-6) return 1;
    var v = track.vSmooth[j];
    if (!(v > 1)) return 1;
    var grade = track.grade[j];
    var p0 = powerRequired(v, grade, phys);
    var p1 = powerRequired(v * f, grade, phys);
    if (!(p0 > 1)) return 1;
    return p1 / p0;
  }

  /** Fréquence cardiaque suivant la variation de puissance (modèle simple). */
  function adjustedHr(hr, ratio, hrMax) {
    return clamp(hr * Math.pow(ratio, 0.35), 35, hrMax || 190);
  }

  function physFrom(adjust) {
    adjust = adjust || {};
    return {
      mass: adjust.mass || 83, cda: adjust.cda || 0.32,
      crr: adjust.crr || 0.005, rho: adjust.rho || 1.2, eff: 0.97
    };
  }

  function applyEffortAdjust(track, src, factor, j, p, powerKey, hrKey, phys, adjust) {
    var ratio = effortRatio(track, factor, j, phys);
    if (ratio === 1) return;
    if (adjust.power && powerKey && p.ext[powerKey] !== undefined) {
      var pw = parseFloat(p.ext[powerKey]);
      if (isFinite(pw)) p.ext[powerKey] = String(Math.max(0, pw * ratio));
    }
    if (adjust.hr && hrKey && p.ext[hrKey] !== undefined) {
      var hr = parseFloat(p.ext[hrKey]);
      if (isFinite(hr)) p.ext[hrKey] = String(adjustedHr(hr, ratio, adjust.hrMax));
    }
  }

  function fmtDur(sec) {
    sec = Math.round(Math.abs(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + 'h' + String(m).padStart(2, '0') : m + 'min') + (h ? '' : String(s).padStart(2, '0') + 's');
  }

  global.Edits = {
    defaultEdit: defaultEdit,
    composeFactors: composeFactors,
    resolveEdit: resolveEdit,
    rebuild: rebuild,
    findRuns: findRuns,
    newTimeline: newTimeline,
    savedTime: savedTime,
    alignToWholeSeconds: alignToWholeSeconds,
    intervalSpeedKmh: intervalSpeedKmh,
    intervalValue: intervalValue,
    powerRequired: powerRequired,
    effortRatio: effortRatio,
    adjustedHr: adjustedHr,
    physFrom: physFrom,
    fmtDur: fmtDur
  };
})(typeof window !== 'undefined' ? window : globalThis);
