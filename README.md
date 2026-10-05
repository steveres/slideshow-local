# Slideshow

A single-page slideshow that runs straight from the filesystem. It plays the photos and
videos in a folder, draws the route between them on a Google map, and plays any MP3s in
the folder as background music.

## Build

Requires [Node.js](https://nodejs.org).

1. `npm install` (once)
2. Create `apikey.txt` in this folder containing your Google Maps API key and nothing else.
   The key needs the **Maps JavaScript API** enabled and must not have a website (HTTP
   referrer) restriction.
3. `npm run build`

While editing, `npm run watch` rebuilds automatically each time a file in `src/` is saved.

This writes `slideshow.html`, a self-contained page with your key inside it. Both
`apikey.txt` and `slideshow.html` are git-ignored; do not commit or share them.

## Use

1. Optional, Windows: drag your photo folder onto `prepare.bat`. It converts HEIC files to
   JPEG and writes `slideshow.json`, which puts the slideshow in date-taken order and
   supplies the dates on the timeline.
2. Open `slideshow.html` in Chrome or Edge and choose the photo folder. The folder and
   settings are remembered.

## Layout

- `src/slideshow.ts` - all the logic
- `src/template.html` - markup and styles; the compiled script is inlined into it
- `build.mjs` - build script
- `prepare.bat`, `prepare.ps1` - photo folder preparation (Windows)
