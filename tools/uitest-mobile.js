/* Test d'interface mobile (Playwright, viewport iPhone + événements tactiles).
 * node tools/uitest-mobile.js [fichier.gpx]
 */
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || path.join(root, '.shots');
fs.mkdirSync(shots, { recursive: true });
const sample = process.argv[2] || path.join(root, 'sample/sample-ride-strava.gpx');
const entry = process.env.ENTRY || 'mobile.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    ...devices['iPhone 13'], isMobile: true, hasTouch: true, acceptDownloads: true
  });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('file://' + path.join(root, entry));
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.querySelectorAll('.chart-row canvas').length > 2);
  await page.waitForTimeout(600);
  console.log('titre    :', (await page.textContent('#title')).trim(), '|', (await page.textContent('#sub')).trim());
  const visible = await page.$$eval('.chart-row', rs => rs.filter(r => r.style.display !== 'none').length);
  console.log('graphes visibles :', visible, 'sur', await page.$$eval('.chart-row', r => r.length));
  await page.screenshot({ path: path.join(shots, 'm1-accueil.png') });

  // --- sélection à un doigt sur le premier graphe
  const box = await page.locator('.chart-row canvas').first().boundingBox();
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(box.x + box.width / 2, y);
  await page.evaluate(async ([x0, x1, yy]) => {
    const c = document.querySelector('.chart-row canvas');
    const send = (type, x, id) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: yy, bubbles: true
    }));
    send('pointerdown', x0, 1);
    for (let i = 1; i <= 10; i++) send('pointermove', x0 + (x1 - x0) * i / 10, 1);
    send('pointerup', x1, 1);
  }, [box.x + box.width * 0.25, box.x + box.width * 0.65, y]);
  await page.waitForTimeout(300);
  console.log('sélection:', (await page.textContent('#tabEditSub')).trim());
  if (!/km/.test(await page.textContent('#tabEditSub'))) throw new Error('la sélection ne remonte pas');

  // --- pincement à deux doigts (zoom)
  const before = await page.evaluate(() => document.querySelectorAll('.chart-row canvas').length);
  await page.evaluate(async (yy) => {
    const c = document.querySelector('.chart-row canvas');
    const r = c.getBoundingClientRect();
    const send = (type, x, id) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: yy, bubbles: true
    }));
    send('pointerdown', r.left + r.width * 0.40, 1);
    send('pointerdown', r.left + r.width * 0.60, 2);
    for (let i = 1; i <= 8; i++) {
      send('pointermove', r.left + r.width * (0.40 - 0.03 * i), 1);
      send('pointermove', r.left + r.width * (0.60 + 0.03 * i), 2);
    }
    send('pointerup', r.left, 1);
    send('pointerup', r.right, 2);
  }, y);
  await page.waitForTimeout(300);
  console.log('pincement: ok (', before, 'graphes)');
  await page.screenshot({ path: path.join(shots, 'm2-selection.png') });

  // --- feuille « Retoucher » : filtre sur la pente + objectif de temps
  await page.click('#tabEdit');
  await page.waitForSelector('#sheet:not([hidden])');
  await page.waitForTimeout(200);
  for (const r of await page.$$('.frow')) {
    const txt = (await r.textContent()).trim();
    if (txt.startsWith('Pente')) {
      await r.$eval('input[type=checkbox]', c => { c.checked = true; c.dispatchEvent(new Event('change')); });
      const nums = await r.$$('input[type=number]');
      await nums[0].fill('2');
      break;
    }
  }
  await page.waitForTimeout(300);
  console.log('aperçu   :', (await page.textContent('#previewBox')).replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: path.join(shots, 'm3-retouche.png') });
  await page.click('.btn.accent');
  await page.waitForTimeout(300);
  console.log('gain     :', (await page.textContent('#gain')).trim(), '|', (await page.textContent('#tabOptsSub')).trim());

  // --- feuille « Graphes » : afficher une série de plus et figer un axe Y
  await page.click('.tab[data-sheet="channels"]');
  await page.waitForTimeout(250);
  const crows = await page.$$('.crow');
  await crows[crows.length - 1].$eval('input[type=checkbox]', c => { c.checked = true; c.dispatchEvent(new Event('change')); });
  await crows[0].$eval('.auto', c => { c.checked = false; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(250);
  const visible2 = await page.$$eval('.chart-row', rs => rs.filter(r => r.style.display !== 'none').length);
  console.log('graphes  :', visible, '->', visible2, '(axe Y du premier figé)');
  await page.screenshot({ path: path.join(shots, 'm4-graphes.png') });
  await page.click('#sheetClose');

  // --- recalcul puissance / FC : l'aperçu doit apparaître sur ces graphes
  await page.click('.tab[data-sheet="opts"]');
  await page.waitForTimeout(250);
  for (const l of await page.$$('.chk')) {
    const t = (await l.textContent()).trim();
    if (/puissance|cardiaque/i.test(t)) await l.$eval('input', i => { i.checked = true; i.dispatchEvent(new Event('change')); });
  }
  const dv = await page.$('input.datetime');
  const dBefore = dv ? await dv.inputValue() : '—';
  if (dv) await page.$eval('input.datetime', i => { i.value = '2026-12-24T08:30:00'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(250);
  await page.click('#sheetClose');
  await page.waitForTimeout(250);
  const marks = await page.$$eval('.chart-row', rs => rs
    .map(r => [r.querySelector('.lbl').textContent, r.querySelector('.ovl').textContent])
    .filter(x => x[1]).map(x => x[0]).join(', '));
  console.log('aperçus  :', marks || '(aucun)');
  console.log('date     :', dBefore, '-> 2026-12-24T08:30:00');

  // --- carte : sélection le long du tracé
  await page.click('#mapSelect');
  const mb = await page.locator('#map').boundingBox();
  await page.evaluate(([x0, y0, x1, y1]) => {
    const c = document.getElementById('map');
    const send = (type, x, yy) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: yy, bubbles: true
    }));
    send('pointerdown', x0, y0);
    for (let i = 1; i <= 10; i++) send('pointermove', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10);
    send('pointerup', x1, y1);
  }, [mb.x + mb.width * 0.45, mb.y + mb.height * 0.45, mb.x + mb.width * 0.6, mb.y + mb.height * 0.6]);
  await page.waitForTimeout(300);
  console.log('sél carte:', (await page.textContent('#tabEditSub')).trim());
  await page.screenshot({ path: path.join(shots, 'm5-carte.png') });

  // --- poignée de la carte : changement de taille
  await page.click('#grabber');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, 'm6-carte-grande.png') });

  // --- export
  await page.click('#tabExport');
  await page.waitForSelector('#sheet:not([hidden])');
  await page.waitForTimeout(400);
  const rep = (await page.textContent('#sheetBody')).replace(/\s+/g, ' ').trim();
  console.log('export   :', rep.slice(0, 300));
  await page.screenshot({ path: path.join(shots, 'm7-export.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a.btn.accent')]);
  const out = path.join(shots, 'mobile-' + dl.suggestedFilename());
  await dl.saveAs(out);
  console.log('téléchargé :', path.basename(out), fs.statSync(out).size, 'octets');

  await browser.close();
  if (errors.length) { console.log('\nERREURS :\n' + errors.join('\n')); process.exit(1); }
  console.log('\nAucune erreur console.');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
