/* Headless UI smoke test (Playwright + Chromium).  node tools/uitest.js */
const path = require('path');
const fs = require('fs');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || path.join(root, '.shots');
fs.mkdirSync(shots, { recursive: true });
const sample = process.argv[2] || path.join(root, 'sample/sample-ride.gpx');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 940 }, acceptDownloads: true });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  const entry = process.env.ENTRY || 'index.html';
  await page.goto('file://' + path.join(root, entry));
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.querySelectorAll('.chart-row canvas').length > 3);
  await page.waitForTimeout(600);
  console.log('activité :', (await page.textContent('#activity')).trim());
  console.log('graphes  :', await page.$$eval('.chart-row', r => r.length));
  await page.screenshot({ path: path.join(shots, '01-charts.png') });

  // drag-select on the speed chart
  const box = await page.locator('.chart-row canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const selInfo = (await page.textContent('#selInfo')).replace(/\s+/g, ' ').trim();
  console.log('sélection:', selInfo.slice(0, 160));
  if (!/Durée/.test(selInfo)) throw new Error('la sélection ne remonte pas dans le panneau');

  // filter: slope > 2°, target 60 s
  const rows = await page.$$('.frow');
  for (const r of rows) {
    const label = (await r.textContent()).trim();
    if (label.startsWith('Pente')) {
      await r.$eval('input[type=checkbox]', c => { c.checked = true; c.dispatchEvent(new Event('change')); });
      const nums = await r.$$('input[type=number]');
      await nums[0].fill('2');
      break;
    }
  }
  await page.fill('#targetMin', '1');
  await page.waitForTimeout(300);
  const preview = (await page.textContent('#preview')).replace(/\s+/g, ' ').trim();
  console.log('aperçu   :', preview);
  await page.screenshot({ path: path.join(shots, '02-selection.png') });

  await page.click('#apply');
  await page.waitForTimeout(300);
  console.log('liste    :', (await page.textContent('#editList')).replace(/\s+/g, ' ').trim().slice(0, 140));
  console.log('bandeau  :', (await page.textContent('#delta')).trim());

  // second edit, on distance axis, selected from the map
  await page.click('.seg[data-x="dist"]');
  await page.click('#mapSelect');
  const mb = await page.locator('#map').boundingBox();
  await page.mouse.move(mb.x + mb.width * 0.45, mb.y + mb.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width * 0.55, mb.y + mb.height * 0.55, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  console.log('sél carte:', (await page.textContent('#selInfo')).replace(/\s+/g, ' ').trim().slice(0, 120));
  await page.screenshot({ path: path.join(shots, '03-map-selection.png') });

  // zoom with the wheel, check the y axis follows
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  const axisTxt = await page.evaluate(() => {
    const c = document.querySelector('#chartFooter .chart-axis canvas');
    return c ? c.width + 'x' + c.height : 'absent';
  });
  console.log('axe X    :', axisTxt);
  await page.screenshot({ path: path.join(shots, '04-zoom.png') });

  // aperçu « après retouche » sur la puissance / la FC
  await page.check('#optPower');
  await page.check('#optHr');
  await page.waitForTimeout(400);
  const marks = await page.$$eval('.chart-row', rs => rs
    .map(r => [r.querySelector('.lbl').textContent, r.querySelector('.ovl').textContent])
    .filter(x => x[1]).map(x => x[0]).join(', '));
  console.log('aperçus  :', marks || '(aucun)');
  if (!/Vitesse/.test(marks)) throw new Error('pas d\'aperçu sur la vitesse');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const comp = await page.$$eval('.chart-row', rs => rs
    .filter(r => r.querySelector('.ovlval'))
    .map(r => r.querySelector('.lbl').textContent + ' ' + r.querySelector('.cursor-val').textContent).join(' | '));
  console.log('survol   :', comp || '(aucune comparaison)');

  // date de la sortie
  const d0 = await page.inputValue('#startDate');
  await page.$eval('#startDate', i => { i.value = '2026-12-24T08:30:00'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  console.log('date     :', d0, '->', await page.inputValue('#startDate'), '|', (await page.textContent('#dateShift')).trim());

  // export
  await page.click('#export');
  await page.waitForSelector('#modal:not([hidden])');
  const report = (await page.textContent('#modalBody')).replace(/\s+/g, ' ').trim();
  console.log('export   :', report.slice(0, 420));
  await page.screenshot({ path: path.join(shots, '05-export.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const out = path.join(shots, dl.suggestedFilename());
  await dl.saveAs(out);
  console.log('téléchargé :', out, fs.statSync(out).size, 'octets');

  await browser.close();
  if (errors.length) { console.log('\nERREURS CONSOLE :\n' + errors.join('\n')); process.exit(1); }
  console.log('\nAucune erreur console.');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
