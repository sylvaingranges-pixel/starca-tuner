/* GPX reading / writing for Garmin Connect & Strava activity exports.
 * Extension fields (hr, cad, atemp, power, ...) are discovered generically so
 * any namespace found in the input is round-tripped to the output.
 */
(function (global) {
  'use strict';
  var X = global.XMLLite;

  var SKIP_LEAVES = { lat: 1, lon: 1 };

  function isLeaf(node) {
    for (var i = 0; i < node.children.length; i++) if (node.children[i].name !== '#text') return false;
    return true;
  }

  function collectLeaves(node, prefix, out) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === '#text') continue;
      var path = prefix.concat([c.name]);
      if (isLeaf(c)) out.push({ path: path, key: path.join('/'), value: X.text(c).trim() });
      else collectLeaves(c, path, out);
    }
  }

  function parseTimeMs(s) {
    if (!s) return NaN;
    var t = Date.parse(s.trim());
    return isFinite(t) ? t : NaN;
  }

  /** Parse a GPX activity file. */
  function parse(text) {
    var root = X.parse(text);
    if (!root || X.localName(root.name) !== 'gpx') throw new Error("Ce fichier n'est pas un GPX valide (élément racine <gpx> absent).");

    var trks = X.children(root, 'trk');
    if (!trks.length) throw new Error('Aucune trace <trk> trouvée dans le fichier.');
    var trk = trks[0];

    var points = [];
    var segments = [];
    var extLeafOrder = [];
    var extLeafSeen = {};
    var otherLeafOrder = [];
    var otherLeafSeen = {};
    var withMillis = 0, withoutMillis = 0;

    var segs = X.children(trk, 'trkseg');
    for (var s = 0; s < segs.length; s++) {
      var start = points.length;
      var pts = X.children(segs[s], 'trkpt');
      for (var p = 0; p < pts.length; p++) {
        var node = pts[p];
        var latS = X.attr(node, 'lat'), lonS = X.attr(node, 'lon');
        var lat = parseFloat(latS), lon = parseFloat(lonS);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        var timeS = null, eleS = null;
        var ext = {}, other = {};
        for (var k = 0; k < node.children.length; k++) {
          var c = node.children[k];
          if (c.name === '#text') continue;
          var ln = X.localName(c.name);
          if (ln === 'time') { timeS = X.text(c).trim(); continue; }
          if (ln === 'ele') { eleS = X.text(c).trim(); continue; }
          if (ln === 'extensions') {
            var leaves = [];
            collectLeaves(c, [], leaves);
            for (var l = 0; l < leaves.length; l++) {
              var lf = leaves[l];
              if (SKIP_LEAVES[X.localName(lf.path[lf.path.length - 1])]) continue;
              ext[lf.key] = lf.value;
              if (!extLeafSeen[lf.key]) { extLeafSeen[lf.key] = lf.path; extLeafOrder.push(lf.key); }
            }
            continue;
          }
          if (isLeaf(c)) {
            other[c.name] = X.text(c).trim();
            if (!otherLeafSeen[c.name]) { otherLeafSeen[c.name] = true; otherLeafOrder.push(c.name); }
          }
        }
        if (timeS) { if (/\.\d+/.test(timeS)) withMillis++; else withoutMillis++; }
        points.push({
          lat: lat, lon: lon, rawLat: latS, rawLon: lonS,
          ele: eleS === null ? NaN : parseFloat(eleS), rawEle: eleS,
          timeMs: parseTimeMs(timeS), ext: ext, other: other
        });
      }
      if (points.length > start) segments.push({ start: start, end: points.length - 1 });
    }

    if (points.length < 2) throw new Error('Le fichier contient moins de deux points de trace.');

    var noTime = points.filter(function (q) { return !isFinite(q.timeMs); }).length;
    if (noTime) throw new Error('Certains points ne portent pas d\'horodatage (' + noTime + ') : impossible de traiter cette activité.');

    // Points must be chronologically ordered for everything downstream.
    for (var i = 1; i < points.length; i++) {
      if (points[i].timeMs < points[i - 1].timeMs) {
        points.sort(function (a, b) { return a.timeMs - b.timeMs; });
        segments = [{ start: 0, end: points.length - 1 }];
        break;
      }
    }

    // Integer-valued extension channels are re-emitted as integers.
    var extMeta = {};
    for (var e = 0; e < extLeafOrder.length; e++) {
      var key = extLeafOrder[e];
      var numeric = true, integer = true, count = 0, decimals = 0;
      for (var q = 0; q < points.length; q++) {
        var v = points[q].ext[key];
        if (v === undefined || v === '') continue;
        count++;
        var f = parseFloat(v);
        if (!isFinite(f) || !/^[-+]?[0-9]*\.?[0-9]+(e[-+]?\d+)?$/i.test(v)) { numeric = false; break; }
        if (Math.abs(f - Math.round(f)) > 1e-9) integer = false;
        var dot = v.indexOf('.');
        if (dot >= 0) decimals = Math.max(decimals, v.length - dot - 1);
      }
      extMeta[key] = {
        key: key, path: extLeafSeen[key], numeric: numeric, integer: numeric && integer && decimals === 0,
        decimals: Math.min(decimals, 6), count: count,
        local: X.localName(extLeafSeen[key][extLeafSeen[key].length - 1])
      };
    }

    var trkMeta = X.children(trk).filter(function (c) { return X.localName(c.name) !== 'trkseg'; });

    return {
      declaration: root.declaration || '<?xml version="1.0" encoding="UTF-8"?>',
      rootAttrs: root.attrs.slice(),
      creator: X.attr(root, 'creator') || '',
      metadataNode: X.child(root, 'metadata'),
      trkAttrs: trk.attrs.slice(),
      trkMeta: trkMeta,
      name: X.text(X.child(trk, 'name')).trim() || 'Activité',
      type: X.text(X.child(trk, 'type')).trim(),
      points: points,
      segments: segments,
      extOrder: extLeafOrder,
      extMeta: extMeta,
      otherOrder: otherLeafOrder,
      timeMillis: withMillis >= withoutMillis
    };
  }

  function fmtTime(ms, millis) {
    var d = new Date(Math.round(ms));
    var iso = d.toISOString();               // always 'YYYY-MM-DDTHH:MM:SS.mmmZ'
    return millis ? iso : iso.replace(/\.\d{3}Z$/, 'Z');
  }

  function trimNum(v, decimals) {
    var s = v.toFixed(decimals);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  function buildExtensionsXML(point, source, indent) {
    // Rebuild the original nesting (e.g. ns3:TrackPointExtension > ns3:hr).
    var order = source.extOrder, meta = source.extMeta;
    var lines = [];
    var openStack = [];
    var emitted = false;
    var body = '';

    function closeTo(depth) {
      while (openStack.length > depth) {
        var name = openStack.pop();
        body += indent + '  ' + '  '.repeat(openStack.length) + '</' + name + '>\n';
      }
    }

    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var raw = point.ext[key];
      if (raw === undefined || raw === null || raw === '') continue;
      var m = meta[key];
      var path = m.path;
      // Open/close parent elements as the path changes.
      var common = 0;
      while (common < openStack.length && common < path.length - 1 && openStack[common] === path[common]) common++;
      closeTo(common);
      for (var d = common; d < path.length - 1; d++) {
        body += indent + '  ' + '  '.repeat(openStack.length) + '<' + path[d] + '>\n';
        openStack.push(path[d]);
      }
      var value = raw;
      if (m.numeric) {
        var f = parseFloat(raw);
        value = m.integer ? String(Math.round(f)) : f.toFixed(m.decimals || 1);
        if (!m.integer && m.decimals === 0) value = String(Math.round(f));
      }
      body += indent + '  ' + '  '.repeat(openStack.length) + '<' + path[path.length - 1] + '>' +
        X.encodeEntities(value) + '</' + path[path.length - 1] + '>\n';
      emitted = true;
    }
    closeTo(0);
    if (!emitted) return '';
    lines.push(indent + '<extensions>\n' + body + indent + '</extensions>\n');
    return lines.join('');
  }

  /** Serialize points back to a GPX document mirroring the input structure. */
  function build(source, points, options) {
    options = options || {};
    var out = [];
    out.push(source.declaration);
    out.push('\n<gpx');
    for (var a = 0; a < source.rootAttrs.length; a++) {
      out.push((a === 0 ? ' ' : '\n  ') + source.rootAttrs[a].name + '="' + X.encodeAttr(source.rootAttrs[a].value) + '"');
    }
    out.push('>\n');

    if (source.metadataNode) out.push(X.serialize(source.metadataNode, '  '));
    var trkOpen = '  <trk';
    for (var b = 0; b < source.trkAttrs.length; b++) trkOpen += ' ' + source.trkAttrs[b].name + '="' + X.encodeAttr(source.trkAttrs[b].value) + '"';
    out.push(trkOpen + '>\n');
    for (var c = 0; c < source.trkMeta.length; c++) out.push(X.serialize(source.trkMeta[c], '    '));
    out.push('    <trkseg>\n');

    var millis = source.timeMillis;
    var curSeg = points.length ? (points[0].seg || 0) : 0;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var pseg = p.seg || 0;
      if (pseg !== curSeg) { out.push('    </trkseg>\n    <trkseg>\n'); curSeg = pseg; }
      var latS = p.rawLat !== undefined && p.rawLat !== null ? p.rawLat : trimNum(p.lat, 9);
      var lonS = p.rawLon !== undefined && p.rawLon !== null ? p.rawLon : trimNum(p.lon, 9);
      out.push('      <trkpt lat="' + latS + '" lon="' + lonS + '">\n');
      if (isFinite(p.ele)) {
        out.push('        <ele>' + (p.rawEle != null ? p.rawEle : trimNum(p.ele, 2)) + '</ele>\n');
      }
      out.push('        <time>' + fmtTime(p.timeMs, millis) + '</time>\n');
      for (var o = 0; o < source.otherOrder.length; o++) {
        var on = source.otherOrder[o];
        if (p.other && p.other[on] !== undefined && p.other[on] !== '') {
          out.push('        <' + on + '>' + X.encodeEntities(p.other[on]) + '</' + on + '>\n');
        }
      }
      out.push(buildExtensionsXML(p, source, '        '));
      out.push('      </trkpt>\n');
    }

    out.push('    </trkseg>\n  </trk>\n</gpx>\n');
    return out.join('');
  }

  global.GPX = { parse: parse, build: build, fmtTime: fmtTime, trimNum: trimNum };
})(typeof window !== 'undefined' ? window : globalThis);
