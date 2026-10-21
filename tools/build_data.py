"""Turn saints.raw.json into the app's saints.json and render photos.
Usage: python3 build_data.py BROCHURE.pdf APP_DIR RAW_JSON"""
import sys, json, re, unicodedata
import pymupdf as fitz

src, app, raw = sys.argv[1:4]
doc = fitz.open(src)
entries = json.load(open(raw))

NAME_FIX = {
    'BartolomÉ de las Casas': 'Bartolomé de las Casas',
    'cesar Chavez': 'Cesar Chavez',
    '': 'Paul Erdős',
    'Andrei rublev': 'Andrei Rublev',
    'Jalal Ad-Din Rumi': 'Jalal ad-Din Rumi',
    "Lili'uokalani": 'Liliʻuokalani',
    'Samuel Isaac Joseph Scherechewsky': 'Samuel Isaac Joseph Schereschewsky',
}
EXCLUDE = {'Cesar Chavez'}
# sort key = brochure order (by family name); extra names people may type
ALIASES = {
    'Mohandas Karamchand Gandhi': ['Gandhi', 'Mahatma Gandhi'],
    'Jalal ad-Din Rumi': ['Rumi'],
    'Desmond Mpilo Tutu': ['Desmond Tutu'],
    'Samuel Isaac Joseph Schereschewsky': ['Schereschewsky'],
    'Esther John (Qamar Zia)': ['Qamar Zia'],
    'John XXIII': ['Pope John XXIII', 'John 23'],
    'Paul of Tarsus': ['Paul', 'Saint Paul', 'Paul of Taurus'],
    'Francis of Assisi (with wolf)': ['Francis of Assisi', 'Francis'],
    'Seraphim (with bear)': ['Seraphim of Sarov', 'Seraphim'],
    'Sadi (with tiger)': ['Sadi', 'Saadi'],
    'Lady Godiva (with horse)': ['Lady Godiva', 'Godiva'],
    'Fyodor Dostoievski': ['Dostoevsky', 'Fyodor Dostoevsky'],
    'Elizabeth I': ['Queen Elizabeth', 'Elizabeth the First'],
    'Liliʻuokalani': ['Liliuokalani', "Lili'uokalani", 'Queen Liliuokalani'],
    'Paul Erdős': ['Paul Erdos', 'Erdos'],
    'Malcolm X': ['Malcolm'],
    'Kangxi': ['Kangxi Emperor', 'Kang Xi'],
    'Christine de Pisan': ['Christine de Pizan'],
    'Moses the Black': ['Moses the Ethiopian', 'Abba Moses'],
}
SPLIT = {
    'Nellie & Dorothy Lincoln': ['Nellie Lincoln', 'Dorothy Lincoln'],
    'Sergius & Bacchus': ['Sergius', 'Bacchus'],
}
WALLS = {}
for wall, nums in {
    'South wall, upper': range(1, 10), 'South wall, lower': range(10, 20),
    'Southwest wall, upper': range(20, 24), 'Southwest wall, lower': range(24, 28),
    'Southeast wall, upper': range(28, 32), 'Southeast wall, lower': range(32, 36),
    'West wall, upper': range(36, 48), 'West wall, lower': range(48, 51),
    'Northeast wall, upper': range(51, 55), 'Northeast wall, lower': range(55, 59),
    'East wall, upper': range(59, 71), 'East wall, lower': range(71, 75),
    'North wall': range(75, 83),
    'Northwest wall, upper': range(83, 87), 'Northwest wall, lower': range(87, 91),
}.items():
    for n in nums: WALLS[n] = wall
MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'

def slugify(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')

def clean(t):
    t = t.replace('ﬃ', 'ffi').replace('ﬄ', 'ffl').replace('ﬁ', 'fi').replace('ﬂ', 'fl').replace('ﬀ', 'ff').replace('−', '—')
    t = t.replace('Archbish-op', 'Archbishop').replace('Com-mission', 'Commission').replace('Su- preme', 'Supreme').replace('threepart', 'three-part').replace('imagi-native', 'imaginative')
    t = re.sub(r'\)(?=[A-Z])', ') ', t)
    t = t.replace('2nd—century', '2nd-century')
    t = re.sub(r'(?<=[\d?])-(?=\d)', '–', t)
    return t

saints = []
for i, e in enumerate(entries):
    name, _, nums = e['heading'].partition('•')
    name = NAME_FIX.get(name.strip(), name.strip())
    if name in EXCLUDE: continue
    numbers = [int(n) for n in re.findall(r'\d+', nums)]
    body = clean(e['body'])
    lifespan = None
    m = re.match(r'^\(([^)]*)\)\s*', body)
    if m:
        lifespan, body = m.group(1).strip().replace(' B.C.', ' BCE'), body[m.end():]
    feast = None
    m = re.search(r'\s*\(((?:%s)\s+\d+|Easter Day)\)\s*$' % MONTHS, body)
    if m:
        feast, body = m.group(1), body[:m.start()]
    if not re.search(r'[.!?”"]\s*$', body): body += '.'
    slug = slugify(re.sub(r'\(.*?\)', '', name))
    r = fitz.Rect(e['img_rect'])
    pix = doc[e['page'] - 1].get_pixmap(clip=r, matrix=fitz.Matrix(4, 4))
    pix.save(f'{app}/img/saints/{slug}.jpg', jpg_quality=85)
    saints.append({
        'id': slug, 'name': name, 'numbers': numbers,
        'location': WALLS.get(numbers[0]) if numbers else None,
        'lifespan': lifespan, 'feast': feast, 'bio': body,
        'image': f'img/saints/{slug}.jpg', 'order': i,
        'aliases': ALIASES.get(name, []),
        'members': SPLIT.get(name, []),
    })

# list entries: every profile, plus pair members listed on their own
listing = []
for s in saints:
    listing.append({'label': s['name'], 'id': s['id']})
    for m in s['members']:
        listing.append({'label': m, 'id': s['id']})
print(len(saints), 'profiles,', len(listing), 'list entries')
json.dump({'saints': saints, 'list': listing}, open(f'{app}/data/saints.json', 'w'),
          ensure_ascii=False, indent=1)
open(f'{app}/data/saints.js', 'w').write(
    'window.SAINTS = ' + json.dumps({'saints': saints, 'list': listing}, ensure_ascii=False, indent=1) + ';\n')
