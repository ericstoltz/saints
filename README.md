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

The camera names saints in two ways, and uses both at once.

### Faces and portraits

`js/face-worker.js` finds painted faces in the camera picture and names each one by comparing it
with the saints' portraits, one straight-on portrait per saint. No wall photos are needed.

- A face finder (`models/blazeface.onnx`, MediaPipe BlazeFace full range, Apache 2.0) looks for
  faces in every frame. It also fires on robes, hands, feet and animals now and then, so each new
  spot is checked: a second copy of the worker embeds it (below) and the circle shows only if it
  looks enough like some saint's portrait (`faceMinSim` in `js/config.js`). Spots the finder is
  very sure of show right away while their check waits its turn.
- Every circle keeps the sharpest view of its face from the last few seconds (a moving phone, or
  the tap itself, blurs some frames), and that view is what gets checked and named.
- When a face is tapped, it and its nearest neighbours are cut from the full-size picture and
  turned into image embeddings by `models/siglip.onnx` (Google's SigLIP B/16 image encoder,
  Apache 2.0, 4-bit, 55 MB, downloaded in the background when the camera opens).
- Each embedding is compared with the portraits (`data/faces.bin`). The order of saints on the
  mural (`data/faces.js`) then checks that each guess agrees with the faces next to it.
- Sergius and Bacchus, and Nellie and Dorothy Lincoln, each have their own portrait and place on
  the mural, so the shared profile opens under the name of the one pointed at.
- When the match is clear, the profile opens. Otherwise the person picks from the three
  closest saints, or types a name.

Add `?faces=only` to the address to test this without the wall photos below.

Rebuild the portrait data after changing a portrait: `python3 tools/build_faces.py` (needs
Python with Pillow, numpy and onnxruntime). `tools/export_siglip.py` rebuilds the SigLIP model
from Google's published weights (`webli_en_b16_224_63724782.npz` from the big_vision bucket).

The models run with ONNX Runtime Web (`vendor/ort/`, MIT). The web server must send `.mjs`
files as JavaScript and `.wasm` files as `application/wasm` (most servers do).

### Wall photos

`js/vision.js` compares each camera frame with reference photos of the mural using image
features (ORB) and a perspective fit, so it copes with the phone being held at an angle.
Each reference is a "view": one photo crop of a flat stretch of wall. Every face also gets
its own close-up tile from the full-resolution photo, so a phone held close to one or two
saints still finds them. Everything runs on the phone. No images leave the device.

The features are computed ahead of time, so the phone only downloads `data/refs.bin`:

1. Put the photo in `tools/photos/` (full resolution, straight from the phone).
2. Add a view to `tools/views.json`: the crop box in photo pixels, the halo diameter in
   pixels, and the center of each face with its saint id (from `app/data/saints.json`).
3. Run `python3 tools/build_refs.py` (needs Python with Pillow, and Node). It writes
   `app/data/mural.js` and `app/data/refs.bin`, and saves each view with its faces circled
   in `tools/previews/` so you can check the positions.

Every saint also has a straight-on portrait (`tools/photos/portraits/`, from the church's
Flickr album). Saints not yet on a wall photo use their portrait as a reference, which works
when the phone is fairly close. Wall photos work much better from the floor, because the
portraits were taken from up close and look different from below.

Covered by a wall photo so far: the southwest wall, part of the south wall, and John
Coltrane (16 saints). One sharp photo per stretch of wall, taken from the floor, is enough;
the build simulates other angles.

To add the apse painting of St. Gregory preaching, add a view with `"banner": "apseBanner"`
and no faces; the app then shows the caption whenever it sees it.

## Design

Styling follows `design.md` (taken from saintgregorys.org). Colors and fonts are CSS variables at the top of `app/css/app.css`.

## Content

- `app/data/saints.js`: profiles taken from the brochure (one brochure profile left out; Sergius &
  Bacchus and Nellie & Dorothy Lincoln listed together and separately with one profile).
- `app/data/saints.es.js`: Spanish profiles (draft, needs a fluent reviewer).
- `app/data/content.js`: interface text, commentary and iconographer text in both languages.
- `app/img/saints/`: portraits (640 px squares, and 128 px list thumbnails in `thumbs/`)
  cut from the church's Flickr photos in `tools/photos/portraits/`.

`tools/extract.py` and `tools/build_data.py` regenerate the saint data from the brochure
PDF; `tools/saints_es.py` writes the Spanish file. `tools/hotspots.brochure.json` records
which saints the brochure shows on each wall, useful when marking faces on new photos.

## Third-party code

- jsfeat (MIT), `app/vendor/jsfeat-min.js`
- ONNX Runtime Web (MIT), `app/vendor/ort/`
- BlazeFace face detector (Apache 2.0, Google MediaPipe), `app/models/blazeface.onnx`
- SigLIP image encoder (Apache 2.0, Google big_vision), `app/models/siglip.onnx`
- Lexend Deca font (SIL Open Font License), `app/fonts/`
- Logo, cross mark and loading illustration: St. Gregory of Nyssa Episcopal Church
