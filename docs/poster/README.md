# Demo Day poster — `27.EDGE.FlexiPath.pdf`

The poster for the NSTI Festival 2026 booth (ADNEC Centre Al Ain, 10–13 Nov 2026): Stand 27, EDGE track, team
"FlexiPath" in the organisers' booklet. 1200 × 1600 mm portrait, one page, vector text with the fonts embedded; the
organisers print and mount it. The file name follows their rule `StandNumber.Track.TeamName`.

## What is here

- `27.EDGE.FlexiPath.pdf` — the final poster: Mohameden's layout with the hero picture replaced by a still from the 3D
  digital twin (the `poster_title` shot: the simulated city at night with the drone's cyan Wi-Fi beam).
- `27.EDGE.FlexiPath-A.pdf` — the file Mohameden sent on 4 Nov 2026: his final layout, made outside this repository
  (a Chrome PDF with the same Inter / Orbitron / JetBrains Mono fonts) with an illustrated hero scene. Its source was
  never pushed; the PDF is the only copy.
- `compose-hero.py` — replaces the hero band of that PDF (97.9–568.5 mm from the top) with a twin still and redraws
  the title block, caption and glow on top, directly in the PDF with PyMuPDF:

  ```bash
  python -I docs/poster/compose-hero.py docs/poster/27.EDGE.FlexiPath-A.pdf docs/poster/img/hero-title.jpg docs/poster/27.EDGE.FlexiPath.pdf 0.08 "3D DIGITAL TWIN|  ·  FlexiPath's simulated city at night: the cyan beam is the drone's Wi-Fi control link" docs/poster/fonts
  ```

  It removes the old labels' text in the band, draws the original page as a form (so the blend mode it leaves open
  cannot tint what is drawn on top), places the still cropped to the band's aspect ratio, and re-inserts the title
  spans at the positions read from the original. Needs `pymupdf`, `pillow`, `fonttools` and `brotli`. One gotcha:
  PyMuPDF's `insert_text(border_width=…)` scales the stroke by the font size, so the glow passes `width / fontsize`.
- `poster.html` (+ `fonts/`, `img/`, `print-poster.mjs`, `audit-poster.mjs`, `cdp.mjs`) — the earlier HTML draft of
  the poster, written to the organisers' final rules (no logos, word limits). It is a different layout from the final
  file; its PDF is not kept here, rebuild it as below if it is ever wanted again.

The twin still is 3840 px wide, which is 81 DPI across 1200 mm; a smooth 3D render reads fine at that size. The
capture rig (`brag-output-*/work/cap`, `SHOTS_FILE=./poster-shots.mjs node capture.mjs poster_title --stills 0`)
can re-render it at `dsf: 3` (5760 px) for a sharper print.

## Rules from the organisers (4 Nov 2026, final)

No logos of ATRC, EDGE, DCT/ENEC, universities or other organisations (only a team logo is allowed). Word limits:
proposed solution 150, technical explanation 150, solution features 200, future improvements 150. Required: team name,
students' names, university name, the sponsor's challenge statement, those four sections and illustrations. Uploaded on
ChallengeON by 7 PM on Wed 4 Nov with a Drive/Dropbox link in the form. The poster hangs above a 120 × 30 cm locker
where the laptop sits, so the bottom ~25 cm may be hidden.

## Rebuilding the HTML draft

Chrome's `--print-to-pdf` silently replaces **variable** web fonts with Arial / Segoe UI, so `fonts/` holds static
instances (made with `python -m fontTools.varLib.instancer Inter.woff2 wght=700 -o Inter-700.woff2`, one per weight
used) and the PDF is printed through the DevTools protocol once `document.fonts.ready` has resolved:

```bash
node docs/poster/print-poster.mjs "C:/…/docs/poster/poster.html" "C:/…/docs/poster/poster-draft.pdf"
```

(`print-poster.mjs` and `audit-poster.mjs` import `cdp.mjs`, a small CDP client; they need Chrome at its default
Windows path.) Check the result with `grep -a -o "/BaseFont */[A-Za-z0-9+_-]*" poster-draft.pdf` — it must list
Inter, Orbitron and JetBrainsMono — and `MediaBox [0 0 3402 4535.04]` (1200 × 1600 mm in points).
`audit-poster.mjs poster.html` prints, per panel, the height, whether its content overflows, and the font sizes in
points actually used, so a text edit can be checked without printing.
