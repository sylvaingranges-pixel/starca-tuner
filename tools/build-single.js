/* Bundles the app into one portable HTML file: node tools/build-single.js */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) =>
  '<style>\n' + fs.readFileSync(path.join(root, href), 'utf8') + '\n</style>');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) =>
  '<script>\n' + fs.readFileSync(path.join(root, src), 'utf8') + '\n</script>');
html = html.replace('<title>', '<!-- Starca Tuner — fichier unique, ouvrez-le dans un navigateur. -->\n<title>');

const out = path.join(root, 'starca-tuner.html');
fs.writeFileSync(out, html);
console.log('écrit', path.relative(root, out), (html.length / 1024).toFixed(0), 'ko');
