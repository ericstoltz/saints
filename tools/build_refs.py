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
photos, jobs, views, tiled = {}, [], [], set()
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
    for key, (fx, fy) in v['faces'].items():
        sid = key.split('#')[0]   # 'id#2': another face that opens the same profile
        assert sid in saints, 'unknown saint id ' + sid
        tiled.add(sid)
        r = v['halo'] * 0.35 * k
        spots.append({'saint': sid, 'x': round((fx - x0) * k / W, 4), 'y': round((fy - y0) * k / H, 4), 'r': round(r / W, 4)})
        d.ellipse([(fx - x0) * k - r, (fy - y0) * k - r, (fx - x0) * k + r, (fy - y0) * k + r], outline=(255, 255, 0), width=3)
        d.text(((fx - x0) * k - r, (fy - y0) * k + r + 2), sid, fill=(255, 255, 0))
        # close-up tile around the face, from the full-resolution photo
        side = v['halo'] * TILE_HALOS; bx, by = round(fx - side / 2), round(fy - side * 0.42)
        tile = im.crop((bx, by, bx + round(side), by + round(side))).resize((TILE_PX, TILE_PX), Image.LANCZOS)
        traw = os.path.join(tmp, v['id'] + '-' + key.replace('#', '-') + '.png'); tile.convert('L').save(traw)
        jobs.append({'file': traw, 'kind': 'tile', 'view': v['id'], 'w': W, 'h': H, 'tw': TILE_PX, 'th': TILE_PX,
                     'a': round(side / TILE_PX * k, 6), 'ox': round((bx - x0) * k, 3), 'oy': round((by - y0) * k, 3)})
    prev.save(os.path.join(T, 'previews', v['id'] + '.jpg'), quality=80)
    views.append({'id': v['id'], 'w': W, 'h': H, 'hotspots': spots, **({'banner': v['banner']} if 'banner' in v else {})})
# Panorama: the church's 360-degree photo of the rotunda, taken from the floor center. It shows
# every wall from where visitors stand, so it gives far-away references for the whole mural.
# Two kinds of views come from it: flat (perspective) views around the room, which match what a
# phone sees in the church, and strips of the panorama as it is, which match the photo shown on
# a screen. Faces there are too small for close-up tiles.
PN = spec.get('panorama')
def pano_views(PN):
    import numpy as np
    im = Image.open(os.path.join(T, 'photos', PN['photo'])).convert('RGB')
    P = np.asarray(im, np.float32); Hp, Wp = P.shape[:2]
    def rot(yaw, pitch):
        p, y = np.radians(pitch), np.radians(yaw)
        Rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
        Ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
        return Ry @ Rx
    def render(yaw, pitch, hfov, W, H):
        f = (W / 2) / np.tan(np.radians(hfov) / 2)
        u, v = np.meshgrid(np.arange(W) - W / 2 + .5, np.arange(H) - H / 2 + .5)
        d = np.stack([u, -v, np.full_like(u, f)], -1) @ rot(yaw, pitch).T
        lon = np.arctan2(d[..., 0], d[..., 2]); lat = np.arctan2(d[..., 1], np.hypot(d[..., 0], d[..., 2]))
        x = (lon / (2 * np.pi) + .5) * Wp - .5; yy = (.5 - lat / np.pi) * Hp - .5
        x0 = np.floor(x).astype(int); y0 = np.clip(np.floor(yy).astype(int), 0, Hp - 2)
        fx = (x - x0)[..., None]; fy = (yy - y0)[..., None]; x0 %= Wp; x1 = (x0 + 1) % Wp
        out = (P[y0, x0] * (1 - fx) + P[y0, x1] * fx) * (1 - fy) + (P[y0 + 1, x0] * (1 - fx) + P[y0 + 1, x1] * fx) * fy
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), f
    def to_view(px, py, yaw, pitch, f, W, H):
        lon = ((px + .5) / Wp - .5) * 2 * np.pi; lat = (.5 - (py + .5) / Hp) * np.pi
        d = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)]) @ rot(yaw, pitch)
        if d[2] <= 0: return None
        return f * d[0] / d[2] + W / 2 - .5, -f * d[1] / d[2] + H / 2 - .5
    out = []
    hr = PN['halo'] * 0.35
    # one flat view per wall, so each view is close to a single plane
    for wall in PN['walls']:
        a, b = wall['x']; span = ((b - a) % Wp) * 360 / Wp
        yaw = ((a + ((b - a) % Wp) / 2) % Wp) * 360 / Wp - 180; pitch = -PN.get('pitch', 37); vh = PN.get('vfov', 44) / 2
        tw, th = np.tan(np.radians(span / 2 + 5)), np.tan(np.radians(vh))
        f = PN.get('flatLong', 1400) / 2 / max(tw, th); W, H = round(2 * f * tw), round(2 * f * th)
        img, f = render(yaw, pitch, 2 * np.degrees(np.arctan(tw)), W, H); spots = []
        for sid, (x, y) in PN['faces'].items():
            c = to_view(x, y, yaw, pitch, f, W, H); e = to_view(x + hr, y, yaw, pitch, f, W, H)
            if not c or not e or not (0 <= c[0] < W and 0 <= c[1] < H): continue
            spots.append((sid, c[0], c[1], np.hypot(e[0] - c[0], e[1] - c[1])))
        out.append(('pano-' + wall['id'], img, spots))
    S = PN.get('strips', {'w': 640, 'step': 400, 'y0': 380, 'y1': 800, 'scale': 1.5})
    for x0 in range(0, Wp, S['step']):
        cols = [(x0 + i) % Wp for i in range(S['w'])]
        strip = Image.fromarray(P[S['y0']:S['y1'], cols].astype(np.uint8)); k = S['scale']
        strip = strip.resize((round(strip.width * k), round(strip.height * k)), Image.LANCZOS); spots = []
        for sid, (x, y) in PN['faces'].items():
            dx = (x - x0) % Wp
            if dx < S['w'] and S['y0'] <= y < S['y1']: spots.append((sid, dx * k, (y - S['y0']) * k, hr * k))
        if spots: out.append(('pano-strip%d' % x0, strip, spots))
    return out
if PN:
    for vid, img, spots in pano_views(PN):
        W, H = img.size
        raw = os.path.join(tmp, vid + '.png'); img.convert('L').save(raw)
        jobs.append({'file': raw, 'kind': 'pano', 'view': vid, 'w': W, 'h': H})
        prev = img.copy(); d = ImageDraw.Draw(prev); hs = []
        for sid, x, y, r in spots:
            assert sid in saints or sid == 'jesus', 'unknown saint id ' + sid
            hs.append({'saint': sid, 'x': round(x / W, 4), 'y': round(y / H, 4), 'r': round(r / W, 4)})
            d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 0), width=2); d.text((x - r, y + r + 2), sid, fill=(255, 255, 0))
        prev.save(os.path.join(T, 'previews', vid + '.jpg'), quality=80)
        views.append({'id': vid, 'w': W, 'h': H, 'hotspots': hs})
# Portraits: one straight-on photo per saint (tools/photos/portraits, from the church's Flickr
# album). Each is a reference on its own, so a saint can be found up close with no wall photo.
# They were taken from a lift, so from the floor they match only at close range; a wall photo
# works much better, and a saint with a close-up tile from a wall photo doesn't get a portrait reference.
# The face sits near the same spot in every portrait.
P = spec.get('portraits')
if P:
    pdir = os.path.join(T, 'photos', 'portraits'); index = json.load(open(os.path.join(pdir, 'index.json')))
    for f, sid in sorted(index.items()):
        if sid in tiled and not P.get('all'): continue
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
covered = {h['saint'] for v in views for h in v['hotspots']} - {'jesus'}
mural = {'views': views, 'refs': meta, 'refsFile': 'data/refs.bin'}
open(os.path.join(APP, 'data', 'mural.js'), 'w').write(
    '/* Made by tools/build_refs.py from tools/views.json. Do not edit by hand. */\nwindow.MURAL = ' + json.dumps(mural, ensure_ascii=False) + ';\n')
print(len(views), 'views,', len(meta), 'references,', sum(m['n'] for m in meta), 'keypoints,',
      os.path.getsize(os.path.join(APP, 'data', 'refs.bin')) // 1024, 'KB;', len(covered), 'of', len(saints), 'saints covered')
