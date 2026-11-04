// Audit the poster: overflow per panel, and the font sizes actually used (in pt) per region.
//   node audit-poster.mjs <poster.html>
import { launchChrome, connectPage, sleep } from './cdp.mjs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const htmlPath = process.argv[2];
const port = 9474;
const chrome = await launchChrome({ chromePath: CHROME, port, profile: `${process.env.TEMP}/poster-audit-profile`, width: 1600, height: 1200, extraArgs: ['--allow-file-access-from-files'] });
try {
  const page = await connectPage(port);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 4536, height: 6048, deviceScaleFactor: 0.25, mobile: false });
  await page.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
  for (let i = 0; i < 300; i++) { await sleep(100); if (await page.evaluate(`document.readyState === 'complete'`).catch(() => false)) break; }
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(500);
  const report = await page.evaluate(`(() => {
    const pt = (px) => Math.round(px * 72 / 96 * 10) / 10;
    const regions = ['.band', '.hero .wrap', '.team', '.statement .q', '.statement .why', '.loop', '.cols .col', '.evi .tile', '.evi .chart', '.evi .proto', '.bottom .fut', '.sys', '.footer'];
    const out = [];
    for (const sel of regions) {
      document.querySelectorAll(sel).forEach((el, i) => {
        const sizes = new Map();
        el.querySelectorAll('*').forEach((n) => {
          const t = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
          if (!t) return;
          const fs = pt(parseFloat(getComputedStyle(n).fontSize));
          sizes.set(fs, (sizes.get(fs) || 0) + n.textContent.trim().split(/\\s+/).length);
        });
        const r = el.getBoundingClientRect();
        out.push({ region: sel + (i ? '#' + i : ''), heightMm: Math.round(r.height / 96 * 25.4), overflow: el.scrollHeight - el.clientHeight > 2 ? (el.scrollHeight - el.clientHeight) + 'px' : 'none',
          sizesPt: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([s, w]) => s + 'pt×' + w + 'w').join(' ') });
      });
    }
    return out;
  })()`);
  for (const r of report) console.log(r.region.padEnd(18), String(r.heightMm).padStart(4) + 'mm', 'overflow:' + r.overflow.padEnd(6), r.sizesPt);
} finally { chrome.kill(); }
