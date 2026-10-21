"""Build camera-recognition data from mural photos.

Reads tools/views.json and tools/photos/, writes:
  app/data/mural.js   views with face hotspots, and the reference list
  app/data/refs.bin   precomputed ORB features (made by tools/extract_refs.js)
  tools/previews/     each view as the app sees it, with hotspots drawn (for checking)
Usage: python3 tools/build_refs.py"""
import json, os, subprocess, tempfile
from PIL import Image, ImageOps, ImageDraw

T = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(T, '..', 'app')
VIEW_LONG, TILE_PX, TILE_HALOS = 1600, 512, 2.2   # tile side = 2.2 halo diameters
spec = json.load(open(os.path.join(T, 'views.json')))
saints = {s['id'] for s in json.load(open(os.path.join(APP, 'data', 'saints.json')))['saints']}
tmp = tempfile.mkdtemp(); os.makedirs(os.path.join(T, 'previews'), exist_ok=True)
photos, jobs, views = {}, [], []
for v in spec['views']:
    if v['photo'] not in photos:
        photos[v['photo']] = ImageOps.exif_transpose(Image.open(os.path.join(T, 'photos', v['photo']))).convert('RGB')
    im = photos[v['photo']]; x0, y0, x1, y1 = v['box']
    crop = im.crop(v['box']); k = VIEW_LONG / max(crop.size)
    view = crop.resize((round(crop.width * k), round(crop.height * k)), Image.LANCZOS)
    W, H = view.size
    raw = os.path.join(tmp, v['id'] + '.gray'); view.convert('L').save(raw + '.png')
    jobs.append({'file': raw + '.png', 'kind': 'view', 'view': v['id'], 'w': W, 'h': H})
    spots = []
    prev = view.copy(); d = ImageDraw.Draw(prev)
    for sid, (fx, fy) in v['faces'].items():
        assert sid in saints, 'unknown saint id ' + sid
        r = v['halo'] * 0.35 * k
        spots.append({'saint': sid, 'x': round((fx - x0) * k / W, 4), 'y': round((fy - y0) * k / H, 4), 'r': round(r / W, 4)})
        d.ellipse([(fx - x0) * k - r, (fy - y0) * k - r, (fx - x0) * k + r, (fy - y0) * k + r], outline=(255, 255, 0), width=3)
        d.text(((fx - x0) * k - r, (fy - y0) * k + r + 2), sid, fill=(255, 255, 0))
        # close-up tile around the face, from the full-resolution photo
        side = v['halo'] * TILE_HALOS; bx, by = round(fx - side / 2), round(fy - side * 0.42)
        tile = im.crop((bx, by, bx + round(side), by + round(side))).resize((TILE_PX, TILE_PX), Image.LANCZOS)
        traw = os.path.join(tmp, v['id'] + '-' + sid + '.png'); tile.convert('L').save(traw)
        jobs.append({'file': traw, 'kind': 'tile', 'view': v['id'], 'w': W, 'h': H, 'tw': TILE_PX, 'th': TILE_PX,
                     'a': round(side / TILE_PX * k, 6), 'ox': round((bx - x0) * k, 3), 'oy': round((by - y0) * k, 3)})
    prev.save(os.path.join(T, 'previews', v['id'] + '.jpg'), quality=80)
    views.append({'id': v['id'], 'w': W, 'h': H, 'hotspots': spots, **({'banner': v['banner']} if 'banner' in v else {})})
# Portraits: one straight-on photo per saint (tools/photos/portraits, from the church's Flickr
# album). Each is a reference on its own, so a saint can be found up close with no wall photo.
# They were taken from a lift, so from the floor they match only at close range; a wall photo
# works much better, and a saint on a wall photo doesn't get a portrait reference.
# The face sits near the same spot in every portrait.
P = spec.get('portraits')
if P:
    on_walls = {h['saint'] for v in views for h in v['hotspots']}
    pdir = os.path.join(T, 'photos', 'portraits'); index = json.load(open(os.path.join(pdir, 'index.json')))
    for f, sid in sorted(index.items()):
        if sid in on_walls and not P.get('all'): continue
        im = Image.open(os.path.join(pdir, f + '.jpg')).convert('RGB')
        k = P['longSide'] / max(im.size); view = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        W, H = view.size; fx, fy = P['faces'].get(f, P['face'])
        raw = os.path.join(tmp, 'p-' + f + '.png'); view.convert('L').save(raw)
        jobs.append({'file': raw, 'kind': 'portrait', 'view': 'p-' + f, 'w': W, 'h': H})
        if sid == 'jesus':
            views.append({'id': 'p-' + f, 'w': W, 'h': H, 'hotspots': [], 'banner': 'jesusBanner'}); continue
        views.append({'id': 'p-' + f, 'w': W, 'h': H, 'hotspots': [{'saint': sid, 'x': fx, 'y': fy, 'r': P['r']}]})
# convert pngs to raw gray for node
for j in jobs:
    g = Image.open(j['file']); j['gw'], j['gh'] = g.size
    with open(j['file'][:-4] + '.raw', 'wb') as f: f.write(g.tobytes())
    j['file'] = j['file'][:-4] + '.raw'
json.dump(jobs, open(os.path.join(tmp, 'jobs.json'), 'w'))
out = subprocess.run(['node', os.path.join(T, 'extract_refs.js'), os.path.join(tmp, 'jobs.json'), os.path.join(APP, 'data', 'refs.bin')],
                     check=True, capture_output=True, text=True).stdout
meta = json.loads(out)
covered = {h['saint'] for v in views for h in v['hotspots']}
mural = {'views': views, 'refs': meta, 'refsFile': 'data/refs.bin'}
open(os.path.join(APP, 'data', 'mural.js'), 'w').write(
    '/* Made by tools/build_refs.py from tools/views.json. Do not edit by hand. */\nwindow.MURAL = ' + json.dumps(mural, ensure_ascii=False) + ';\n')
print(len(views), 'views,', len(meta), 'references,', sum(m['n'] for m in meta), 'keypoints,',
      os.path.getsize(os.path.join(APP, 'data', 'refs.bin')) // 1024, 'KB;', len(covered), 'of', len(saints), 'saints covered')
