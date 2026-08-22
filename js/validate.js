/* Structural validation of a generated GPX against the GPX 1.1 content model
 * plus the practical expectations of the Strava importer.
 */
(function (global) {
  'use strict';
  var X = global.XMLLite;

  var GPX_NS = 'http://www.topografix.com/GPX/1/1';
  var TRKPT_ORDER = ['ele', 'time', 'magvar', 'geoidheight', 'name', 'cmt', 'desc', 'src', 'link',
    'sym', 'type', 'fix', 'sat', 'hdop', 'vdop', 'pdop', 'ageofdgpsdata', 'dgpsid', 'extensions'];
  var TRK_ORDER = ['name', 'cmt', 'desc', 'src', 'link', 'number', 'type', 'extensions', 'trkseg'];
  var GPX_ORDER = ['metadata', 'wpt', 'rte', 'trk', 'extensions'];
  var DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[-+]\d{2}:\d{2})$/;

  function checkOrder(node, order, label, errors) {
    var last = -1;
    var kids = X.children(node);
    for (var i = 0; i < kids.length; i++) {
      var ln = X.localName(kids[i].name);
      var idx = order.indexOf(ln);
      if (idx < 0) continue;               // foreign / extension elements are ignored
      if (idx < last) {
        errors.push(label + ' : <' + ln + '> apparaît après <' + order[last] + '> (ordre imposé par le schéma GPX 1.1).');
        return;
      }
      last = idx;
    }
  }

  function validate(text) {
    var errors = [], warnings = [], info = {};
    var root;
    try { root = X.parse(text); } catch (e) { return { ok: false, errors: ['XML illisible : ' + e.message], warnings: [], info: info }; }
    if (!root || X.localName(root.name) !== 'gpx') return { ok: false, errors: ['Élément racine <gpx> absent.'], warnings: warnings, info: info };

    if (X.attr(root, 'version') !== '1.1') errors.push('L\'attribut version de <gpx> doit valoir "1.1".');
    if (!X.attr(root, 'creator')) errors.push('L\'attribut creator de <gpx> est obligatoire.');
    if (X.attr(root, 'xmlns') !== GPX_NS) errors.push('L\'espace de noms par défaut doit être ' + GPX_NS + '.');

    // every prefix used must be declared on the root
    var declared = {};
    for (var a = 0; a < root.attrs.length; a++) {
      var an = root.attrs[a].name;
      if (an.indexOf('xmlns:') === 0) declared[an.slice(6)] = true;
    }
    declared.xml = true;
    var undeclared = {};
    (function walk(node) {
      var c = node.name.indexOf(':');
      if (c > 0 && !declared[node.name.slice(0, c)]) undeclared[node.name.slice(0, c)] = true;
      for (var i = 0; i < node.children.length; i++) if (node.children[i].name !== '#text') walk(node.children[i]);
    })(root);
    for (var p in undeclared) errors.push('Préfixe d\'espace de noms non déclaré : ' + p + ':');

    checkOrder(root, GPX_ORDER, '<gpx>', errors);

    var trks = X.children(root, 'trk');
    if (!trks.length) errors.push('Aucune trace <trk> : Strava refusera le fichier.');

    var total = 0, prevMs = -Infinity, dup = 0, back = 0, badTime = 0, badCoord = 0, noTime = 0;
    var first = null, last = null, maxSpeed = 0, prevPt = null, dist = 0;

    for (var t = 0; t < trks.length; t++) {
      checkOrder(trks[t], TRK_ORDER, '<trk>', errors);
      var segs = X.children(trks[t], 'trkseg');
      for (var s = 0; s < segs.length; s++) {
        var pts = X.children(segs[s], 'trkpt');
        for (var i = 0; i < pts.length; i++) {
          var pt = pts[i];
          total++;
          if (total <= 50000) checkOrder(pt, TRKPT_ORDER, '<trkpt> #' + total, errors);
          var lat = parseFloat(X.attr(pt, 'lat')), lon = parseFloat(X.attr(pt, 'lon'));
          if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) badCoord++;
          var tn = X.child(pt, 'time');
          if (!tn) { noTime++; continue; }
          var ts = X.text(tn).trim();
          if (!DATETIME.test(ts)) { badTime++; continue; }
          var ms = Date.parse(ts);
          if (!isFinite(ms)) { badTime++; continue; }
          if (ms === prevMs) dup++;
          else if (ms < prevMs) back++;
          if (first === null) first = ms;
          last = ms;
          if (prevPt && ms > prevMs) {
            var d = haversine(prevPt[0], prevPt[1], lat, lon);
            dist += d;
            var v = d / ((ms - prevMs) / 1000) * 3.6;
            if (v > maxSpeed) maxSpeed = v;
          }
          prevMs = ms; prevPt = [lat, lon];
          var en = X.child(pt, 'ele');
          if (en && !isFinite(parseFloat(X.text(en)))) errors.push('<ele> non numérique au point ' + total + '.');
        }
      }
    }

    if (total < 2) errors.push('Moins de deux points de trace.');
    if (badCoord) errors.push(badCoord + ' point(s) avec des coordonnées invalides.');
    if (noTime) errors.push(noTime + ' point(s) sans <time> : Strava importerait le fichier comme un simple itinéraire, sans données de temps.');
    if (badTime) errors.push(badTime + ' horodatage(s) hors format ISO-8601 (xsd:dateTime).');
    if (back) errors.push(back + ' horodatage(s) en recul : la chronologie doit être strictement croissante.');
    if (dup) errors.push(dup + ' horodatage(s) dupliqué(s).');
    if (maxSpeed > 120) warnings.push('Vitesse instantanée maximale de ' + maxSpeed.toFixed(0) + ' km/h : valeur peu plausible pour du vélo.');

    info = {
      points: total,
      start: first ? new Date(first).toISOString() : null,
      end: last ? new Date(last).toISOString() : null,
      durationSec: first && last ? (last - first) / 1000 : 0,
      distanceM: dist,
      maxSpeedKmh: maxSpeed
    };
    return { ok: errors.length === 0, errors: errors, warnings: warnings, info: info };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var DEG = Math.PI / 180, R = 6371008.8;
    var dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  global.GPXValidate = { validate: validate };
})(typeof window !== 'undefined' ? window : globalThis);
