# Demo Day poster — `27.EDGE.FlexiPath.pdf`

The poster for the NSTI Festival 2026 booth (ADNEC Centre Al Ain, 10–13 Nov 2026): Stand 27, EDGE track, team
"FlexiPath" in the organisers' booklet. 1200 × 1600 mm portrait, one page, vector text with the fonts embedded; the
organisers print and mount it. The file name follows their rule `StandNumber.Track.TeamName`.

`poster.html` is the source: a fixed 1200 × 1600 mm page (`@page` size, absolute rows in mm) with the text, the
six-stage loop, the results tiles, the trade-off chart (`img/tradeoff.svg`, from `scripts/tradeoff-chart.js`), a still
of the digital twin and QR codes to flexipath.vercel.app. Every number comes from the README tables at the time of
writing; the word counts of the four required sections are 190 / 199 / 235 / 167.

## Rebuilding the PDF

Chrome's `--print-to-pdf` silently replaces **variable** web fonts with Arial / Segoe UI, so `fonts/` holds static
instances (made with `python -m fontTools.varLib.instancer Inter.woff2 wght=700 -o Inter-700.woff2`, one per weight
used) and the PDF is printed through the DevTools protocol once `document.fonts.ready` has resolved:

```bash
node docs/poster/print-poster.mjs "C:/…/docs/poster/poster.html" "C:/…/docs/poster/27.EDGE.FlexiPath.pdf"
```

(`print-poster.mjs` and `audit-poster.mjs` import `cdp.mjs`, a small CDP client; they need Chrome at its default
Windows path.) Check the result with `grep -a -o "/BaseFont */[A-Za-z0-9+_-]*" 27.EDGE.FlexiPath.pdf` — it must list
Inter, Orbitron and JetBrainsMono — and `MediaBox [0 0 3402 4535.04]` (1200 × 1600 mm in points).

`audit-poster.mjs poster.html` prints, per panel, the height, whether its content overflows, and the font sizes in
points actually used, so a text edit can be checked without printing.

## Logos

`img/edge-logo.svg` is EDGE Group's wordmark as served by edgegroup.ae, `img/aau-logo.svg` Al Ain University's logo from
aau.ac.ae and `img/atrc-logo.png` the ATRC mark from challengeon.atrc.ae; they are used only on this poster for the
organisers' own event, in their original colours on a white band.
