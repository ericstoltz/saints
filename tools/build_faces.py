"""Build the face-recognition data for the camera from the saints' portraits.

Each saint has one straight-on portrait (tools/photos/portraits, index.json maps file -> saint id).
For each portrait this finds the face (app/models/blazeface.onnx), cuts it out the way the app
cuts faces from the camera, adds a few degraded copies (small, blurry, seen from below), and
stores the image embedding of each copy (app/models/siglip.onnx).

Writes app/data/faces.js (saint ids, face layout) and app/data/faces.bin (float16 embeddings).
The layout is where each face sits on the mural (panorama pixels, from tools/views.json); the app
uses it to check a guess against the saints next to it. Paired saints (Sergius & Bacchus, Nellie &
Dorothy Lincoln) share one profile but each has a portrait, so each row also names its member.
hub: how much each saint's portrait looks like faces in general; the app subtracts part of it so
that a few portraits (they match blurry faces well) don't crowd out the right saint.
Needs Python with Pillow, numpy and onnxruntime. Usage: python3 tools/build_faces.py"""
import json, os
import numpy as np, onnxruntime as ort
from PIL import Image

T = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(T, '..', 'app')
CROP = {'pad': 1.8, 'up': 0.12, 'size': 224}          # must match js/face-worker.js
# portrait file -> member name, for the paired saints (see MEMBER_IMG in js/app.js)
MEMBERS = {'sergius-and-bacchus': 'Sergius', 'bacchus-and-sergius': 'Bacchus',
           'nellie-lincoln': 'Nellie Lincoln', 'dorothy-lincoln': 'Dorothy Lincoln'}
HUB_K = 20
# where each member's face is in the panorama (the panorama marks one face per pair)
MEMBER_LAYOUT = {'sergius-bacchus|Sergius': [2455, 692], 'sergius-bacchus|Bacchus': [2507, 698],
                 'nellie-dorothy-lincoln|Nellie Lincoln': [2402, 545], 'nellie-dorothy-lincoln|Dorothy Lincoln': [2392, 597]}
DEGRADE = [(None, 1.0), (64, 1.0), (64, 1.4), (40, 1.0), (64, 0.8)]   # (shrink to px, vertical squeeze)

det = ort.InferenceSession(os.path.join(APP, 'models', 'blazeface.onnx'))
enc = ort.InferenceSession(os.path.join(APP, 'models', 'siglip.onnx'))
G = 48; ANCH = np.array([((x + .5) / G, (y + .5) / G) for y in range(G) for x in range(G)])

def detect(img, thresh=0.2):
    """best face in a PIL image: (score, cx, cy, w) in image pixels"""
    W, H = img.size; S = max(W, H); sq = Image.new('RGB', (S, S)); sq.paste(img, (0, 0))
    a = np.asarray(sq.resize((192, 192), Image.BILINEAR), np.float32) / 127.5 - 1
    reg, cls = det.run(None, {'input': a.transpose(2, 0, 1)[None]})
    sc = 1 / (1 + np.exp(-np.clip(cls[0, :, 0], -50, 50))); i = int(sc.argmax())
    if sc[i] < thresh: return None
    cx = reg[0, i, 0] / 192 + ANCH[i, 0]; cy = reg[0, i, 1] / 192 + ANCH[i, 1]; w = reg[0, i, 2] / 192
    return float(sc[i]), cx * S, cy * S, w * S

def crop(im, cx, cy, w, px=None, squeeze=1.0):
    side = w * CROP['pad']; y = cy - CROP['up'] * w
    c = im.crop((round(cx - side / 2), round(y - side / 2 * squeeze), round(cx + side / 2), round(y + side / 2 * squeeze)))
    if px: c = c.resize((px, px), Image.BILINEAR)
    return c.resize((CROP['size'], CROP['size']), Image.BICUBIC)

pdir = os.path.join(T, 'photos', 'portraits'); index = json.load(open(os.path.join(pdir, 'index.json')))
rows, members, crops = [], [], []
for f, sid in sorted(index.items()):
    im = Image.open(os.path.join(pdir, f + '.jpg')).convert('RGB'); W = im.width
    d = detect(im.crop((0, 0, W, W)))   # the face is in the top square of every portrait
    assert d, 'no face found in ' + f
    for px, sq in DEGRADE:
        crops.append(crop(im, d[1], d[2], d[3], px, sq)); rows.append(sid); members.append(MEMBERS.get(f, ''))
emb = np.concatenate([enc.run(None, {'pixels': np.stack([np.asarray(c, np.float32) for c in crops[i:i + 8]])})[0]
                      for i in range(0, len(crops), 8)])
# hub: mean of the HUB_K best similarities between this saint's portraits and everyone else's copies
keys = [r + '|' + m for r, m in zip(rows, members)]; sim = emb @ emb.T; hub = {}
for k in sorted(set(keys)):
    mine = [i for i, x in enumerate(keys) if x == k]; other = [i for i, x in enumerate(keys) if x != k]
    hub[k] = round(float(np.sort(sim[np.ix_(other, mine)].max(1))[-HUB_K:].mean()), 4)
emb.astype(np.float16).tofile(os.path.join(APP, 'data', 'faces.bin'))
pano = json.load(open(os.path.join(T, 'views.json')))['panorama']
layout = {sid: xy for sid, xy in pano['faces'].items() if sid in set(rows) and not any(k.startswith(sid + '|') for k in MEMBER_LAYOUT)}
layout.update(MEMBER_LAYOUT)
data = {'dim': emb.shape[1], 'rows': rows, 'members': members, 'hub': hub, 'crop': CROP, 'layout': layout, 'layoutWidth': 4096,
        'faceInLayout': 21, 'file': 'data/faces.bin'}
open(os.path.join(APP, 'data', 'faces.js'), 'w').write(
    '/* Made by tools/build_faces.py. Do not edit by hand. */\nwindow.FACES = ' + json.dumps(data, ensure_ascii=False) + ';\n')
print(len(set(rows)), 'saints,', len(rows), 'embeddings,', os.path.getsize(os.path.join(APP, 'data', 'faces.bin')) // 1024, 'KB')
