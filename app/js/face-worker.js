/* Dancing Saints: finds painted faces in camera frames and names them by comparing each face
   with the saints' portraits. Runs off the main thread.
   Models: models/blazeface.onnx (face finder) and models/siglip.onnx (image embeddings),
   run with ONNX Runtime Web. Portrait embeddings and the mural layout come from data/faces.js
   (made by tools/build_faces.py). */
'use strict';
self.window = self;
importScripts('../vendor/ort/ort.wasm.min.js', '../data/faces.js' + self.location.search);
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

var V = self.location.search;
var det = null, enc = null, encLoading = null, P = null;   // P: portrait embeddings (Float32Array rows)
var F = self.FACES;

// ---------- face finder ----------
var G = 48, IN = 192;
var TILE = 192, STEP = 128, ROTS = [0, -25, 25], THRESH = 0.4;
var input = new Float32Array(3 * IN * IN);

function loadDetector() {
  return ort.InferenceSession.create('../models/blazeface.onnx' + V, { executionProviders: ['wasm'] })
    .then(function (s) { det = s; });
}

// Fill `input` (NCHW, -1..1) with a TILE x TILE square of the frame, rotated by ang degrees
// about the frame centre. (qx0, qy0) is the tile's corner in rotated coordinates.
function sampleTile(rgba, w, h, qx0, qy0, c, s) {
  var k = TILE / IN, cx = w / 2, cy = h / 2, plane = IN * IN;
  for (var v = 0; v < IN; v++) {
    for (var u = 0; u < IN; u++) {
      var qx = qx0 + (u + 0.5) * k, qy = qy0 + (v + 0.5) * k;
      var x = c * qx - s * qy + cx - 0.5, y = s * qx + c * qy + cy - 0.5;
      var o = v * IN + u, r = 0, g = 0, b = 0;
      if (x >= 0 && y >= 0 && x < w - 1 && y < h - 1) {
        var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
        var w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
        r = rgba[i] * w00 + rgba[i + 4] * w01 + rgba[j] * w10 + rgba[j + 4] * w11;
        g = rgba[i + 1] * w00 + rgba[i + 5] * w01 + rgba[j + 1] * w10 + rgba[j + 5] * w11;
        b = rgba[i + 2] * w00 + rgba[i + 6] * w01 + rgba[j + 2] * w10 + rgba[j + 6] * w11;
      }
      input[o] = r / 127.5 - 1; input[plane + o] = g / 127.5 - 1; input[2 * plane + o] = b / 127.5 - 1;
    }
  }
}

function detectFrame(rgba, w, h, rot) {
  var ang = ROTS[rot % ROTS.length] * Math.PI / 180, c = Math.cos(ang), s = Math.sin(ang);
  var RW = Math.abs(w * c) + Math.abs(h * s), RH = Math.abs(w * s) + Math.abs(h * c);
  var tiles = [];
  for (var ty = -RH / 2; ty < RH / 2 - TILE / 3; ty += STEP)
    for (var tx = -RW / 2; tx < RW / 2 - TILE / 3; tx += STEP) tiles.push([tx, ty]);
  var found = [], chain = Promise.resolve();
  tiles.forEach(function (t) {
    chain = chain.then(function () {
      sampleTile(rgba, w, h, t[0], t[1], c, s);
      var feeds = { input: new ort.Tensor('float32', input.slice(), [1, 3, IN, IN]) };
      return det.run(feeds).then(function (out) {
        var names = det.outputNames, reg = out[names[0]].data, cls = out[names[1]].data;
        if (out[names[0]].dims[2] !== 16) { var tmp = reg; reg = cls; cls = tmp; }
        for (var i = 0; i < G * G; i++) {
          var sc = 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, cls[i]))));
          if (sc < THRESH) continue;
          var ax = ((i % G) + 0.5) / G, ay = (((i / G) | 0) + 0.5) / G;
          var qx = t[0] + (reg[i * 16] / IN + ax) * TILE, qy = t[1] + (reg[i * 16 + 1] / IN + ay) * TILE;
          var fw = reg[i * 16 + 2] / IN * TILE;
          if (fw < 6) continue;
          found.push({ score: sc, x: c * qx - s * qy + w / 2, y: s * qx + c * qy + h / 2, w: fw });
        }
      });
    });
  });
  return chain.then(function () {
    return nms(found).filter(function (f) { return !tooBright(rgba, w, h, f); });
  });
}

// Chandelier bulbs look like round faces to the finder; painted faces are never this bright.
function tooBright(rgba, w, h, f) {
  var r = Math.max(2, f.w / 4), sum = 0, n = 0;
  for (var y = Math.max(0, f.y - r | 0); y < Math.min(h, f.y + r); y++)
    for (var x = Math.max(0, f.x - r | 0); x < Math.min(w, f.x + r); x++) {
      var i = (y * w + x) * 4; sum += 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2]; n++;
    }
  return n && sum / n > 200;
}

function nms(d) {
  d.sort(function (a, b) { return b.score - a.score; });
  var keep = [];
  d.forEach(function (a) {
    if (keep.every(function (k) { return Math.hypot(a.x - k.x, a.y - k.y) > 0.5 * Math.max(a.w, k.w); })) keep.push(a);
  });
  return keep;
}

// ---------- naming ----------
function loadEncoder() {
  if (encLoading) return encLoading;
  encLoading = Promise.all([
    ort.InferenceSession.create('../models/siglip.onnx' + V, { executionProviders: ['wasm'] }),
    fetch('../' + F.file + V).then(function (r) { if (!r.ok) throw new Error('faces.bin'); return r.arrayBuffer(); })
  ]).then(function (res) {
    enc = res[0]; P = halfToFloat(new Uint16Array(res[1]));
  });
  return encLoading;
}

function halfToFloat(h) {
  var out = new Float32Array(h.length);
  for (var i = 0; i < h.length; i++) {
    var x = h[i], s = x & 0x8000 ? -1 : 1, e = (x >> 10) & 0x1f, m = x & 0x3ff;
    out[i] = e === 0 ? s * m * Math.pow(2, -24) : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15);
  }
  return out;
}

// saint ids in a fixed order, and for each the rows of P that belong to it
var SAINTS = [], ROWS = {};
F.rows.forEach(function (id, r) { if (!ROWS[id]) { ROWS[id] = []; SAINTS.push(id); } ROWS[id].push(r); });

function embed(crops) {   // crops: array of Uint8ClampedArray RGBA (size x size)
  var n = crops.length, S = F.crop.size, x = new Float32Array(n * S * S * 3);
  crops.forEach(function (c, k) {
    for (var i = 0, o = k * S * S * 3; i < S * S; i++) { x[o++] = c[i * 4]; x[o++] = c[i * 4 + 1]; x[o++] = c[i * 4 + 2]; }
  });
  return enc.run({ pixels: new ort.Tensor('float32', x, [n, S, S, 3]) }).then(function (out) {
    return out[enc.outputNames[0]].data;
  });
}

// similarity of each face to each saint: best over that saint's portrait copies
function scoreAll(E, n) {
  var D = F.dim, B = [];
  for (var k = 0; k < n; k++) {
    var row = new Float32Array(SAINTS.length);
    SAINTS.forEach(function (id, a) {
      var best = -2;
      ROWS[id].forEach(function (r) {
        var dot = 0, po = r * D, eo = k * D;
        for (var d = 0; d < D; d++) dot += E[eo + d] * P[po + d];
        if (dot > best) best = dot;
      });
      row[a] = best;
    });
    B.push(row);
  }
  return B;
}

// Is face b's layout position where the frame says it should be, relative to face a?
function compat(a, b, v) {
  var la = F.layout[SAINTS[a]], lb = F.layout[SAINTS[b]];
  if (!la || !lb) return 0;
  var ux = lb[0] - la[0], uy = lb[1] - la[1], W = F.layoutWidth;
  ux = ((ux + W / 2) % W + W) % W - W / 2;
  var lu = Math.hypot(ux, uy), lv = Math.hypot(v[0], v[1]);
  if (lu < 1 || lv < 1) return 0;
  var r = lu / lv, cos = (ux * v[0] + uy * v[1]) / lu / lv;
  return r > 0.55 && r < 1.9 && cos > Math.cos(40 * Math.PI / 180) ? 1 : 0;
}

// Pick a name for every face so that names agree with the portraits and with who stands next
// to whom on the mural (iterated conditional modes).
function decode(faces, B) {
  var n = faces.length, LAM = 0.7, RAD = 4, TOPK = 10;
  var Z = B.map(function (row) {
    var m = 0, s = 0, i;
    for (i = 0; i < row.length; i++) m += row[i];
    m /= row.length;
    for (i = 0; i < row.length; i++) s += (row[i] - m) * (row[i] - m);
    s = Math.sqrt(s / row.length) || 1;
    return Array.prototype.map.call(row, function (x) { return (x - m) / s; });
  });
  var cand = Z.map(function (z) {
    return z.map(function (x, i) { return i; }).sort(function (a, b) { return z[b] - z[a]; }).slice(0, TOPK);
  });
  var nb = faces.map(function (f, i) {
    return faces.map(function (g, j) { return j; }).filter(function (j) {
      return j !== i && Math.hypot(faces[j].x - f.x, faces[j].y - f.y) < RAD * Math.max(f.w, faces[j].w);
    });
  });
  var s = cand.map(function (c) { return c[0]; });
  for (var it = 0; it < 6; it++) {
    var changed = false;
    for (var i = 0; i < n; i++) {
      var best = -1e9, arg = s[i];
      cand[i].forEach(function (a) {
        var e = Z[i][a];
        nb[i].forEach(function (j) {
          var k = F.faceInLayout / ((faces[i].w + faces[j].w) / 2);
          e += LAM * compat(a, s[j], [(faces[j].x - faces[i].x) * k, (faces[j].y - faces[i].y) * k]);
        });
        if (e > best) { best = e; arg = a; }
      });
      if (arg !== s[i]) { s[i] = arg; changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

function identify(m) {
  return loadEncoder().then(function () { return embed(m.crops); }).then(function (E) {
    var n = m.faces.length, B = scoreAll(E, n), s = decode(m.faces, B), b = B[0];
    var order = SAINTS.map(function (x, i) { return i; }).sort(function (x, y) { return b[y] - b[x]; });
    var pick = s[0], ranked = [pick].concat(order.filter(function (i) { return i !== pick; })).slice(0, 5);
    // sure when the neighbours agree with the best portrait match and it clearly beats the next one
    var sure = pick === order[0] && b[order[0]] - b[order[1]] >= 0.02;
    return { id: SAINTS[pick], sure: sure, ranked: ranked.map(function (i) { return { id: SAINTS[i], score: b[i] }; }) };
  });
}

// ---------- messages ----------
var ready = loadDetector().then(function () { postMessage({ type: 'face-ready' }); },
  function (e) { postMessage({ type: 'face-error', error: String(e) }); });

onmessage = function (e) {
  var m = e.data;
  if (m.type === 'detect') {
    ready.then(function () { return det ? detectFrame(new Uint8ClampedArray(m.rgba), m.w, m.h, m.rot || 0) : []; })
      .then(function (faces) { postMessage({ type: 'faces', faces: faces, w: m.w, rgba: m.rgba }, [m.rgba]); },
        function (err) { postMessage({ type: 'faces', faces: [], w: m.w, rgba: m.rgba, error: String(err) }, [m.rgba]); });
  } else if (m.type === 'warm') {
    loadEncoder().catch(function () {});
  } else if (m.type === 'identify') {
    identify(m).then(function (r) { r.type = 'identity'; r.token = m.token; postMessage(r); },
      function (err) { postMessage({ type: 'identity', token: m.token, error: String(err) }); });
  }
};
