// Computes ORB features for build_refs.py with the app's own vision.js and packs them.
const fs = require('fs'), path = require('path');
global.self = global; global.window = global;
eval(fs.readFileSync(path.join(__dirname, '../app/vendor/jsfeat-min.js'), 'utf8'));
global.jsfeat = global.jsfeat || jsfeat;
const V = require('../app/js/vision.js');
const jobs = JSON.parse(fs.readFileSync(process.argv[2]));
const descs = [], xys = [], meta = [];
for (const j of jobs) {
  const f = V.extract(new Uint8Array(fs.readFileSync(j.file)), j.gw, j.gh, j.kind);
  const xy = new Float32Array(f.kp.length * 2);
  f.kp.forEach((p, i) => { xy[2 * i] = p.x; xy[2 * i + 1] = p.y; });
  descs.push(f.desc); xys.push(xy);
  const m = { view: j.view, w: j.w, h: j.h, n: f.kp.length };
  if (j.kind === 'tile') Object.assign(m, { tw: j.tw, th: j.th, a: j.a, ox: j.ox, oy: j.oy });
  meta.push(m);
}
const bufs = descs.map(d => Buffer.from(d.buffer)).concat(xys.map(x => Buffer.from(x.buffer)));
fs.writeFileSync(process.argv[3], Buffer.concat(bufs));
process.stdout.write(JSON.stringify(meta));
