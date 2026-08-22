/* Runs every check: engine tests on both fixtures, GPX validation, UI test.
 * node tools/test-all.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (args, label) => {
  process.stdout.write('\n=== ' + label + '\n');
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
};
const fixtures = ['sample/sample-ride.gpx', 'sample/sample-ride-strava.gpx'];
run(['tools/make-sample.js'], 'génération des exemples');
for (const f of fixtures) run(['tools/selftest.js', f], 'moteur — ' + f);
for (const f of fixtures) run(['tools/validate-gpx.js', f], 'validation — ' + f);
run(['tools/build-single.js'], 'bundle fichier unique');
for (const f of fixtures) run(['tools/uitest.js', f], 'interface bureau — ' + f);
run(['tools/uitest-mobile.js', fixtures[1]], 'interface mobile — ' + fixtures[1]);
console.log('\nTout est vert.');
