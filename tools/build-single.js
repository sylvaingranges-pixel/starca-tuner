/* Bundles each interface into one portable HTML file:
 *   index.html  -> starca-tuner.html          (bureau)
 *   mobile.html -> starca-tuner-mobile.html   (smartphone)
 * node tools/build-single.js
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

const TARGETS = [
  { src: 'index.html', out: 'starca-tuner.html', note: 'Starca Tuner (bureau)' },
  { src: 'mobile.html', out: 'starca-tuner-mobile.html', note: 'Starca Tuner (smartphone)' }
];

for (const t of TARGETS) {
  let html = fs.readFileSync(path.join(root, t.src), 'utf8');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) =>
    '<style>\n' + fs.readFileSync(path.join(root, href), 'utf8') + '\n</style>');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) =>
    '<script>\n' + fs.readFileSync(path.join(root, src), 'utf8') + '\n</script>');
  html = html.replace('<title>', `<!-- ${t.note} — fichier unique, ouvrez-le dans un navigateur. -->\n<title>`);
  fs.writeFileSync(path.join(root, t.out), html);
  console.log('écrit', t.out, (html.length / 1024).toFixed(0), 'ko');
}
