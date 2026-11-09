# PDF Ink

Notability-style handwriting on PDFs inside [Obsidian](https://obsidian.md), built for iPad + Apple Pencil (works on desktop with a mouse too).

## Features

- **Ballpoint pen**: smooth, even-width ink with gently tapered ends; size slider, any colour (picker or hex code), 3 recent colours
- **Highlighter**: translucent with adjustable opacity, sits under your ink and never hides text
- **Hold to snap shapes**: draw, hold still, and it becomes a clean line, circle, ellipse, triangle, rectangle or square (equilateral / right-angle / square tidy-up). Keep holding and move to resize and rotate.
- **Alignment guides**: moved selections snap to other items and the page centre; line ends snap onto corners and endpoints
- **Eraser, lasso** (select by touching, tap to select, move, resize from any corner, cut / copy / paste, delete)
- **Undo / redo**
- **Photos**: insert from the photo library or paste; resize and write on top
- **Palm rejection**: only the Pencil draws; fingers scroll and pinch-zoom
- **Writing size calibration**: pages open at the same size in split screen as in full screen
- **Export** a copy of the PDF with ink and photos built in (vector, text stays selectable)
- **Import ink** from an older version of a PDF; pages are matched by their text, so inserted/removed slides are handled

Ink is stored next to the PDF as `<file>.pdf.ink.json`; the original PDF is never modified.

## Install (manual)

1. `npm install`
2. Edit the output folder in `esbuild.config.mjs` to point at `<your vault>/.obsidian/plugins/pdf-ink`
3. `npm run build`
4. Enable **PDF Ink** under Settings → Community plugins

To sync to iPad with Obsidian Sync, turn on *Installed community plugins* and *Sync all other types* (for the `.ink.json` files) on both devices.

## Develop

- `npm run dev`: rebuild on change
- `npx esbuild src/geom.test.ts --bundle --platform=node | node`: shape / geometry tests
- `npx esbuild src/match.test.ts --bundle --platform=node | node`: page-matching tests

## License

MIT
