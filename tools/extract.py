"""Extract saint profiles and photos from the brochure PDF.
Usage: python3 extract.py BROCHURE.pdf OUT_DIR
Writes OUT_DIR/data/saints.raw.json and OUT_DIR/img/saints/*.jpg"""
import sys, json, re, os
import pymupdf as fitz

src, out = sys.argv[1], sys.argv[2]
os.makedirs(f'{out}/img/saints', exist_ok=True)
os.makedirs(f'{out}/data', exist_ok=True)
doc = fitz.open(src)
COLS = [(30, 230), (230, 430), (430, 640)]

def col_of(x):
    for i, (a, b) in enumerate(COLS):
        if a <= x < b: return i

entries = []
for pno in range(7, 15):
    page = doc[pno]
    spans = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                if s['text'].strip() or s['text'] == ' ':
                    spans.append((s, l['bbox']))
    heads = [s for s, _ in spans if 'Bebas' in s['font'] and '•' in s['text']]
    # image cells: 2x2 grid per column, row-major
    cells = {}
    for info in page.get_image_info():
        x0, y0, x1, y1 = info['bbox']
        if x1 - x0 < 60: continue
        c = col_of((x0 + x1) / 2)
        key = (c, round(y0 / 40), round(x0 / 40))
        cells[key] = fitz.Rect(x0, y0, x1, y1)
    for c in range(3):
        ch = sorted([h for h in heads if col_of(h['bbox'][0]) == c], key=lambda h: h['bbox'][1])
        cc = sorted([r for k, r in cells.items() if k[0] == c], key=lambda r: (round(r.y0 / 40), r.x0))
        for i, h in enumerate(ch):
            y_start = h['bbox'][3]
            y_end = ch[i + 1]['bbox'][1] if i + 1 < len(ch) else 9999
            # body lines in this column, between headings
            lines = {}
            for s, lb in spans:
                if 'Bebas' in s['font']: continue
                x, y = s['bbox'][0], (s['bbox'][1] + s['bbox'][3]) / 2
                if col_of(x) == c and y_start - 1 < y < y_end and y < 520:
                    lines.setdefault(round(lb[1], 0), []).append(s)
            html = ''
            for k in sorted(lines):
                seg = ''
                for s in sorted(lines[k], key=lambda s: s['bbox'][0]):
                    t = s['text'].replace('&', '&amp;').replace('<', '&lt;')
                    if s['flags'] & 2 and t.strip():
                        seg += f'<em>{t}</em>'
                    else:
                        seg += t
                if html.endswith('-'):
                    html = html[:-1] + seg  # rejoin hyphenated line break
                else:
                    html = (html + ' ' + seg) if html else seg
            html = re.sub(r'</em>(\s*)<em>', r'\1', html)
            html = re.sub(r'\s+', ' ', html).strip()
            slug = None
            title = h['text']
            img = None
            if i < len(cc):
                r = cc[i]
                img = r
            entries.append({'heading': title, 'body': html, 'page': pno + 1,
                            'img_rect': list(img) if img else None})

# page 15 (index 14): 4 entries, one column, 2x2 grid above
print(len(entries))
json.dump(entries, open(f'{out}/data/saints.raw.json', 'w'), ensure_ascii=False, indent=1)
