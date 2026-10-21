# Dancing Saints

A mobile web app for St. Gregory of Nyssa Episcopal Church, San Francisco. Visitors point
their phone at the rotunda mural, tap a saint's face and learn who they are. They can also
browse all the saints, read Richard Fabian's commentary and learn about the iconographer.

## Put it on the parish website

The `app/` folder is the whole app. It is plain HTML, CSS and JavaScript with relative
paths, so it needs no server setup, database or build step.

1. Rename `app/` to `saints/` (or any name).
2. Upload the folder to the website, for example with the host's file manager or FTP,
   so that `saints/index.html` is reachable at `https://saintgregorys.org/saints/`.
3. The site must be served over HTTPS. Phones only allow camera access on secure pages.

## Try it on a computer

From the `app/` folder run `python3 -m http.server 8000` and open http://localhost:8000.
Opening `index.html` directly from disk works for browsing, but the camera needs a server.
Add `?mobile=1` to the address to force the phone layout on a laptop with a webcam.

## How the camera recognition works

`js/vision.js` compares each camera frame with reference photos of the mural walls
(`img/mural/*.jpg`) using image features (ORB) and works out where each wall is in the
picture. `data/mural.js` lists where each face is on each reference photo, so the app can
draw a circle around every face it can see. Everything runs on the phone. No images
leave the device.

The reference photos are currently the small wall pictures from the brochure, which is
enough for testing against a screen but not for the church. For the real thing:

1. Photograph each wall section from the floor, as sharp and straight-on as possible.
   One photo per wall or section, in daylight with the usual lighting.
2. Save each photo as `app/img/mural/<wall>.jpg` (for example `south.jpg`). Up to about
   1600 pixels wide is plenty.
3. Open `tools/hotspot-editor.html` in a browser (through the same local server, from the
   `saints/` folder), load the photo, click each face and pick the saint.
4. Copy the result into `app/data/mural.js`, replacing that wall's entry.

To add the apse painting of St. Gregory preaching, add a wall entry with
`"banner": "apseBanner"` and no hotspots; the app then shows the caption whenever it sees it.

## Design

Styling follows `design.md` (taken from saintgregorys.org). Colors and fonts are CSS variables at the top of `app/css/app.css`.

## Content

- `app/data/saints.js`: profiles taken from the brochure (Cesar Chavez left out; Sergius &
  Bacchus and Nellie & Dorothy Lincoln listed together and separately with one profile).
- `app/data/saints.es.js`: Spanish profiles (draft, needs a fluent reviewer).
- `app/data/content.js`: interface text, commentary and iconographer text in both languages.
- `app/img/saints/`: portraits from the brochure (low resolution, to be replaced with the
  same file names).

`tools/extract.py` and `tools/build_data.py` regenerate the saint data from the brochure
PDF; `tools/saints_es.py` writes the Spanish file; `tools/build_mural.py` builds
`mural.js` from `tools/hotspots.brochure.json`.

## Third-party code

- jsfeat (MIT), `app/vendor/jsfeat-min.js`
- Lexend Deca and Federant fonts (SIL Open Font License), `app/fonts/`
- Logo, cross mark and loading illustration: St. Gregory of Nyssa Episcopal Church
