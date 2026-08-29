/* Starca Tuner — application shell: loading, panels, selection, export. */
(function () {
  'use strict';

  var S = {
    fileName: null, source: null, track: null, stack: null, map: null,
    edits: [], selection: null, pending: null, lastResult: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var fmtClock = window.ChartUtils.fmtClock;

  function fmtDelta(sec) {
    var s = Math.round(Math.abs(sec));
    var m = Math.floor(s / 60);
    return (sec >= 0 ? '−' : '+') + (m ? m + ' min ' : '') + (s % 60) + ' s';
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

  /* ------------------------------------------------------------------ load */

  function loadText(text, name) {
    var source, track;
    try {
      source = GPX.parse(text);
      track = Track.build(source, analysisOpts());
    } catch (e) {
      alert('Lecture impossible : ' + e.message);
      return;
    }
    S.fileName = name; S.source = source; S.track = track; S.edits = []; S.selection = null; S.pending = null;

    $('empty').hidden = true;
    $('export').disabled = false;

    if (!S.stack) {
      S.stack = new ChartStack($('charts'), {
        footer: $('chartFooter'),
        onView: function (v) { S.map.setView(v.i0, v.i1); },
        onSelect: onChartSelect,
        onHover: function (i) { S.map.setHover(i); }
      });
    }
    S.stack.setTrack(track);

    if (!S.map) {
      S.map = new TrackMap($('map'), {
        onSelect: function (a, b) { S.stack.setSelectionIndices(a, b); },
        onHover: function (i) { S.stack.setHoverIndex(i); }
      });
      var sel = $('tileSource'), srcs = S.map.sources();
      Object.keys(srcs).forEach(function (k) {
        var o = document.createElement('option');
        o.value = k; o.textContent = srcs[k].name;
        sel.appendChild(o);
      });
      sel.value = S.map.source;
      sel.addEventListener('change', function () { S.map.setSource(sel.value); });
    }
    S.map.setTrack(track);
    S.map.setView(0, track.n - 1);

    $('startDate').value = UI.toLocalInput(track.t0Ms);
    updateDateInfo();

    buildChannelChips();
    buildFilterRows();
    renderActivity();
    renderEdits();
    updateSelectionUI();
    updateOverlay();
  }

  function analysisOpts() {
    return {
      speedSmooth: parseFloat($('optSpeedSmooth').value) || 5,
      gradeWindow: parseFloat($('optGradeWin').value) || 40,
      pauseGap: parseFloat($('optPause').value) || 10
    };
  }

  function renderActivity() {
    var t = S.track, st = t.stats;
    var d = new Date(st.startMs);
    $('activity').innerHTML = '<b>' + escapeHtml(S.source.name) + '</b> — ' + d.toLocaleString('fr-FR') +
      ' · ' + fmtDist(st.distance) + ' · ' + fmtClock(st.duration) +
      ' · D+ ' + Math.round(st.elevGain) + ' m · ' + st.avgMovingKmh.toFixed(1) + ' km/h moy' +
      ' · ' + t.n + ' points';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /* -------------------------------------------------------------- channels */

  function buildChannelChips() {
    var box = $('chanToggles');
    box.innerHTML = '';
    S.track.channels.forEach(function (ch) {
      if (ch.visible === false && S.stack) S.stack.setRowVisible(ch.key, false);
      var b = document.createElement('button');
      b.className = 'chip' + (ch.visible === false ? '' : ' on');
      b.innerHTML = '<span class="cdot" style="background:' + ch.color + '"></span>' + escapeHtml(ch.label);
      b.addEventListener('click', function () {
        var on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        S.stack.setRowVisible(ch.key, on);
      });
      box.appendChild(b);
    });
  }

  /* ------------------------------------------------------------- selection */

  function onChartSelect(sel) {
    S.selection = sel;
    if (sel) S.map.setSelection(sel.i0, sel.i1); else S.map.setSelection(null);
    updateSelectionUI();
    updatePreview();
  }

  function segStats(i0, i1) {
    var t = S.track;
    i0 = Math.max(0, Math.min(t.n - 1, i0)); i1 = Math.max(0, Math.min(t.n - 1, i1));
    if (i1 < i0) { var s = i0; i0 = i1; i1 = s; }
    var dur = t.t[i1] - t.t[i0], dist = t.dist[i1] - t.dist[i0];
    var gain = 0, moving = 0, movDist = 0;
    for (var i = i0; i < i1; i++) {
      var de = t.eleSmooth[i + 1] - t.eleSmooth[i];
      if (de > 0) gain += de;
      if (!t.gap[i] && t.dSeg[i] / Math.max(0.001, t.dtSeg[i]) > 0.8) { moving += t.dtSeg[i]; movDist += t.dSeg[i]; }
    }
    return {
      i0: i0, i1: i1, dur: dur, dist: dist, gain: gain,
      avg: dur > 0 ? dist / dur * 3.6 : 0,
      avgMoving: moving > 0 ? movDist / moving * 3.6 : 0,
      grade: dist > 0 ? Math.atan2(t.eleSmooth[i1] - t.eleSmooth[i0], dist) * 180 / Math.PI : 0
    };
  }

  function updateSelectionUI() {
    var has = !!S.selection;
    $('zoomSel').disabled = !has;
    $('clearSel').disabled = !has;
    $('mapFitSel').disabled = !has;
    $('editCard').hidden = !has;
    if (!has) {
      $('selInfo').className = 'kv dim';
      $('selInfo').textContent = 'Aucune sélection. Glissez dans un graphe, ou activez « Sélection sur la carte ».';
      return;
    }
    var st = segStats(S.selection.i0, S.selection.i1);
    var t = S.track;
    $('selInfo').className = 'kv';
    $('selInfo').innerHTML =
      row('Départ', fmtClock(t.t[st.i0]) + '  ·  ' + fmtDist(t.dist[st.i0])) +
      row('Arrivée', fmtClock(t.t[st.i1]) + '  ·  ' + fmtDist(t.dist[st.i1])) +
      row('Durée', fmtClock(st.dur)) +
      row('Distance', fmtDist(st.dist)) +
      row('Vitesse moy.', st.avg.toFixed(1) + ' km/h' + (st.avgMoving - st.avg > 0.3 ? ' (' + st.avgMoving.toFixed(1) + ' en mouvement)' : '')) +
      row('Dénivelé +', Math.round(st.gain) + ' m') +
      row('Pente moy.', st.grade.toFixed(2) + ' °') +
      row('Points', (st.i1 - st.i0 + 1) + '');
    buildFilterRows();
  }

  function row(k, v) { return '<span>' + k + '</span><b>' + escapeHtml(v) + '</b>'; }

  /* ---------------------------------------------------------------- filters */

  function filterableChannels() {
    return S.track.channels.filter(function (c) { return c.filterable !== false && c.key !== 'ele'; })
      .concat(S.track.channels.filter(function (c) { return c.key === 'ele'; }));
  }

  var filterState = {};   // key -> {on, min, max}

  function buildFilterRows() {
    var box = $('filters');
    if (!box || !S.track) return;
    var sel = S.selection;
    box.innerHTML = '';
    filterableChannels().forEach(function (ch) {
      var st = filterState[ch.key] || (filterState[ch.key] = { on: false, min: '', max: '' });
      var rmin = Infinity, rmax = -Infinity;
      if (sel) {
        for (var i = sel.i0; i <= sel.i1; i++) {
          var v = ch.data[i];
          if (!isFinite(v)) continue;
          if (v < rmin) rmin = v; if (v > rmax) rmax = v;
        }
      }
      var rangeTxt = isFinite(rmin) ? rmin.toFixed(ch.decimals) + ' … ' + rmax.toFixed(ch.decimals) : '';
      var el = document.createElement('div');
      el.className = 'frow';
      el.innerHTML =
        '<label><input type="checkbox" ' + (st.on ? 'checked' : '') + '>' +
        '<span class="fdot" style="background:' + ch.color + '"></span>' + escapeHtml(ch.label) +
        (ch.unit ? ' <span class="u">' + ch.unit + '</span>' : '') + '</label>' +
        '<span class="rng">' + rangeTxt + '</span>' +
        '<input type="number" step="any" placeholder="min" value="' + st.min + '" ' + (st.on ? '' : 'disabled') + '>' +
        '<input type="number" step="any" placeholder="max" value="' + st.max + '" ' + (st.on ? '' : 'disabled') + '>';
      var cb = el.querySelector('input[type=checkbox]');
      var mins = el.querySelectorAll('input[type=number]');
      cb.addEventListener('change', function () {
        st.on = cb.checked;
        mins[0].disabled = mins[1].disabled = !st.on;
        updatePreview();
      });
      mins[0].addEventListener('input', function () { st.min = mins[0].value; updatePreview(); });
      mins[1].addEventListener('input', function () { st.max = mins[1].value; updatePreview(); });
      box.appendChild(el);
    });
  }

  /* ------------------------------------------------------------------ edit */

  function readEdit() {
    if (!S.selection) return null;
    var e = Edits.defaultEdit(S.track, S.selection.i0, S.selection.i1);
    e.mode = $('mode').value;
    e.targetSec = (parseFloat($('targetMin').value) || 0) * 60 + (parseFloat($('targetSec').value) || 0);
    e.factor = parseFloat($('factor').value) || 1;
    e.deltaKmh = parseFloat($('delta2').value) || 0;
    e.speedKmh = parseFloat($('speedTarget').value) || 0;
    e.maxSpeedKmh = parseFloat($('maxSpeed').value) || 0;
    e.minSpeedKmh = parseFloat($('minSpeed').value) || 0;
    e.maxFactor = parseFloat($('maxFactor').value) || 2.5;
    e.rampSec = parseFloat($('ramp').value) || 0;
    e.smoothSec = parseFloat($('smooth').value) || 0;
    e.filters = [];
    filterableChannels().forEach(function (ch) {
      var st = filterState[ch.key];
      if (!st || !st.on) return;
      var mn = st.min === '' ? null : parseFloat(st.min);
      var mx = st.max === '' ? null : parseFloat(st.max);
      if (mn === null && mx === null) return;
      e.filters.push({ key: ch.key, label: ch.label, unit: ch.unit, min: isFinite(mn) ? mn : null, max: isFinite(mx) ? mx : null, enabled: true });
    });
    return e;
  }

  function describeFilters(e) {
    if (!e.filters.length) return 'tous les points';
    return e.filters.map(function (f) {
      var s = f.label.toLowerCase();
      if (f.min != null && f.max != null) return s + ' ' + f.min + '–' + f.max + ' ' + (f.unit || '');
      if (f.min != null) return s + ' > ' + f.min + ' ' + (f.unit || '');
      return s + ' < ' + f.max + ' ' + (f.unit || '');
    }).join(', ');
  }

  function updatePreview() {
    var box = $('preview');
    S.pending = readEdit();
    if (!S.pending) { updateOverlay(); return; }
    var r = Edits.resolveEdit(S.track, S.pending);
    var t = S.track;
    var nInt = 0, sumT = 0, maxNew = 0, sumF = 0, fw = 0;
    for (var i = r.i0; i < r.i1; i++) {
      if (Math.abs(r.factors[i] - 1) < 1e-9) continue;
      nInt++; sumT += t.dtSeg[i];
      sumF += r.factors[i] * t.dtSeg[i]; fw += t.dtSeg[i];
      var v = Edits.intervalSpeedKmh(t, i) * r.factors[i];
      if (v > maxNew) maxNew = v;
    }
    var st = segStats(r.i0, r.i1);
    var html = '';
    if (!nInt) {
      html = '<span class="warn">Aucun point ne correspond aux filtres sur ce tronçon.</span>';
    } else {
      html = 'Points retouchés : <b>' + nInt + '</b> (' + Math.round(sumT / Math.max(1, st.dur) * 100) + ' % de la durée du tronçon)<br>' +
        'Facteur moyen : <b>×' + (fw ? sumF / fw : 1).toFixed(3) + '</b> · vitesse max atteinte <b>' + maxNew.toFixed(1) + ' km/h</b><br>' +
        'Gain sur le tronçon : <b>' + fmtDelta(r.saved) + '</b> (' + fmtClock(st.dur) + ' → ' + fmtClock(st.dur - r.saved) + ')';
      if (r.warn) html += '<br><span class="warn">' + escapeHtml(r.warn) + '</span>';
    }
    box.innerHTML = html;
    updateOverlay();
  }

  /** Courbes « après retouche » : vitesse, et puissance / FC si leur recalcul est coché. */
  function updateOverlay() {
    if (!S.track || !S.stack) return;
    var list = S.edits.slice();
    if (S.pending) list.push(S.pending);
    var ov = UI.overlays(S.track, list, buildOptions().adjust);
    S.stack.setOverlays(ov.data);

    var t = S.track;
    var applied = Edits.composeFactors(S.track, S.edits);
    var saved = Edits.savedTime(S.track, applied.factor, 0, applied.factor.length);
    $('delta').textContent = saved ? 'Gain cumulé : ' + fmtDelta(saved) + '  ·  ' +
      fmtClock(t.stats.duration) + ' → ' + fmtClock(t.stats.duration - saved) : '';
  }

  function applyEdit() {
    var e = readEdit();
    if (!e) return;
    var r = Edits.resolveEdit(S.track, e);
    if (!r.count) { alert('Aucun point ne correspond aux filtres : rien à appliquer.'); return; }
    e.label = describeFilters(e);
    S.edits.push(e);
    S.pending = null;
    S.stack.setSelection(null);
    renderEdits();
    updateOverlay();
  }

  function renderEdits() {
    var box = $('editList');
    $('editCount').textContent = S.edits.length;
    if (!S.edits.length) {
      box.className = 'editlist dim';
      box.textContent = 'Aucune modification appliquée.';
      updateOverlay();
      return;
    }
    box.className = 'editlist';
    box.innerHTML = '';
    var comp = Edits.composeFactors(S.track, S.edits);
    S.edits.forEach(function (e, idx) {
      var info = comp.perEdit[idx];
      var t = S.track;
      var el = document.createElement('div');
      el.className = 'erow' + (e.enabled ? '' : ' off');
      el.innerHTML =
        '<div class="etxt"><div>' + (idx + 1) + '. ' + fmtDist(t.dist[e.i0]) + ' → ' + fmtDist(t.dist[e.i1]) +
        '  <b>' + (e.enabled ? fmtDelta(info.saved || 0) : '—') + '</b></div>' +
        '<div class="esub">' + escapeHtml(e.label || describeFilters(e)) + '</div></div>' +
        '<button title="Voir sur la carte et les graphes">◎</button>' +
        '<button title="Activer / désactiver">' + (e.enabled ? '👁' : '🚫') + '</button>' +
        '<button title="Supprimer">🗑</button>';
      var btns = el.querySelectorAll('button');
      btns[0].addEventListener('click', function () {
        S.stack.setSelectionIndices(e.i0, e.i1);
        S.stack.zoomToSelection();
        S.map.fitBounds(S.map.boundsOf(e.i0, e.i1));
      });
      btns[1].addEventListener('click', function () { e.enabled = !e.enabled; renderEdits(); updateOverlay(); });
      btns[2].addEventListener('click', function () { S.edits.splice(idx, 1); renderEdits(); updateOverlay(); });
      box.appendChild(el);
    });
    updateOverlay();
  }

  /* ---------------------------------------------------------------- export */

  function updateDateInfo() {
    if (!S.track) return;
    var ms = UI.fromLocalInput($('startDate').value);
    var delta = isFinite(ms) ? ms - S.track.t0Ms : 0;
    $('dateShift').textContent = UI.describeShift(delta);
  }

  function buildOptions() {
    var startMs = UI.fromLocalInput($('startDate').value);
    return {
      startMs: isFinite(startMs) ? startMs : null,
      align: $('optAlign').checked,
      adjust: {
        power: $('optPower').checked, hr: $('optHr').checked,
        mass: parseFloat($('mass').value) || 83,
        cda: parseFloat($('cda').value) || 0.32,
        crr: parseFloat($('crr').value) || 0.005,
        hrMax: parseFloat($('hrMax').value) || 190
      }
    };
  }

  function doExport() {
    var out = UI.buildExport(S.track, S.source, S.edits, buildOptions(), S.fileName);
    var res = out.res, text = out.text, check = out.check;
    S.lastResult = res;

    var t = S.track;
    var name = out.name;
    var html = '<table>' +
      tr('Durée', fmtClock(res.stats.oldDuration) + '  →  <b>' + fmtClock(res.stats.newDuration) + '</b>') +
      tr('Gain', '<b>' + fmtDelta(res.stats.savedSec) + '</b>') +
      tr('Distance', fmtDist(check.info.distanceM) + ' (origine ' + fmtDist(t.stats.distance) + ')') +
      tr('Vitesse moyenne', (t.stats.distance / t.stats.duration * 3.6).toFixed(2) + ' → <b>' +
        (t.stats.distance / res.stats.newDuration * 3.6).toFixed(2) + ' km/h</b>') +
      tr('Points', t.n + ' → ' + res.stats.pointsOut + ' (' + res.stats.interpolated + ' recalculés)') +
      tr('Début', new Date(check.info.start).toLocaleString('fr-FR')) +
      tr('Fin', new Date(check.info.end).toLocaleString('fr-FR')) +
      tr('Vitesse instantanée max.', check.info.maxSpeedKmh.toFixed(1) + ' km/h') +
      '</table>';

    html += check.ok
      ? '<p class="ok">✓ Fichier conforme au schéma GPX 1.1 (structure, horodatages ISO-8601 strictement croissants, coordonnées valides) — prêt pour l’import Strava.</p>'
      : '<p class="err">✗ Problèmes détectés :</p><ul class="err"><li>' + check.errors.map(escapeHtml).join('</li><li>') + '</li></ul>';
    if (check.warnings.length) html += '<ul class="warn"><li>' + check.warnings.map(escapeHtml).join('</li><li>') + '</li></ul>';
    if (!S.edits.length) html += '<p class="warn">Aucune modification n’est appliquée : le fichier exporté est identique à l’original.</p>';
    html += '<p class="dim">Import Strava : « Ajouter → Fichier », ou glissez le fichier sur strava.com/upload. ' +
      'Les horodatages avant la première retouche sont inchangés ; la suite est décalée du gain de temps.</p>';

    $('modalTitle').textContent = name;
    $('modalBody').innerHTML = html;
    var a = $('download');
    if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
    var url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    a.href = url; a.download = name; a.dataset.url = url;
    $('modal').hidden = false;
  }

  function tr(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }

  /* ------------------------------------------------------------------ wire */

  function wire() {
    $('file').addEventListener('change', function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { loadText(String(fr.result), f.name); };
      fr.readAsText(f);
    });

    ['dragover', 'drop'].forEach(function (t) {
      window.addEventListener(t, function (ev) { ev.preventDefault(); });
    });
    window.addEventListener('drop', function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { loadText(String(fr.result), f.name); };
      fr.readAsText(f);
    });

    document.querySelectorAll('.seg[data-x]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.seg[data-x]').forEach(function (o) { o.classList.toggle('on', o === b); });
        if (S.stack) S.stack.setXMode(b.dataset.x);
      });
    });

    $('zoomSel').addEventListener('click', function () { S.stack.zoomToSelection(); });
    $('zoomReset').addEventListener('click', function () { S.stack.resetView(); });
    $('clearSel').addEventListener('click', function () { S.stack.setSelection(null); });
    $('mapFitAll').addEventListener('click', function () { S.map.fitBounds(S.map.bounds); });
    $('mapFitView').addEventListener('click', function () {
      var v = S.stack.viewIndices(); S.map.fitBounds(S.map.boundsOf(v.i0, v.i1));
    });
    $('mapFitSel').addEventListener('click', function () {
      if (S.selection) S.map.fitBounds(S.map.boundsOf(S.selection.i0, S.selection.i1));
    });
    $('mapSelect').addEventListener('click', function () {
      S.map.selectMode = !S.map.selectMode;
      this.classList.toggle('on', S.map.selectMode);
      $('map').style.cursor = S.map.selectMode ? 'crosshair' : 'grab';
    });

    $('mode').addEventListener('change', function () {
      var m = $('mode').value;
      $('fTarget').hidden = m !== 'target';
      $('fFactor').hidden = m !== 'factor';
      $('fDelta').hidden = m !== 'delta';
      $('fSpeed').hidden = m !== 'speed';
      updatePreview();
    });
    ['targetMin', 'targetSec', 'factor', 'delta2', 'speedTarget', 'maxSpeed', 'minSpeed', 'maxFactor', 'ramp', 'smooth']
      .forEach(function (id) { $(id).addEventListener('input', updatePreview); });

    $('apply').addEventListener('click', applyEdit);
    $('resetParams').addEventListener('click', function () {
      $('mode').value = 'target'; $('mode').dispatchEvent(new Event('change'));
      $('targetMin').value = 1; $('targetSec').value = 0; $('factor').value = 1.1;
      $('delta2').value = 3; $('speedTarget').value = 28; $('maxSpeed').value = 0;
      $('minSpeed').value = 5; $('maxFactor').value = 2.5; $('ramp').value = 15; $('smooth').value = 10;
      Object.keys(filterState).forEach(function (k) { filterState[k] = { on: false, min: '', max: '' }; });
      buildFilterRows(); updatePreview();
    });

    ['optAlign', 'optPower', 'optHr'].forEach(function (id) { $(id).addEventListener('change', updateOverlay); });
    ['mass', 'cda', 'crr', 'hrMax'].forEach(function (id) { $(id).addEventListener('input', updateOverlay); });
    ['optSpeedSmooth', 'optGradeWin', 'optPause'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (!S.source) return;
        var sel = S.selection, view = S.stack.viewIndices(), xmode = S.stack.xMode, edits = S.edits;
        S.track = Track.build(S.source, analysisOpts());
        S.stack.setTrack(S.track);
        S.stack.xMode = xmode;
        S.map.setTrack(S.track);
        S.edits = edits;
        S.stack.setView([S.stack.xArray()[view.i0], S.stack.xArray()[view.i1]]);
        if (sel) S.stack.setSelectionIndices(sel.i0, sel.i1);
        buildChannelChips(); renderEdits(); updateOverlay();
      });
    });

    $('startDate').addEventListener('input', updateDateInfo);
    $('resetDate').addEventListener('click', function () {
      if (!S.track) return;
      $('startDate').value = UI.toLocalInput(S.track.t0Ms);
      updateDateInfo();
    });

    $('export').addEventListener('click', doExport);
    $('modalClose').addEventListener('click', function () { $('modal').hidden = true; });
    $('modal').addEventListener('click', function (ev) { if (ev.target === $('modal')) $('modal').hidden = true; });
    $('help').addEventListener('click', showHelp);

    document.addEventListener('keydown', function (ev) {
      if (/input|select|textarea/i.test(ev.target.tagName)) return;
      if (!S.track) return;
      if (ev.key === 'z') S.stack.zoomToSelection();
      else if (ev.key === 'r') S.stack.resetView();
      else if (ev.key === 'Escape') { S.stack.setSelection(null); $('modal').hidden = true; }
      else if (ev.key === 'Enter' && S.selection) applyEdit();
      else if (ev.key === 'm') $('mapSelect').click();
    });

    // splitter
    var sp = $('splitter'), dragging = false;
    sp.addEventListener('pointerdown', function (ev) { dragging = true; try { sp.setPointerCapture(ev.pointerId); } catch (e) {} });
    sp.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var w = Math.max(300, Math.min(window.innerWidth - 360, window.innerWidth - ev.clientX));
      document.querySelector('.right').style.width = w + 'px';
    });
    sp.addEventListener('pointerup', function () { dragging = false; if (S.stack) S.stack.resize(); if (S.map) S.map.resize(); });
  }

  function showHelp() {
    $('modalTitle').textContent = 'Mode d’emploi';
    $('modalBody').innerHTML =
      '<h3>Graphes</h3><ul>' +
      '<li><kbd>glisser</kbd> sélectionne un tronçon · <kbd>maj</kbd>+glisser déplace la vue</li>' +
      '<li><kbd>molette</kbd> zoome, tous les graphes restent synchronisés</li>' +
      '<li><kbd>double-clic</kbd> ou <kbd>r</kbd> : vue complète · <kbd>z</kbd> : zoom sur la sélection</li>' +
      '<li>l’axe Y de chaque graphe s’adapte à la fenêtre visible, ou se fige avec « auto Y » décoché</li>' +
      '<li>la bande du bas donne le profil complet et la position de la vue</li></ul>' +
      '<h3>Carte</h3><ul>' +
      '<li>la portion visible dans les graphes est tracée en bleu vif, la sélection en orange</li>' +
      '<li>« Sélection sur la carte » (<kbd>m</kbd>) : glissez le long du tracé pour choisir un tronçon</li>' +
      '<li><kbd>maj</kbd>+glisser inverse le mode en cours</li></ul>' +
      '<h3>Retouche</h3><ul>' +
      '<li>choisissez la consigne (temps à gagner, facteur, km/h, vitesse cible)</li>' +
      '<li>les filtres restreignent la retouche à certains points (pente, vitesse, puissance, FC…) — ' +
      'l’accélération n’est donc pas uniforme sur le tronçon</li>' +
      '<li>« Appliquer » empile la modification ; vous pouvez enchaîner d’autres tronçons</li>' +
      '<li>la courbe orange sur le graphe de vitesse montre le résultat</li></ul>' +
      '<h3>Export</h3><p>Le fichier reprend la structure du GPX d’origine (mêmes extensions Garmin), ' +
      'la même cadence d’enregistrement et les mêmes pauses. Les positions des portions retouchées sont ' +
      'recalculées le long du tracé d’origine pour rester cohérentes avec les nouvelles vitesses, et le ' +
      'fichier est vérifié avant téléchargement.</p>';
    $('download').style.display = 'none';
    $('modal').hidden = false;
    var restore = function () { $('download').style.display = ''; $('modalClose').removeEventListener('click', restore); };
    $('modalClose').addEventListener('click', restore);
  }

  wire();
})();
