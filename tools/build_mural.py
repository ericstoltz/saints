"""Build app/data/mural.js from hotspot positions and saints.json.
Usage: python3 build_mural.py hotspots.json APP_DIR"""
import sys, json
from PIL import Image
hs = json.load(open(sys.argv[1])); app = sys.argv[2]
saints = json.load(open(f'{app}/data/saints.json'))['saints']
by_num = {n: s['id'] for s in saints for n in s['numbers']}
SPECIAL = {5: 'jesus', 36: None}   # 36 = Cesar Chavez, left out of the app
walls = []
for wall, spec in hs.items():
    if wall.startswith('_'): continue
    img = f'img/mural/{wall}.jpg'
    w, h = Image.open(f'{app}/{img}').size
    spots = []
    for key, (x, y) in spec['faces'].items():
        n = int(key.rstrip('b'))
        sid = SPECIAL[n] if n in SPECIAL else by_num[n]
        if sid is None: continue
        spots.append({'saint': sid, 'x': round(x / 100, 4), 'y': round(y / 100, 4), 'r': spec.get('r')})
    walls.append({'id': wall, 'image': img, 'width': w, 'height': h, 'hotspots': spots})
missing = set(s['id'] for s in saints) - {p['saint'] for w in walls for p in w['hotspots']}
print('walls', len(walls), 'hotspots', sum(len(w['hotspots']) for w in walls), 'saints without a hotspot:', missing)
open(f'{app}/data/mural.js', 'w').write('window.MURAL = ' + json.dumps({'walls': walls}, ensure_ascii=False, indent=1) + ';\n')
