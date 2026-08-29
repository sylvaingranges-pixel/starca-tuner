/* Node self-test: parse the sample GPX, apply edits, rebuild and check the output.
 * Usage: node tools/selftest.js [file.gpx]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['js/xml.js', 'js/gpx.js', 'js/track.js', 'js/edit.js', 'js/validate.js', 'js/ui-common.js']) require(path.join(root, f));

const file = process.argv[2] || path.join(root, 'sample/activity_23212011494.gpx');
const text = fs.readFileSync(file, 'utf8');
const src = GPX.parse(text);
const track = Track.build(src);
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
}

console.log('Fichier :', path.basename(file));
console.log(`  ${track.n} points, ${(track.stats.distance / 1000).toFixed(2)} km, ` +
  `${Edits.fmtDur(track.stats.duration)}, D+ ${Math.round(track.stats.elevGain)} m, ` +
  `moy ${track.stats.avgMovingKmh.toFixed(1)} km/h`);

console.log('\n[1] Rebuild sans modification');
const none = Edits.rebuild(track, Edits.composeFactors(track, []).factor, {});
check('même nombre de points', none.points.length === track.n, `${none.points.length} vs ${track.n}`);
const outNone = GPX.build(src, none.points);
const lines = s => s.split('\n');
const trkFrom = s => { const a = lines(s); const i = a.findIndex(l => l.includes('<trkpt')); return a.slice(i); };
const A = trkFrom(text), B = trkFrom(outNone);
let firstDiff = -1;
for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { firstDiff = i; break; }
check('points identiques à l\'entrée (octet près)', firstDiff === -1,
  firstDiff >= 0 ? `ligne ${firstDiff}: "${A[firstDiff]}" vs "${B[firstDiff]}"` : '');

console.log('\n[2] Edition : -3 min sur le tronçon 14–60 %, uniquement pente > 2° et vitesse < 25 km/h');
const i0 = Math.round(track.n * 0.14), i1 = Math.round(track.n * 0.60);
const edit = Edits.defaultEdit(track, i0, i1);
edit.mode = 'target';
edit.targetSec = 180;
edit.filters = [{ key: 'grade', min: 2, max: null, enabled: true }, { key: 'speed', min: null, max: 25, enabled: true }];
edit.maxSpeedKmh = 45;
const comp = Edits.composeFactors(track, [edit]);
const info = comp.perEdit[0];
console.log(`  intervalles filtrés : ${info.count}, gain calculé ${info.saved.toFixed(1)} s, k=${info.k.toFixed(3)}` +
  (info.warn ? ' | ' + info.warn : ''));
check('gain conforme à la cible', Math.abs(info.saved - 180) < 1.0, info.saved.toFixed(2) + ' s');

const res = Edits.rebuild(track, comp.factor, { align: true });
console.log(`  durée ${Edits.fmtDur(res.stats.oldDuration)} -> ${Edits.fmtDur(res.stats.newDuration)}, ` +
  `${res.stats.pointsOut} points (${res.stats.interpolated} interpolés)`);
check('gain total entier', Math.abs(res.stats.savedSec - Math.round(res.stats.savedSec)) < 1e-6, res.stats.savedSec.toFixed(6));
check('gain total ≈ 180 s', Math.abs(res.stats.savedSec - 180) < 1.5, res.stats.savedSec.toFixed(2));

// timestamps: whole-second grid, identical before the edit, shifted after it
let tsOk = true, tsBad = null;
for (let i = 0; i < i0; i++) {
  if (res.points[i].timeMs !== src.points[i].timeMs) { tsOk = false; tsBad = i; break; }
}
check('horodatages inchangés avant le tronçon', tsOk, tsBad != null ? 'index ' + tsBad : '');
let gridOk = true;
for (const p of res.points) if ((p.timeMs - track.t0Ms) % 1000 !== 0) { gridOk = false; break; }
check('horodatages sur la grille de la seconde', gridOk);
const shift = Math.round(res.stats.savedSec) * 1000;
const tailOut = res.points[res.points.length - 1].timeMs;
check('fin de sortie = fin d\'origine - gain', tailOut === src.points[src.n0 || src.points.length - 1].timeMs - shift,
  new Date(tailOut).toISOString());
let inc = true;
for (let i = 1; i < res.points.length; i++) if (res.points[i].timeMs <= res.points[i - 1].timeMs) { inc = false; break; }
check('horodatages strictement croissants', inc);

// geometry: same route length, points stay on the original polyline
let newDist = 0;
for (let i = 1; i < res.points.length; i++) {
  newDist += Track.haversine(res.points[i - 1].lat, res.points[i - 1].lon, res.points[i].lat, res.points[i].lon);
}
check('distance conservée (<0.5 %)', Math.abs(newDist - track.stats.distance) / track.stats.distance < 0.005,
  `${(newDist / 1000).toFixed(3)} km vs ${(track.stats.distance / 1000).toFixed(3)} km`);

// max deviation from the original polyline (sampled)
function distToPolyline(lat, lon) {
  let best = Infinity;
  const latRef = lat * Math.PI / 180;
  const mx = 111320 * Math.cos(latRef), my = 110540;
  for (let i = 0; i < track.n - 1; i++) {
    const ax = (track.lon[i] - lon) * mx, ay = (track.lat[i] - lat) * my;
    const bx = (track.lon[i + 1] - lon) * mx, by = (track.lat[i + 1] - lat) * my;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    const px = ax + u * dx, py = ay + u * dy;
    const d = Math.hypot(px, py);
    if (d < best) best = d;
    if (best < 0.01) break;
  }
  return best;
}
let maxDev = 0;
for (let i = 0; i < res.points.length; i += 37) maxDev = Math.max(maxDev, distToPolyline(res.points[i].lat, res.points[i].lon));
check('points sur le tracé d\'origine (<1 m)', maxDev < 1, maxDev.toFixed(3) + ' m');

// no NaN anywhere
let nan = 0;
for (const p of res.points) {
  if (!isFinite(p.lat) || !isFinite(p.lon) || (p.ele !== undefined && p.rawEle == null && !isFinite(p.ele))) nan++;
  for (const k in p.ext) if (src.extMeta[k].numeric && !isFinite(parseFloat(p.ext[k]))) nan++;
}
check('aucune valeur NaN', nan === 0, nan + ' valeurs');

// speeds stay realistic
let vmax = 0;
for (let i = 1; i < res.points.length; i++) {
  const dt = (res.points[i].timeMs - res.points[i - 1].timeMs) / 1000;
  const dd = Track.haversine(res.points[i - 1].lat, res.points[i - 1].lon, res.points[i].lat, res.points[i].lon);
  if (dt > 0) vmax = Math.max(vmax, dd / dt * 3.6);
}
check('vitesse max plausible', vmax < 100, vmax.toFixed(1) + ' km/h');

// speed outside the edited window is untouched
const outGpx = GPX.build(src, res.points);
const outFile = path.join(root, 'sample/out-test.gpx');
fs.writeFileSync(outFile, outGpx);
console.log('  écrit :', path.relative(root, outFile), (outGpx.length / 1e6).toFixed(2), 'Mo');

console.log('\n[3] Relecture du fichier généré');
const src2 = GPX.parse(outGpx);
const track2 = Track.build(src2);
check('relecture OK', track2.n === res.points.length, `${track2.n} points`);
check('même distance', Math.abs(track2.stats.distance - track.stats.distance) / track.stats.distance < 0.005,
  (track2.stats.distance / 1000).toFixed(3) + ' km');
check('canaux préservés', track2.channels.length === track.channels.length,
  track2.channels.map(c => c.label).join(', '));
console.log(`  nouvelle moyenne : ${track2.stats.avgMovingKmh.toFixed(1)} km/h (avant ${track.stats.avgMovingKmh.toFixed(1)})`);

console.log('\n[4] Edition avec augmentation de puissance/FC');
const e2 = Edits.defaultEdit(track, Math.round(track.n * 0.02), Math.round(track.n * 0.09));
e2.mode = 'factor'; e2.factor = 1.15; e2.filters = [];
const c2 = Edits.composeFactors(track, [e2]);
const r2 = Edits.rebuild(track, c2.factor, { align: true, adjust: { power: true, hr: true, hrMax: 185 } });
const hrKey = src.extOrder.find(k => src.extMeta[k].local === 'hr');
let hrBefore = 0, hrAfter = 0, cnt = 0;
for (let i = Math.round(track.n * 0.03); i < Math.round(track.n * 0.08); i++) {
  const a = parseFloat(src.points[i].ext[hrKey]), b = parseFloat(r2.points[i].ext[hrKey]);
  if (isFinite(a) && isFinite(b)) { hrBefore += a; hrAfter += b; cnt++; }
}
console.log(`  FC moyenne du tronçon : ${(hrBefore / cnt).toFixed(1)} -> ${(hrAfter / cnt).toFixed(1)} bpm`);
check('FC ajustée à la hausse', hrAfter > hrBefore);
check('gain de temps positif', r2.stats.savedSec > 0, r2.stats.savedSec.toFixed(1) + ' s');

console.log('\n[5] Aperçu « après retouche » et export : mêmes valeurs');
{
  const e = Edits.defaultEdit(track, Math.round(track.n * 0.2), Math.round(track.n * 0.5));
  e.mode = 'factor'; e.factor = 1.2; e.filters = []; e.rampSec = 0; e.smoothSec = 0;
  const adjust = { power: true, hr: true, mass: 83, cda: 0.32, crr: 0.005, hrMax: 195 };
  const ov = UI.overlays(track, [e], adjust);
  const pKey = ov.powerKey, hKey = ov.hrKey;
  if (!pKey) {
    console.log('  (fichier sans puissance : contrôle de la vitesse seule)');
    check('aperçu de vitesse produit', !!ov.data.speed);
  } else {
    const pCh = track.channels.find(c => c.key === pKey);
    let n = 0, sumBefore = 0, sumOver = 0, d0 = Infinity, d1 = -Infinity;
    for (let i = e.i0; i <= e.i1; i++) {
      const a = pCh.data[i], b = ov.data[pKey][i];
      if (!isFinite(a) || !isFinite(b)) continue;
      n++; sumBefore += a; sumOver += b;
      d0 = Math.min(d0, track.dist[i]); d1 = Math.max(d1, track.dist[i]);
    }
    check('aperçu de puissance produit', n > 0 && sumOver > sumBefore,
      `${(sumBefore / n).toFixed(0)} W -> ${(sumOver / n).toFixed(0)} W sur ${n} points`);
    check('aperçu de FC produit', !!(hKey && ov.data[hKey]));

    // la même retouche exportée doit porter la même puissance sur le même tronçon
    const out = UI.buildExport(track, src, [e], { align: true, adjust: adjust }, 'x.gpx');
    const t2 = Track.build(GPX.parse(out.text));
    const p2 = t2.channels.find(c => c.key === pKey);
    let m = 0, sumOut = 0;
    for (let i = 0; i < t2.n; i++) {
      if (t2.dist[i] < d0 || t2.dist[i] > d1) continue;
      const v = p2.data[i];
      if (!isFinite(v)) continue;
      m++; sumOut += v;
    }
    const moyOver = sumOver / n, moyOut = sumOut / m;
    check('aperçu conforme au fichier exporté (<2 %)', Math.abs(moyOut - moyOver) / moyOver < 0.02,
      `aperçu ${moyOver.toFixed(0)} W, export ${moyOut.toFixed(0)} W`);
  }
}

console.log('\n[6] Changement de la date de la sortie');
{
  const newStart = Date.UTC(2027, 2, 8, 5, 30, 0);
  const out = UI.buildExport(track, src, [], { align: true, startMs: newStart, adjust: {} }, 'x.gpx');
  check('validation OK', out.check.ok, out.check.errors.join(' | '));
  check('départ déplacé', Date.parse(out.check.info.start) === newStart, out.check.info.start);
  check('durée inchangée', Math.abs(out.check.info.durationSec - track.stats.duration) < 1.5,
    Math.round(out.check.info.durationSec) + ' s');
  const meta = /<metadata>[\s\S]*?<time>([^<]+)<\/time>/.exec(out.text);
  const origMeta = /<metadata>[\s\S]*?<time>([^<]+)<\/time>/.exec(text);
  const shift = newStart - track.t0Ms;
  check('date de <metadata> décalée d\'autant', !meta || !origMeta ||
    Date.parse(meta[1]) === Date.parse(origMeta[1]) + shift, meta && meta[1]);
  const sameDate = UI.buildExport(track, src, [], { align: true, startMs: track.t0Ms, adjust: {} }, 'x.gpx');
  check('sans décalage, fichier inchangé', sameDate.text === text.replace(/\r\n/g, '\n'));
}

console.log('\n' + (failures ? failures + ' test(s) en échec' : 'Tous les tests passent'));
process.exit(failures ? 1 : 0);
