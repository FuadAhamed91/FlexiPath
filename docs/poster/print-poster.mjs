// Print the poster HTML to PDF through the DevTools protocol, after its web fonts and images have loaded.
//   node print-poster.mjs <poster.html> <out.pdf> [out-200dpi.png]
import { writeFileSync } from 'node:fs';
import { launchChrome, connectPage, sleep } from './cdp.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [, , htmlPath, outPdf, outPng] = process.argv;
const port = 9464;
const chrome = await launchChrome({
  chromePath: CHROME, port, profile: `${process.env.TEMP}/poster-print-profile`, width: 1600, height: 1200,
  extraArgs: ['--allow-file-access-from-files', '--force-color-profile=srgb'],
});
try {
  const page = await connectPage(port);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    if (await page.evaluate(`document.readyState === 'complete'`).catch(() => false)) break;
  }
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await page.evaluate(`Promise.all([...document.images].map((i) => i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))).then(() => true)`);
  await sleep(500);
  console.log('fonts:', await page.evaluate(`[...document.fonts].map((f) => f.family + ':' + f.status).join(', ')`));
  console.log('images:', await page.evaluate(`[...document.images].map((i) => (i.naturalWidth ? 'ok' : 'MISSING ') + i.getAttribute('src')).join(' | ')`));

  console.log('printing…');
  const pdf = await page.send('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, scale: 1,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    paperWidth: 1200 / 25.4, paperHeight: 1600 / 25.4,
    transferMode: 'ReturnAsStream',
  });
  // Read the stream in chunks: one multi-megabyte websocket message can stall the client.
  const chunks = [];
  for (;;) {
    const part = await page.send('IO.read', { handle: pdf.stream, size: 1 << 20 });
    chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
    if (part.eof) break;
  }
  await page.send('IO.close', { handle: pdf.stream });
  writeFileSync(outPdf, Buffer.concat(chunks));
  console.log('pdf written', outPdf, Buffer.concat(chunks).length, 'bytes');

  if (outPng) {
    // 1200 mm at 200 DPI = 9449 px; the page is 4535.4 CSS px wide, so scale = 9449 / 4535.4.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 4536, height: 6048, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    const shot = await page.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 4535.4, height: 6047.2, scale: 9449 / 4535.4 },
    });
    writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    console.log('png written', outPng);
  }
} finally {
  chrome.kill();
}
