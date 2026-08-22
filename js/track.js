/* Turns a parsed GPX into numeric channels: distance, speed, slope, plus every
 * numeric extension field found in the file (HR, cadence, power, temperature...).
 */
(function (global) {
  'use strict';

  var R_EARTH = 6371008.8;
  var DEG = Math.PI / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  var EXT_LABELS = {
    hr: { label: 'Fréquence cardiaque', unit: 'bpm', color: '#ef4444', decimals: 0 },
    heartrate: { label: 'Fréquence cardiaque', unit: 'bpm', color: '#ef4444', decimals: 0 },
    cad: { label: 'Cadence', unit: 'tr/min', color: '#22d3ee', decimals: 0 },
    cadence: { label: 'Cadence', unit: 'tr/min', color: '#22d3ee', decimals: 0 },
    atemp: { label: 'Température', unit: '°C', color: '#f59e0b', decimals: 1 },
    temp: { label: 'Température', unit: '°C', color: '#f59e0b', decimals: 1 },
    wtemp: { label: 'Température eau', unit: '°C', color: '#38bdf8', decimals: 1 },
    power: { label: 'Puissance', unit: 'W', color: '#a855f7', decimals: 0 },
    watts: { label: 'Puissance', unit: 'W', color: '#a855f7', decimals: 0 },
    PowerInWatts: { label: 'Puissance', unit: 'W', color: '#a855f7', decimals: 0 },
    speed: { label: 'Vitesse (capteur)', unit: 'm/s', color: '#4ade80', decimals: 2 },
    distance: { label: 'Distance (capteur)', unit: 'm', color: '#94a3b8', decimals: 0 },
    course: { label: 'Cap', unit: '°', color: '#94a3b8', decimals: 0 },
    seaLevelPressure: { label: 'Pression', unit: 'hPa', color: '#94a3b8', decimals: 1 }
  };

  function movingAverage(src, window) {
    var n = src.length, out = new Float64Array(n);
    if (window <= 1) { out.set(src); return out; }
    var half = Math.floor(window / 2);
    var sum = 0, count = 0;
    var head = 0;
    // Simple O(n) sliding window that ignores NaN.
    var acc = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) {
      var v = src[i];
      acc[i + 1] = acc[i] + (isFinite(v) ? v : 0);
      cnt[i + 1] = cnt[i] + (isFinite(v) ? 1 : 0);
    }
    for (var j = 0; j < n; j++) {
      var a = Math.max(0, j - half), b = Math.min(n, j + half + 1);
      sum = acc[b] - acc[a]; count = cnt[b] - cnt[a];
      out[j] = count ? sum / count : NaN;
    }
    void head;
    return out;
  }

  /** Slope in degrees, computed on a ±window/2 metre distance baseline. */
  function computeGrade(dist, ele, windowM) {
    var n = dist.length, out = new Float64Array(n);
    var half = Math.max(2, windowM / 2);
    var lo = 0, hi = 0;
    for (var i = 0; i < n; i++) {
      while (lo < i && dist[i] - dist[lo] > half) lo++;
      while (hi < n - 1 && dist[hi] - dist[i] < half) hi++;
      var run = dist[hi] - dist[lo];
      if (run < 1) { out[i] = i > 0 ? out[i - 1] : 0; continue; }
      var rise = ele[hi] - ele[lo];
      out[i] = Math.atan2(rise, run) / DEG;
    }
    return out;
  }

  /**
   * @param source parsed GPX
   * @param opts   {speedSmooth (s), gradeWindow (m), pauseGap (s)}
   */
  function build(source, opts) {
    opts = opts || {};
    var speedSmooth = opts.speedSmooth != null ? opts.speedSmooth : 5;
    var gradeWindow = opts.gradeWindow != null ? opts.gradeWindow : 40;
    var pauseGap = opts.pauseGap != null ? opts.pauseGap : 10;

    var pts = source.points, n = pts.length;
    var lat = new Float64Array(n), lon = new Float64Array(n), ele = new Float64Array(n);
    var t = new Float64Array(n), dist = new Float64Array(n);
    var t0 = pts[0].timeMs;

    for (var i = 0; i < n; i++) {
      lat[i] = pts[i].lat; lon[i] = pts[i].lon;
      ele[i] = isFinite(pts[i].ele) ? pts[i].ele : NaN;
      t[i] = (pts[i].timeMs - t0) / 1000;
    }
    // Fill elevation holes so slope stays defined everywhere.
    var lastEle = NaN;
    for (var e = 0; e < n; e++) { if (isFinite(ele[e])) lastEle = ele[e]; else ele[e] = lastEle; }
    for (var e2 = n - 1; e2 >= 0; e2--) { if (isFinite(ele[e2])) lastEle = ele[e2]; else ele[e2] = lastEle; }
    if (!isFinite(ele[0])) ele.fill(0);

    var dSeg = new Float64Array(Math.max(0, n - 1));   // metres per interval
    var dtSeg = new Float64Array(Math.max(0, n - 1));  // seconds per interval
    var gap = new Uint8Array(Math.max(0, n - 1));
    for (var k = 0; k < n - 1; k++) {
      var d = haversine(lat[k], lon[k], lat[k + 1], lon[k + 1]);
      var dt = t[k + 1] - t[k];
      if (!(dt > 0)) dt = 0;
      dSeg[k] = d; dtSeg[k] = dt;
      if (dt > pauseGap || dt === 0) gap[k] = 1;
      dist[k + 1] = dist[k] + d;
    }

    // Point speed (m/s) from the two neighbouring intervals.
    var vPoint = new Float64Array(n);
    for (var p = 0; p < n; p++) {
      var dd = 0, ddt = 0;
      if (p > 0) { dd += dSeg[p - 1]; ddt += dtSeg[p - 1]; }
      if (p < n - 1) { dd += dSeg[p]; ddt += dtSeg[p]; }
      vPoint[p] = ddt > 0 ? dd / ddt : 0;
    }
    var vSmooth = movingAverage(vPoint, Math.max(1, Math.round(speedSmooth)));
    var eleSmooth = movingAverage(ele, 9);
    var grade = computeGrade(dist, eleSmooth, gradeWindow);

    var channels = [];
    var speedKmh = new Float64Array(n);
    for (var s = 0; s < n; s++) speedKmh[s] = vSmooth[s] * 3.6;

    channels.push({ key: 'speed', label: 'Vitesse', unit: 'km/h', color: '#38bdf8', decimals: 1, data: speedKmh, derived: true, filterable: true, visible: true });
    channels.push({ key: 'ele', label: 'Altitude', unit: 'm', color: '#94a3b8', decimals: 0, data: ele, derived: true, filterable: true, visible: true, fill: true });
    channels.push({ key: 'grade', label: 'Pente', unit: '°', color: '#fbbf24', decimals: 1, data: grade, derived: true, filterable: true, visible: true, zero: true });

    // Extension channels, in file order.
    for (var x = 0; x < source.extOrder.length; x++) {
      var key = source.extOrder[x];
      var meta = source.extMeta[key];
      if (!meta.numeric || !meta.count) continue;
      var arr = new Float64Array(n); arr.fill(NaN);
      var any = false;
      for (var q = 0; q < n; q++) {
        var raw = pts[q].ext[key];
        if (raw === undefined || raw === '') continue;
        var f = parseFloat(raw);
        if (isFinite(f)) { arr[q] = f; any = true; }
      }
      if (!any) continue;
      var lbl = EXT_LABELS[meta.local] || { label: meta.local, unit: '', color: '#c084fc', decimals: meta.integer ? 0 : 1 };
      channels.push({
        key: 'ext:' + key, extKey: key, label: lbl.label, unit: lbl.unit, color: lbl.color,
        decimals: lbl.decimals, data: arr, derived: false, filterable: true, visible: true
      });
    }

    var vmaxKmh = 0, movingTime = 0, movingDist = 0, elevGain = 0;
    for (var m = 0; m < n; m++) if (speedKmh[m] > vmaxKmh) vmaxKmh = speedKmh[m];
    for (var g = 0; g < n - 1; g++) {
      if (gap[g]) continue;
      var vi = dtSeg[g] > 0 ? dSeg[g] / dtSeg[g] : 0;
      if (vi > 0.8) { movingTime += dtSeg[g]; movingDist += dSeg[g]; }
    }
    for (var h = 1; h < n; h++) { var de = eleSmooth[h] - eleSmooth[h - 1]; if (de > 0) elevGain += de; }

    return {
      source: source, n: n, t0Ms: t0,
      lat: lat, lon: lon, ele: ele, eleSmooth: eleSmooth,
      t: t, dist: dist, dSeg: dSeg, dtSeg: dtSeg, gap: gap,
      vPoint: vPoint, vSmooth: vSmooth, grade: grade,
      channels: channels,
      opts: { speedSmooth: speedSmooth, gradeWindow: gradeWindow, pauseGap: pauseGap },
      stats: {
        duration: t[n - 1], distance: dist[n - 1], movingTime: movingTime, movingDist: movingDist,
        avgKmh: t[n - 1] > 0 ? dist[n - 1] / t[n - 1] * 3.6 : 0,
        avgMovingKmh: movingTime > 0 ? movingDist / movingTime * 3.6 : 0,
        maxKmh: vmaxKmh, elevGain: elevGain,
        startMs: t0, endMs: pts[n - 1].timeMs
      }
    };
  }

  function channelByKey(track, key) {
    for (var i = 0; i < track.channels.length; i++) if (track.channels[i].key === key) return track.channels[i];
    return null;
  }

  global.Track = { build: build, haversine: haversine, movingAverage: movingAverage, channelByKey: channelByKey };
})(typeof window !== 'undefined' ? window : globalThis);
