/* Starca Tuner — interface mobile.
 * Même moteur que la version bureau (gpx / track / edit / validate / charts / map),
 * disposition et gestes adaptés à un écran de téléphone.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = UI.escapeHtml, fmtClock = UI.fmtClock, fmtDelta = UI.fmtDelta, fmtDist = UI.fmtDist;

  var S = { fileName: null, source: null, track: null, stack: null, map: null, edits: [], selection: null, pending: null };
  var filterState = {};
  var P = {                                   // paramètres de la retouche en cours
    mode: 'target', targetMin: 1, targetSec: 0, factor: 1.1, deltaKmh: 3, speedKmh: 28,
    maxSpeedKmh: 0, minSpeedKmh: 5, maxFactor: 2.5, rampSec: 15, smoothSec: 10
  };
  var O = {                                   // options globales
    align: true, power: false, hr: false, tile: 'osm', startMs: null,
    mass: 83, cda: 0.32, crr: 0.005, hrMax: 190,
    speedSmooth: 5, gradeWindow: 40, pauseGap: 10
  };
  var MAP_SIZES = [0, 28, 58];
  var mapSize = 1;

  /** Adapte la hauteur de carte et la hauteur mini des graphes à l'écran. */
  function tuneSizes() {
    var h = window.innerHeight;
    MAP_SIZES = h < 620 ? [0, 22, 50] : h < 760 ? [0, 28, 58] : [0, 32, 62];
    if (S.stack) S.stack.minRow = Math.max(40, Math.min(64, Math.round(h / 12)));
  }

  /* ------------------------------------------------------------ chargement */

  function loadText(text, name) {
    var source, track;
    try {
      source = GPX.parse(text);
      track = Track.build(source, { speedSmooth: O.speedSmooth, gradeWindow: O.gradeWindow, pauseGap: O.pauseGap });
    } catch (e) {
      alert('Lecture impossible : ' + e.message);
      return;
    }
    S.fileName = name; S.source = source; S.track = track;
    S.edits = []; S.selection = null; S.pending = null;
    O.startMs = track.t0Ms;
    $('empty').hidden = true;
    $('tabExport').disabled = false;

    if (!S.stack) {
      S.stack = new ChartStack($('charts'), {
        footer: $('chartFooter'), touch: true, compactHead: true, gutter: 42, minRowHeight: 56,
        onView: function (v) { S.map.setView(v.i0, v.i1); },
        onSelect: onSelect,
        onHover: function (i) { S.map.setHover(i); }
      });
    }
    tuneSizes();
    S.stack.setTrack(track);

    if (!S.map) {
      S.map = new TrackMap($('map'), {
        onSelect: function (a, b) { S.stack.setSelectionIndices(a, b); },
        onHover: function (i) { S.stack.setHoverIndex(i); }
      });
      S.map.setSource(O.tile);
    }
    S.map.setTrack(track);
    S.map.setView(0, track.n - 1);

    // Écran étroit : on n'affiche d'emblée que trois séries — le profil
    // d'altitude reste visible dans la bande du bas, et l'onglet « Graphes »
    // permet d'afficher tout le reste.
    var keep = { speed: 1, grade: 1 };
    var extra = track.channels.filter(function (c) { return /power|watts/i.test(c.extKey || ''); })[0] ||
      track.channels.filter(function (c) { return /hr|heartrate/i.test(c.extKey || ''); })[0];
    if (extra) keep[extra.key] = 1; else keep.ele = 1;
    track.channels.forEach(function (c) {
      if (c.visible === false) return;
      S.stack.setRowConfig(c.key, { visible: !!keep[c.key] });
    });

    renderHeader();
    updateSelectionUI();
    updateOverlay();
  }

  function renderHeader() {
    var st = S.track.stats;
    $('title').textContent = S.source.name;
    $('sub').textContent = new Date(st.startMs).toLocaleDateString('fr-FR') + ' · ' +
      fmtDist(st.distance) + ' · ' + fmtClock(st.duration) + ' · D+ ' + Math.round(st.elevGain) + ' m · ' +
      st.avgMovingKmh.toFixed(1) + ' km/h';
  }

  /* ------------------------------------------------------------- sélection */

  function onSelect(sel) {
    S.selection = sel;
    if (sel) S.map.setSelection(sel.i0, sel.i1); else S.map.setSelection(null);
    updateSelectionUI();
    if ($('sheet').dataset.kind === 'edit') renderSheet('edit');
    else updateOverlay();
  }

  function updateSelectionUI() {
    var has = !!S.selection;
    $('zoomSel').disabled = !has;
    $('clearSel').disabled = !has;
    $('mapFitSel').disabled = !has;
    if (!has) { $('tabEditSub').textContent = 'aucune sélection'; return; }
    var st = UI.segStats(S.track, S.selection.i0, S.selection.i1);
    $('tabEditSub').textContent = fmtDist(st.dist) + ' · ' + fmtClock(st.dur);
  }

  function updateOverlay() {
    if (!S.track || !S.stack) return;
    var list = S.edits.slice();
    if (S.pending) list.push(S.pending);
    var ov = UI.overlays(S.track, list, {
      power: O.power, hr: O.hr, mass: O.mass, cda: O.cda, crr: O.crr, hrMax: O.hrMax
    });
    S.stack.setOverlays(ov.data);

    var applied = Edits.composeFactors(S.track, S.edits);
    var saved = Edits.savedTime(S.track, applied.factor, 0, applied.factor.length);
    $('gain').textContent = saved ? fmtDelta(saved) : '';
    $('tabOptsSub').textContent = S.edits.length + ' modif.';
    var expSub = $('tabExport').querySelector('span');
    if (expSub) expSub.textContent = saved ? '→ ' + fmtClock(S.track.stats.duration - saved) : 'GPX';
  }

  /* --------------------------------------------------------------- feuille */

  function openSheet(kind) {
    $('sheet').dataset.kind = kind;
    renderSheet(kind);
    $('sheet').hidden = false;
    $('scrim').hidden = false;
  }
  function closeSheet() {
    $('sheet').hidden = true;
    $('scrim').hidden = true;
    $('sheet').dataset.kind = '';
    if (S.pending) { S.pending = null; updateOverlay(); }
  }

  function renderSheet(kind) {
    var body = $('sheetBody');
    if (kind === 'channels') { $('sheetTitle').textContent = 'Graphes affichés'; body.innerHTML = ''; body.appendChild(channelsPanel()); }
    else if (kind === 'edit') { $('sheetTitle').textContent = 'Retoucher le tronçon'; body.innerHTML = ''; body.appendChild(editPanel()); }
    else if (kind === 'opts') { $('sheetTitle').textContent = 'Modifications et réglages'; body.innerHTML = ''; body.appendChild(optsPanel()); }
    else if (kind === 'export') { $('sheetTitle').textContent = 'Exporter'; body.innerHTML = ''; body.appendChild(exportPanel()); }
    else if (kind === 'help') { $('sheetTitle').textContent = 'Mode d’emploi'; body.innerHTML = helpHtml(); }
    body.scrollTop = 0;
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ------------------------------------------------- feuille « Graphes »  */

  function channelsPanel() {
    var box = el('div');
    if (!S.track) { box.appendChild(el('p', 'dim', 'Ouvrez d’abord un fichier.')); return box; }
    box.appendChild(el('p', 'dim', 'Cochez les séries à afficher. Décochez « auto » pour figer l’axe Y entre deux valeurs.'));
    S.stack.getRows().forEach(function (r) {
      var row = el('div', 'crow');
      row.innerHTML =
        '<input type="checkbox" ' + (r.visible ? 'checked' : '') + '>' +
        '<span class="cname"><span class="cdot" style="background:' + r.color + '"></span>' +
        esc(r.label) + (r.unit ? ' <span class="u">' + esc(r.unit) + '</span>' : '') + '</span>' +
        '<label class="u"><input type="checkbox" class="auto" ' + (r.yMode === 'auto' ? 'checked' : '') + '> auto</label>' +
        '<input type="number" class="mn" inputmode="decimal" placeholder="min" ' + (r.yMode === 'auto' ? 'disabled' : '') + ' value="' + (r.yMin == null ? '' : r.yMin) + '">' +
        '<input type="number" class="mx" inputmode="decimal" placeholder="max" ' + (r.yMode === 'auto' ? 'disabled' : '') + ' value="' + (r.yMax == null ? '' : r.yMax) + '">';
      var vis = row.querySelector('input[type=checkbox]');
      var auto = row.querySelector('.auto');
      var mn = row.querySelector('.mn'), mx = row.querySelector('.mx');
      vis.addEventListener('change', function () { S.stack.setRowConfig(r.key, { visible: vis.checked }); });
      auto.addEventListener('change', function () {
        mn.disabled = mx.disabled = auto.checked;
        if (!auto.checked) {
          var rng = S.stack.autoRange(r.key);
          if (mn.value === '') mn.value = rng[0].toFixed(r.decimals);
          if (mx.value === '') mx.value = rng[1].toFixed(r.decimals);
        }
        S.stack.setRowConfig(r.key, {
          yMode: auto.checked ? 'auto' : 'fixed',
          yMin: mn.value === '' ? null : parseFloat(mn.value),
          yMax: mx.value === '' ? null : parseFloat(mx.value)
        });
      });
      function onY() {
        S.stack.setRowConfig(r.key, {
          yMode: 'fixed',
          yMin: mn.value === '' ? null : parseFloat(mn.value),
          yMax: mx.value === '' ? null : parseFloat(mx.value)
        });
      }
      mn.addEventListener('input', onY);
      mx.addEventListener('input', onY);
      box.appendChild(row);
    });
    return box;
  }

  /* ------------------------------------------------ feuille « Retoucher » */

  function filterableChannels() {
    return S.track.channels.filter(function (c) { return c.filterable !== false; });
  }

  function readEdit() {
    if (!S.selection) return null;
    var e = Edits.defaultEdit(S.track, S.selection.i0, S.selection.i1);
    e.mode = P.mode;
    e.targetSec = P.targetMin * 60 + P.targetSec;
    e.factor = P.factor; e.deltaKmh = P.deltaKmh; e.speedKmh = P.speedKmh;
    e.maxSpeedKmh = P.maxSpeedKmh; e.minSpeedKmh = P.minSpeedKmh; e.maxFactor = P.maxFactor;
    e.rampSec = P.rampSec; e.smoothSec = P.smoothSec;
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

  function editPanel() {
    var box = el('div');
    if (!S.track) { box.appendChild(el('p', 'dim', 'Ouvrez d’abord un fichier.')); return box; }
    if (!S.selection) {
      box.appendChild(el('p', 'dim',
        'Aucun tronçon sélectionné. Glissez un doigt sur un graphe, ou activez « Sélection » sur la carte et suivez le tracé.'));
      var all = el('button', 'btn wide', 'Sélectionner tout le parcours');
      all.addEventListener('click', function () { S.stack.setSelectionIndices(0, S.track.n - 1); renderSheet('edit'); });
      box.appendChild(all);
      return box;
    }

    var st = UI.segStats(S.track, S.selection.i0, S.selection.i1);
    var t = S.track;
    box.appendChild(el('div', 'kv',
      '<span>Départ</span><b>' + fmtClock(t.t[st.i0]) + ' · ' + fmtDist(t.dist[st.i0]) + '</b>' +
      '<span>Arrivée</span><b>' + fmtClock(t.t[st.i1]) + ' · ' + fmtDist(t.dist[st.i1]) + '</b>' +
      '<span>Durée</span><b>' + fmtClock(st.dur) + '</b>' +
      '<span>Distance</span><b>' + fmtDist(st.dist) + '</b>' +
      '<span>Vitesse moy.</span><b>' + st.avg.toFixed(1) + ' km/h</b>' +
      '<span>Dénivelé +</span><b>' + Math.round(st.gain) + ' m</b>' +
      '<span>Pente moy.</span><b>' + st.grade.toFixed(2) + ' °</b>'));

    box.appendChild(el('h3', null, 'Consigne'));
    var modeSel = el('select', 'sel',
      '<option value="target">Gagner un temps donné</option>' +
      '<option value="factor">Multiplier la vitesse</option>' +
      '<option value="delta">Ajouter des km/h</option>' +
      '<option value="speed">Viser une vitesse minimale</option>');
    modeSel.value = P.mode;
    modeSel.addEventListener('change', function () { P.mode = modeSel.value; renderSheet('edit'); });
    box.appendChild(modeSel);

    if (P.mode === 'target') {
      box.appendChild(numField('Temps à gagner', P.targetMin, 'min', function (v) { P.targetMin = v; }, 0, 1,
        P.targetSec, 's', function (v) { P.targetSec = v; }));
    } else if (P.mode === 'factor') {
      box.appendChild(numField('Facteur de vitesse', P.factor, '×', function (v) { P.factor = v; }, 0.3, 0.01));
    } else if (P.mode === 'delta') {
      box.appendChild(numField('Supplément', P.deltaKmh, 'km/h', function (v) { P.deltaKmh = v; }, -30, 0.5));
    } else {
      box.appendChild(numField('Vitesse visée', P.speedKmh, 'km/h', function (v) { P.speedKmh = v; }, 0, 0.5));
    }

    box.appendChild(el('h3', null, 'Filtres — quels points accélérer ?'));
    filterableChannels().forEach(function (ch) {
      var fs = filterState[ch.key] || (filterState[ch.key] = { on: false, min: '', max: '' });
      var rmin = Infinity, rmax = -Infinity;
      for (var i = S.selection.i0; i <= S.selection.i1; i++) {
        var v = ch.data[i];
        if (!isFinite(v)) continue;
        if (v < rmin) rmin = v;
        if (v > rmax) rmax = v;
      }
      var row = el('div', 'frow',
        '<input type="checkbox" ' + (fs.on ? 'checked' : '') + '>' +
        '<span class="fname"><span class="fdot" style="background:' + ch.color + '"></span>' +
        '<span class="fnamet">' + esc(ch.label) + (ch.unit ? ' <span class="u">' + esc(ch.unit) + '</span>' : '') +
        '<br><span class="frange">' + (isFinite(rmin) ? rmin.toFixed(ch.decimals) + ' … ' + rmax.toFixed(ch.decimals) : '—') + '</span></span></span>' +
        '<input type="number" inputmode="decimal" placeholder="min" value="' + fs.min + '" ' + (fs.on ? '' : 'disabled') + '>' +
        '<input type="number" inputmode="decimal" placeholder="max" value="' + fs.max + '" ' + (fs.on ? '' : 'disabled') + '>');
      var cb = row.querySelector('input[type=checkbox]');
      var nums = row.querySelectorAll('input[type=number]');
      cb.addEventListener('change', function () {
        fs.on = cb.checked;
        nums[0].disabled = nums[1].disabled = !fs.on;
        refreshPreview();
      });
      nums[0].addEventListener('input', function () { fs.min = nums[0].value; refreshPreview(); });
      nums[1].addEventListener('input', function () { fs.max = nums[1].value; refreshPreview(); });
      box.appendChild(row);
    });

    var adv = el('details', null, '<summary class="dim">Réglages fins</summary>');
    adv.appendChild(numField('Vitesse à ne pas dépasser', P.maxSpeedKmh, 'km/h', function (v) { P.maxSpeedKmh = v; }, 0, 1));
    adv.appendChild(numField('Ne rien toucher sous', P.minSpeedKmh, 'km/h', function (v) { P.minSpeedKmh = v; }, 0, 1));
    adv.appendChild(numField('Facteur maximal', P.maxFactor, '×', function (v) { P.maxFactor = v; }, 1, 0.1));
    adv.appendChild(numField('Transition aux bords', P.rampSec, 's', function (v) { P.rampSec = v; }, 0, 1));
    adv.appendChild(numField('Lissage du facteur', P.smoothSec, 's', function (v) { P.smoothSec = v; }, 0, 1));
    box.appendChild(adv);

    var prev = el('div', 'preview');
    prev.id = 'previewBox';
    box.appendChild(prev);

    var apply = el('button', 'btn accent', 'Appliquer au tronçon');
    apply.addEventListener('click', function () {
      var e = readEdit();
      var r = Edits.resolveEdit(S.track, e);
      if (!r.count) { alert('Aucun point ne correspond aux filtres : rien à appliquer.'); return; }
      e.label = UI.describeFilters(e);
      S.edits.push(e);
      S.pending = null;
      S.stack.setSelection(null);
      updateOverlay();
      closeSheet();
    });
    box.appendChild(apply);

    setTimeout(refreshPreview, 0);
    return box;
  }

  function numField(label, value, unit, onChange, min, step, value2, unit2, onChange2) {
    var f = el('div', 'field');
    f.appendChild(el('label', null, label));
    var val = el('div', 'val');
    var inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'num'; inp.inputMode = 'decimal';
    inp.value = value; if (min != null) inp.min = min; if (step) inp.step = step;
    inp.addEventListener('input', function () { onChange(parseFloat(inp.value) || 0); refreshPreview(); });
    val.appendChild(inp);
    val.appendChild(el('span', 'u', unit));
    if (value2 != null) {
      var inp2 = document.createElement('input');
      inp2.type = 'number'; inp2.className = 'num'; inp2.inputMode = 'decimal';
      inp2.value = value2; inp2.min = 0; inp2.step = 1;
      inp2.addEventListener('input', function () { onChange2(parseFloat(inp2.value) || 0); refreshPreview(); });
      val.appendChild(inp2);
      val.appendChild(el('span', 'u', unit2));
    }
    f.appendChild(val);
    return f;
  }

  function refreshPreview() {
    var box = $('previewBox');
    if (!box || !S.selection) return;
    S.pending = readEdit();
    var p = UI.previewEdit(S.track, S.pending);
    if (!p.count) {
      box.innerHTML = '<span class="warn">Aucun point ne correspond aux filtres sur ce tronçon.</span>';
    } else {
      box.innerHTML =
        'Points retouchés : <b>' + p.count + '</b> (' + Math.round(p.share * 100) + ' % de la durée)<br>' +
        'Facteur moyen <b>×' + p.avgFactor.toFixed(3) + '</b> · pointe à <b>' + p.maxKmh.toFixed(1) + ' km/h</b><br>' +
        'Gain : <b>' + fmtDelta(p.saved) + '</b> (' + fmtClock(p.segDur) + ' → ' + fmtClock(p.segDur - p.saved) + ')' +
        (p.warn ? '<br><span class="warn">' + esc(p.warn) + '</span>' : '');
    }
    updateOverlay();
  }

  /* ------------------------------------------------- feuille « Réglages » */

  function optsPanel() {
    var box = el('div');
    box.appendChild(el('h3', null, 'Modifications appliquées'));
    if (!S.edits.length) box.appendChild(el('p', 'dim', 'Aucune modification pour l’instant.'));
    else {
      var comp = Edits.composeFactors(S.track, S.edits);
      S.edits.forEach(function (e, idx) {
        var info = comp.perEdit[idx];
        var row = el('div', 'erow' + (e.enabled ? '' : ' off'),
          '<div class="etxt"><div>' + (idx + 1) + '. ' + fmtDist(S.track.dist[e.i0]) + ' → ' + fmtDist(S.track.dist[e.i1]) +
          ' <b>' + (e.enabled ? fmtDelta(info.saved || 0) : '—') + '</b></div>' +
          '<div class="esub">' + esc(e.label || UI.describeFilters(e)) + '</div></div>' +
          '<button title="Voir">◎</button><button title="Activer">' + (e.enabled ? '👁' : '🚫') + '</button><button title="Supprimer">🗑</button>');
        var b = row.querySelectorAll('button');
        b[0].addEventListener('click', function () {
          S.stack.setSelectionIndices(e.i0, e.i1);
          S.stack.zoomToSelection();
          S.map.fitBounds(S.map.boundsOf(e.i0, e.i1));
          closeSheet();
        });
        b[1].addEventListener('click', function () { e.enabled = !e.enabled; updateOverlay(); renderSheet('opts'); });
        b[2].addEventListener('click', function () { S.edits.splice(idx, 1); updateOverlay(); renderSheet('opts'); });
        box.appendChild(row);
      });
    }

    box.appendChild(el('h3', null, 'Export'));
    box.appendChild(check('Caler le gain sur la seconde entière', O.align, function (v) { O.align = v; }));
    box.appendChild(check('Recalculer la puissance', O.power, function (v) { O.power = v; }));
    box.appendChild(check('Recalculer la fréquence cardiaque', O.hr, function (v) { O.hr = v; }));

    var phys = el('details', null, '<summary class="dim">Modèle physique</summary>');
    phys.appendChild(numField('Masse totale', O.mass, 'kg', function (v) { O.mass = v; }, 20, 1));
    phys.appendChild(numField('SCx (CdA)', O.cda, 'm²', function (v) { O.cda = v; }, 0.1, 0.01));
    phys.appendChild(numField('Crr', O.crr, '', function (v) { O.crr = v; }, 0.001, 0.001));
    phys.appendChild(numField('FC maximale', O.hrMax, 'bpm', function (v) { O.hrMax = v; }, 100, 1));
    box.appendChild(phys);

    box.appendChild(el('h3', null, 'Date de la sortie'));
    var df = el('div', 'field');
    df.appendChild(el('label', null, 'Départ'));
    var dv = el('div', 'val');
    var dinp = document.createElement('input');
    dinp.type = 'datetime-local'; dinp.step = '1'; dinp.className = 'num datetime';
    dinp.value = UI.toLocalInput(O.startMs || S.track.t0Ms);
    var dnote = el('div', 'dim', '');
    function refreshDate() {
      var ms = UI.fromLocalInput(dinp.value);
      if (isFinite(ms)) O.startMs = ms;
      dnote.textContent = UI.describeShift((O.startMs || S.track.t0Ms) - S.track.t0Ms);
    }
    dinp.addEventListener('input', refreshDate);
    dv.appendChild(dinp);
    df.appendChild(dv);
    box.appendChild(df);
    var dreset = el('button', 'btn wide', 'Revenir à la date d’origine');
    dreset.addEventListener('click', function () {
      O.startMs = S.track.t0Ms;
      dinp.value = UI.toLocalInput(O.startMs);
      refreshDate();
    });
    box.appendChild(dreset);
    box.appendChild(dnote);
    box.appendChild(el('p', 'dim',
      'Strava refuse une activité dont la date de départ existe déjà : décalez-la pour importer ' +
      'la version retouchée à côté de l’originale.'));
    refreshDate();

    box.appendChild(el('h3', null, 'Carte'));
    var f = el('div', 'field');
    f.appendChild(el('label', null, 'Fond de carte'));
    var tsel = el('select', 'sel');
    var srcs = S.map ? S.map.sources() : {};
    Object.keys(srcs).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = srcs[k].name;
      if (k === O.tile) o.selected = true;
      tsel.appendChild(o);
    });
    tsel.addEventListener('change', function () { O.tile = tsel.value; if (S.map) S.map.setSource(O.tile); });
    f.appendChild(tsel);
    box.appendChild(f);

    box.appendChild(el('h3', null, 'Analyse'));
    box.appendChild(numField('Lissage vitesse', O.speedSmooth, 's', function (v) { O.speedSmooth = v; rebuildTrack(); }, 1, 1));
    box.appendChild(numField('Base de calcul de la pente', O.gradeWindow, 'm', function (v) { O.gradeWindow = v; rebuildTrack(); }, 5, 5));
    box.appendChild(numField('Seuil de pause', O.pauseGap, 's', function (v) { O.pauseGap = v; rebuildTrack(); }, 2, 1));
    return box;
  }

  function check(label, value, onChange) {
    var l = el('label', 'chk');
    var i = document.createElement('input');
    i.type = 'checkbox'; i.checked = value;
    i.addEventListener('change', function () { onChange(i.checked); updateOverlay(); });
    l.appendChild(i);
    l.appendChild(document.createTextNode(label));
    return l;
  }

  var rebuildTimer = null;
  function rebuildTrack() {
    if (!S.source) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () {
      var sel = S.selection, view = S.stack.viewIndices(), xmode = S.stack.xMode, edits = S.edits;
      var rows = S.stack.getRows();
      S.track = Track.build(S.source, { speedSmooth: O.speedSmooth, gradeWindow: O.gradeWindow, pauseGap: O.pauseGap });
      S.stack.setTrack(S.track);
      S.stack.xMode = xmode;
      S.map.setTrack(S.track);
      S.edits = edits;
      rows.forEach(function (r) { S.stack.setRowConfig(r.key, { visible: r.visible, yMode: r.yMode, yMin: r.yMin, yMax: r.yMax }); });
      S.stack.setView([S.stack.xArray()[view.i0], S.stack.xArray()[view.i1]]);
      if (sel) S.stack.setSelectionIndices(sel.i0, sel.i1);
      updateOverlay();
    }, 250);
  }

  /* -------------------------------------------------- feuille « Exporter » */

  function exportPanel() {
    var box = el('div');
    var out = UI.buildExport(S.track, S.source, S.edits, {
      startMs: O.startMs,
      align: O.align,
      adjust: { power: O.power, hr: O.hr, mass: O.mass, cda: O.cda, crr: O.crr, hrMax: O.hrMax }
    }, S.fileName);
    var t = S.track, c = out.check, r = out.res;

    box.appendChild(el('div', null, '<b>' + esc(out.name) + '</b>'));
    box.appendChild(el('table', 'rep',
      tr('Durée', fmtClock(r.stats.oldDuration) + ' → <b>' + fmtClock(r.stats.newDuration) + '</b>') +
      tr('Gain', '<b>' + fmtDelta(r.stats.savedSec) + '</b>') +
      tr('Distance', fmtDist(c.info.distanceM)) +
      tr('Vitesse moyenne', (t.stats.distance / t.stats.duration * 3.6).toFixed(2) + ' → <b>' +
        (t.stats.distance / r.stats.newDuration * 3.6).toFixed(2) + ' km/h</b>') +
      tr('Points', t.n + ' → ' + r.stats.pointsOut) +
      tr('Début', new Date(c.info.start).toLocaleString('fr-FR')) +
      tr('Fin', new Date(c.info.end).toLocaleString('fr-FR'))));

    box.appendChild(el('p', c.ok ? 'ok' : 'err', c.ok
      ? '✓ Conforme au schéma GPX 1.1 — prêt pour l’import Strava.'
      : '✗ Problèmes : <ul class="msgs"><li>' + c.errors.map(esc).join('</li><li>') + '</li></ul>'));
    if (c.warnings.length) box.appendChild(el('p', 'warn', c.warnings.map(esc).join('<br>')));
    if (!S.edits.length) box.appendChild(el('p', 'warn', 'Aucune modification appliquée : le fichier est identique à l’original.'));

    var blob = new Blob([out.text], { type: 'application/gpx+xml' });
    var url = URL.createObjectURL(blob);
    var a = el('a', 'btn accent', 'Télécharger le GPX');
    a.href = url; a.download = out.name;
    a.style.display = 'block'; a.style.textAlign = 'center'; a.style.textDecoration = 'none';
    box.appendChild(a);

    try {
      var file = new File([out.text], out.name, { type: 'application/gpx+xml' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        var share = el('button', 'btn wide', 'Partager / enregistrer dans Fichiers');
        share.style.marginTop = '8px';
        share.addEventListener('click', function () {
          navigator.share({ files: [file], title: out.name }).catch(function () {});
        });
        box.appendChild(share);
      }
    } catch (e) { /* File() indisponible : le téléchargement suffit */ }

    box.appendChild(el('p', 'dim',
      'Import : ouvrez strava.com/upload et choisissez le fichier. Strava refuse un doublon : ' +
      'supprimez d’abord l’activité d’origine.'));
    return box;
  }

  function tr(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }

  function helpHtml() {
    return '<h3>Graphes</h3><ul class="msgs">' +
      '<li><b>un doigt</b> : sélectionner un tronçon</li>' +
      '<li><b>deux doigts</b> : zoomer et se déplacer — tous les graphes restent synchronisés</li>' +
      '<li><b>double-tap</b> : revenir à la vue complète</li>' +
      '<li>la bande du bas montre le profil complet et la position de la vue ; faites-la glisser pour vous déplacer</li>' +
      '<li>onglet <b>Graphes</b> : choisir les séries affichées et figer un axe Y entre deux valeurs</li></ul>' +
      '<h3>Carte</h3><ul class="msgs">' +
      '<li>la portion visible dans les graphes est en bleu vif, la sélection en orange</li>' +
      '<li><b>Sélection</b> : glissez le long du tracé pour choisir un tronçon</li>' +
      '<li>deux doigts pour zoomer ; la poignée sous la carte règle sa hauteur</li></ul>' +
      '<h3>Retouche</h3><ul class="msgs">' +
      '<li>choisissez la consigne, puis les filtres : seuls les points correspondants sont accélérés</li>' +
      '<li>les modifications s’empilent ; on peut en enchaîner sur plusieurs tronçons</li>' +
      '<li>la courbe orange sur le graphe de vitesse montre le résultat</li></ul>' +
      '<h3>Export</h3><p class="dim">Même structure que le fichier d’entrée, mêmes horodatages avant la première ' +
      'retouche, positions recalculées le long du tracé d’origine, vérification GPX 1.1 avant téléchargement.</p>';
  }

  /* ------------------------------------------------------------ câblage UI */

  function readFile(f) {
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { loadText(String(fr.result), f.name); };
    fr.readAsText(f);
  }

  function splitLandscape() {
    return window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches;
  }

  function applyMapSize() {
    var pct = MAP_SIZES[mapSize];
    if (splitLandscape()) {
      // en paysage la carte occupe une colonne : la grille CSS s'en charge
      $('mapwrap').style.height = '';
      $('mapwrap').hidden = false;
      if (S.map) S.map.resize();
      if (S.stack) S.stack.resize();
      return;
    }
    $('mapwrap').style.height = pct + '%';
    $('mapwrap').hidden = pct === 0;
    $('grabber').style.opacity = pct === 0 ? 0.5 : 1;
    if (S.map) S.map.resize();
    if (S.stack) S.stack.resize();
  }

  function wire() {
    $('file').addEventListener('change', function (ev) { readFile(ev.target.files[0]); });

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
    $('mapFitView').addEventListener('click', function () { var v = S.stack.viewIndices(); S.map.fitBounds(S.map.boundsOf(v.i0, v.i1)); });
    $('mapFitSel').addEventListener('click', function () { if (S.selection) S.map.fitBounds(S.map.boundsOf(S.selection.i0, S.selection.i1)); });
    $('mapSelect').addEventListener('click', function () {
      S.map.selectMode = !S.map.selectMode;
      this.classList.toggle('on', S.map.selectMode);
    });

    document.querySelectorAll('.tab[data-sheet]').forEach(function (b) {
      b.addEventListener('click', function () { openSheet(b.dataset.sheet); });
    });
    $('tabExport').addEventListener('click', function () { openSheet('export'); });
    $('btnHelp').addEventListener('click', function () { openSheet('help'); });
    $('sheetClose').addEventListener('click', closeSheet);
    $('scrim').addEventListener('click', closeSheet);

    // poignée de redimensionnement de la carte (glisser) + tap pour changer de taille
    var g = $('grabber'), dragY = null, movedY = false;
    g.addEventListener('pointerdown', function (ev) {
      try { g.setPointerCapture(ev.pointerId); } catch (e) { /* pointeur synthétique */ }
      dragY = { y: ev.clientY, h: $('mapwrap').getBoundingClientRect().height };
      movedY = false;
    });
    g.addEventListener('pointermove', function (ev) {
      if (!dragY || splitLandscape()) return;
      var dy = ev.clientY - dragY.y;
      if (Math.abs(dy) > 3) movedY = true;
      var h = Math.max(0, Math.min(window.innerHeight * 0.75, dragY.h + dy));
      $('mapwrap').style.height = h + 'px';
      $('mapwrap').hidden = h < 8;
      if (S.map) S.map.resize();
      if (S.stack) S.stack.resize();
    });
    g.addEventListener('pointerup', function () {
      if (!movedY) { mapSize = (mapSize + 1) % MAP_SIZES.length; applyMapSize(); }
      dragY = null;
    });

    window.addEventListener('orientationchange', function () {
      setTimeout(function () { tuneSizes(); applyMapSize(); }, 300);
    });
    window.addEventListener('resize', function () {
      tuneSizes();
      if (S.stack) S.stack.resize();
      if (S.map) S.map.resize();
    });
    // empêcher le zoom double-tap du navigateur sur les zones de dessin
    document.addEventListener('dblclick', function (ev) {
      if (ev.target.tagName === 'CANVAS') ev.preventDefault();
    }, { passive: false });

    tuneSizes();
    applyMapSize();
  }

  wire();
})();
