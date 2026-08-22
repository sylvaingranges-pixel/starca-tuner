/* CLI: node tools/validate-gpx.js file.gpx */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'js/xml.js'));
require(path.join(root, 'js/validate.js'));
const file = process.argv[2];
if (!file) { console.error('usage: node tools/validate-gpx.js <file.gpx>'); process.exit(2); }
const r = GPXValidate.validate(fs.readFileSync(file, 'utf8'));
console.log(path.basename(file) + ' :', r.info.points, 'points,',
  (r.info.distanceM / 1000).toFixed(2), 'km,', Math.round(r.info.durationSec), 's,',
  'vmax', r.info.maxSpeedKmh.toFixed(1), 'km/h');
console.log('  début', r.info.start, '-> fin', r.info.end);
r.errors.forEach(e => console.log('  ERREUR  ' + e));
r.warnings.forEach(w => console.log('  ATTENTION ' + w));
console.log(r.ok ? '  => conforme GPX 1.1, importable dans Strava' : '  => NON conforme');
process.exit(r.ok ? 0 : 1);
