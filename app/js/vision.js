/* Dancing Saints: finds the mural in a camera frame.
 *
 * Uses ORB features (jsfeat) and a RANSAC homography, so it needs no server or
 * trained model. Each mural photo ("view") is a reference, and so is a close-up
 * tile around every face, so a phone held close to one or two saints still
 * finds them. Reference features are computed ahead of time by
 * tools/build_refs.py and loaded from data/refs.bin.
 *
 * Runs inside vision-worker.js; also loadable in Node for tests and the build. */
(function (root) {
  'use strict';
  var jsfeat = root.jsfeat;

  var MAX_FRAME_KP = 500;
  var MAX_HAMMING = 70;          // of 256 bits
  var RATIO = 0.8;
  var MIN_MATCHES = 10;
  var MIN_INLIERS = 12;
  var MAX_RANSAC_REFS = 12;      // RANSAC is slow: only try the best-matched references
  var MAX_RESULTS = 12;
  var NEAR = 12;                 // runner-up matches this close (per 400 ref px) are the same feature

  // Build-time settings (tools/build_refs.py)
  var BUILD = {
    view: { longSide: 1600, scales: [1, 0.7, 0.5, 0.35, 0.25, 0.18], maxKp: 350 },
    // flat views made from the rotunda panorama (soft, so finer scales are skipped)
    pano: { longSide: 1400, scales: [0.8, 0.6, 0.45, 0.33, 0.25], maxKp: 300,
      tilts: [[90, 1.6], [0, 1.5]], tiltScales: [0.6, 0.4] },
    tile: { longSide: 512, scales: [1.4, 1, 0.7, 0.5, 0.35], maxKp: 250 },
    portrait: { longSide: 512, scales: [1.4, 1, 0.7, 0.5], maxKp: 160,
      // simulated oblique views: [direction of squeeze in degrees, squeeze factor]
      // 90 = looking up at the wall (the usual case), 0 = from the side
      tilts: [[90, 1.8], [0, 1.6]], tiltScales: [1, 0.6] }
  };

  var u_max = new Int32Array([15, 15, 15, 15, 14, 14, 14, 13, 13, 12, 11, 10, 9, 8, 6, 3, 0]);

  function icAngle(img, px, py) {
    var half = 15, m01 = 0, m10 = 0, src = img.data, step = img.cols;
    var c = (py * step + px) | 0, u, v, d, vs, a, b;
    for (u = -half; u <= half; ++u) m10 += u * src[c + u];
    for (v = 1; v <= half; ++v) {
      vs = 0; d = u_max[v];
      for (u = -d; u <= d; ++u) {
        a = src[c + u + v * step]; b = src[c + u - v * step];
        vs += a - b; m10 += u * (a + b);
      }
      m01 += v * vs;
    }
    return Math.atan2(m01, m10);
  }

  // 5-tap binomial blur (1 4 6 4 1), separable. Much faster than jsfeat's gaussian_blur on U8.
  var blurTmp = null;
  function blur5(src) {
    var w = src.cols, h = src.rows, s = src.data, n = w * h;
    var out = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t), d = out.data;
    if (!blurTmp || blurTmp.length < n) blurTmp = new Uint16Array(n);
    var t = blurTmp, x, y, o;
    for (y = 0; y < h; y++) {
      o = y * w;
      for (x = 0; x < w; x++) {
        var xm2 = x < 2 ? 0 : x - 2, xm1 = x < 1 ? 0 : x - 1, xp1 = x + 1 < w ? x + 1 : w - 1, xp2 = x + 2 < w ? x + 2 : w - 1;
        t[o + x] = s[o + xm2] + 4 * s[o + xm1] + 6 * s[o + x] + 4 * s[o + xp1] + s[o + xp2];
      }
    }
    for (y = 0; y < h; y++) {
      var r2 = (y < 2 ? 0 : y - 2) * w, r1 = (y < 1 ? 0 : y - 1) * w, r0 = y * w,
          q1 = (y + 1 < h ? y + 1 : h - 1) * w, q2 = (y + 2 < h ? y + 2 : h - 1) * w;
      for (x = 0; x < w; x++) d[r0 + x] = (t[r2 + x] + 4 * t[r1 + x] + 6 * t[r0 + x] + 4 * t[q1 + x] + t[q2 + x] + 128) >> 8;
    }
    return out;
  }

  // Detect keypoints and ORB descriptors on a U8 grayscale matrix.
  var cornerBuf = [];
  function features(gray, maxN) {
    var w = gray.cols, h = gray.rows;
    var blur = blur5(gray);
    while (cornerBuf.length < w * h / 4) cornerBuf.push(new jsfeat.keypoint_t(0, 0, 0, 0, -1));
    jsfeat.yape06.laplacian_threshold = 25;
    jsfeat.yape06.min_eigen_value_threshold = 20;
    var n = jsfeat.yape06.detect(blur, cornerBuf, 17);
    var kp = cornerBuf.slice(0, n).sort(function (a, b) { return b.score - a.score; }).slice(0, maxN)
      .map(function (k) { return new jsfeat.keypoint_t(k.x, k.y, k.score, k.level, -1); });
    for (var i = 0; i < kp.length; i++) kp[i].angle = icAngle(gray, kp[i].x, kp[i].y);
    var desc = new jsfeat.matrix_t(32, kp.length, jsfeat.U8_t | jsfeat.C1_t);
    if (kp.length) jsfeat.orb.describe(blur, kp, kp.length, desc);
    var d32 = new Int32Array(kp.length * 8);
    new Uint8Array(d32.buffer).set(desc.data.subarray(0, kp.length * 32));
    return { kp: kp.map(function (k) { return { x: k.x, y: k.y }; }), desc: d32 };
  }

  function toGray(rgba, w, h) {
    var m = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    jsfeat.imgproc.grayscale(rgba, w, h, m, jsfeat.COLOR_RGBA2GRAY);
    return m;
  }

  function resize(gray, nw, nh) {
    var m = new jsfeat.matrix_t(nw, nh, jsfeat.U8_t | jsfeat.C1_t);
    if (nw === gray.cols && nh === gray.rows) { m.data.set(gray.data.subarray(0, nw * nh)); return m; }
    if (nw <= gray.cols && nh <= gray.rows) { jsfeat.imgproc.resample(gray, m, nw, nh); return m; }
    // bilinear upscale (jsfeat's resample only shrinks)
    var sw = gray.cols, sh = gray.rows, s = gray.data, d = m.data;
    var fx = (sw - 1) / Math.max(1, nw - 1), fy = (sh - 1) / Math.max(1, nh - 1);
    for (var y = 0; y < nh; y++) {
      var sy = y * fy, y0 = sy | 0, y1 = Math.min(y0 + 1, sh - 1), wy = sy - y0;
      for (var x = 0; x < nw; x++) {
        var sx = x * fx, x0 = sx | 0, x1 = Math.min(x0 + 1, sw - 1), wx = sx - x0;
        var a = s[y0 * sw + x0] + (s[y0 * sw + x1] - s[y0 * sw + x0]) * wx;
        var b = s[y1 * sw + x0] + (s[y1 * sw + x1] - s[y1 * sw + x0]) * wx;
        d[y * nw + x] = (a + (b - a) * wy + 0.5) | 0;
      }
    }
    return m;
  }

  function popcnt(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  }

  // Build step: features of one reference image over a scale pyramid.
  // Returns {kp: [{x, y}] in the image's own pixels, desc: Int32Array}.
  function extract(grayData, w, h, kind) {
    var cfg = BUILD[kind || 'view'];
    var orig = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    orig.data.set(grayData.subarray(0, w * h));
    var k = cfg.longSide / Math.max(w, h);
    var bw = Math.round(w * k), bh = Math.round(h * k);
    var base = resize(orig, bw, bh), kps = [], parts = [];
    cfg.scales.forEach(function (s) {
      var sw = Math.round(bw * s), sh = Math.round(bh * s);
      if (sw < 80 || sh < 80) return;
      var f = features(s === 1 ? base : resize(base, sw, sh), cfg.maxKp);
      f.kp.forEach(function (p) { kps.push({ x: p.x / s / k, y: p.y / s / k }); });
      parts.push(f.desc);
    });
    (cfg.tilts || []).forEach(function (tl) {
      var v = tiltView(base, tl[0], tl[1]), A = v.inv;
      cfg.tiltScales.forEach(function (s) {
        var sw = Math.round(v.img.cols * s), sh = Math.round(v.img.rows * s);
        if (sw < 80 || sh < 80) return;
        var f = features(s === 1 ? v.img : resize(v.img, sw, sh), cfg.maxKp);
        f.kp.forEach(function (p) {
          var x = p.x / s, y = p.y / s;
          kps.push({ x: (A[0] * x + A[1] * y + A[2]) / k, y: (A[3] * x + A[4] * y + A[5]) / k });
        });
        parts.push(f.desc);
      });
    });
    var desc = new Int32Array(kps.length * 8), off = 0;
    parts.forEach(function (p) { desc.set(p, off); off += p.length; });
    return { kp: kps, desc: desc };
  }

  // Simulate viewing a reference obliquely: squeeze it by 1/t along direction ang (degrees).
  // Returns the warped image and the affine map from warped pixels back to the original.
  function tiltView(src, ang, t) {
    var a = ang * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), w = src.cols, h = src.rows;
    var M = [c * c / t + sn * sn, c * sn - c * sn / t, 0, c * sn - c * sn / t, sn * sn / t + c * c, 0];
    var cx = [0, w, w, 0], cy = [0, 0, h, h];
    var xs = cx.map(function (x, i) { return M[0] * x + M[1] * cy[i]; });
    var ys = cx.map(function (x, i) { return M[3] * x + M[4] * cy[i]; });
    var mx = Math.min.apply(0, xs), my = Math.min.apply(0, ys);
    M[2] = -mx; M[5] = -my;
    var nw = Math.ceil(Math.max.apply(0, xs) - mx), nh = Math.ceil(Math.max.apply(0, ys) - my);
    var det = M[0] * M[4] - M[1] * M[3];
    var I = [M[4] / det, -M[1] / det, 0, -M[3] / det, M[0] / det, 0];
    I[2] = -(I[0] * M[2] + I[1] * M[5]); I[5] = -(I[3] * M[2] + I[4] * M[5]);
    var out = new jsfeat.matrix_t(nw, nh, jsfeat.U8_t | jsfeat.C1_t), d = out.data, sd = src.data;
    for (var y = 0; y < nh; y++) for (var x = 0; x < nw; x++) {
      var sx = I[0] * x + I[1] * y + I[2], sy = I[3] * x + I[4] * y + I[5];
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { d[y * nw + x] = 0; continue; }
      var x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, o = y0 * w + x0;
      var top = sd[o] + (sd[o + 1] - sd[o]) * fx, bot = sd[o + w] + (sd[o + w + 1] - sd[o + w]) * fx;
      d[y * nw + x] = (top + (bot - top) * fy + 0.5) | 0;
    }
    return { img: out, inv: I };
  }

  // ---- reference library ----
  // refs: {id (view id), w, h (view px), a, ox, oy (tile px -> view px), start, end, scale}
  var refs = [];
  var refX = null, refY = null, refOf = null; // per keypoint, in the reference's own pixels
  var refDesc = null;                           // Int32Array, 8 ints per keypoint

  // Load references packed by tools/build_refs.py.
  // meta: [{view, w, h, a, ox, oy, n}] in file order; buf: ArrayBuffer (desc, then x/y floats).
  function loadPacked(meta, buf) {
    var total = meta.reduce(function (s, m) { return s + m.n; }, 0);
    refDesc = new Int32Array(buf, 0, total * 8);
    var xy = new Float32Array(buf, total * 32, total * 2);
    refX = new Float32Array(total); refY = new Float32Array(total); refOf = new Uint16Array(total);
    var start = 0;
    refs = meta.map(function (m, i) {
      for (var j = start; j < start + m.n; j++) { refX[j] = xy[2 * j]; refY[j] = xy[2 * j + 1]; refOf[j] = i; }
      var r = { id: m.view, w: m.tw || m.w, h: m.th || m.h, vw: m.w, vh: m.h, a: m.a || 1, ox: m.ox || 0, oy: m.oy || 0,
        start: start, end: start + m.n };
      start += m.n;
      return r;
    });
    lsh = null;
    return total;
  }

  // ---- locality-sensitive hash index over the reference descriptors ----
  // Each table keys a descriptor by LSH_BITS chosen bits; a frame descriptor is compared only
  // with references that share a key in some table, or differ from it in one of those bits.
  var LSH_TABLES = 10, LSH_BITS = 14;
  var lsh = null;
  function lshKey(desc, o, bits) {
    var k = 0;
    for (var b = 0; b < bits.length; b++) k = (k << 1) | ((desc[o + (bits[b] >> 5)] >>> (bits[b] & 31)) & 1);
    return k;
  }
  function buildIndex() {
    var n = refOf.length, seed = 12345;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var tables = [];
    for (var t = 0; t < LSH_TABLES; t++) {
      var bits = [];
      while (bits.length < LSH_BITS) { var b = (rnd() * 256) | 0; if (bits.indexOf(b) < 0) bits.push(b); }
      var size = 1 << LSH_BITS, count = new Int32Array(size + 1), keys = new Int32Array(n), i;
      for (i = 0; i < n; i++) { keys[i] = lshKey(refDesc, i * 8, bits); count[keys[i] + 1]++; }
      for (i = 0; i < size; i++) count[i + 1] += count[i];
      var fill = count.slice(0, size), items = new Int32Array(n);
      for (i = 0; i < n; i++) items[fill[keys[i]]++] = i;
      tables.push({ bits: bits, start: count, items: items });
    }
    lsh = { tables: tables, stamp: new Int32Array(n), gen: 0, cand: new Int32Array(n) };
  }
  function candidates(desc, o) {
    if (!lsh) buildIndex();
    var gen = ++lsh.gen, stamp = lsh.stamp, out = lsh.cand, len = 0;
    for (var t = 0; t < lsh.tables.length; t++) {
      var T = lsh.tables[t], key = lshKey(desc, o, T.bits);
      for (var p = -1; p < LSH_BITS; p++) {
        var kk = p < 0 ? key : key ^ (1 << p);
        for (var a = T.start[kk], e = T.start[kk + 1]; a < e; a++) {
          var j = T.items[a];
          if (stamp[j] !== gen) { stamp[j] = gen; out[len++] = j; }
        }
      }
    }
    return len;
  }

  function project(H, x, y) {
    var z = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / z, y: (H[3] * x + H[4] * y + H[5]) / z };
  }

  function quadArea(p) {
    var a = 0;
    for (var i = 0; i < 4; i++) { var j = (i + 1) % 4; a += p[i].x * p[j].y - p[j].x * p[i].y; }
    return a / 2;
  }

  function isConvex(p) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
      var cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cr === 0) return false;
      if (!sign) sign = cr > 0 ? 1 : -1; else if ((cr > 0 ? 1 : -1) !== sign) return false;
    }
    return true;
  }

  // ---- homography by RANSAC ----
  // Solves h (with h33 = 1) from point pairs by least squares on the 8x8 normal equations.
  // (jsfeat's version runs an eigen decomposition per hypothesis, which was most of the frame time.)
  var ATA = new Float64Array(64), ATb = new Float64Array(8);
  function solveH(from, to, idx, n) {
    ATA.fill(0); ATb.fill(0);
    var r = [0, 0, 0, 0, 0, 0, 0, 0], i, j, k;
    for (k = 0; k < n; k++) {
      var p = from[idx ? idx[k] : k], q = to[idx ? idx[k] : k], x = p.x, y = p.y, u = q.x, v = q.y;
      for (var row = 0; row < 2; row++) {
        if (row === 0) { r[0] = x; r[1] = y; r[2] = 1; r[3] = 0; r[4] = 0; r[5] = 0; r[6] = -u * x; r[7] = -u * y; }
        else { r[0] = 0; r[1] = 0; r[2] = 0; r[3] = x; r[4] = y; r[5] = 1; r[6] = -v * x; r[7] = -v * y; }
        var b = row === 0 ? u : v;
        for (i = 0; i < 8; i++) { if (!r[i]) continue; ATb[i] += r[i] * b; for (j = 0; j < 8; j++) ATA[i * 8 + j] += r[i] * r[j]; }
      }
    }
    // Gaussian elimination with partial pivoting
    for (i = 0; i < 8; i++) {
      var piv = i, best = Math.abs(ATA[i * 8 + i]);
      for (k = i + 1; k < 8; k++) if (Math.abs(ATA[k * 8 + i]) > best) { best = Math.abs(ATA[k * 8 + i]); piv = k; }
      if (best < 1e-12) return null;
      if (piv !== i) {
        for (j = 0; j < 8; j++) { var t = ATA[i * 8 + j]; ATA[i * 8 + j] = ATA[piv * 8 + j]; ATA[piv * 8 + j] = t; }
        var tb = ATb[i]; ATb[i] = ATb[piv]; ATb[piv] = tb;
      }
      for (k = i + 1; k < 8; k++) {
        var f = ATA[k * 8 + i] / ATA[i * 8 + i];
        if (!f) continue;
        for (j = i; j < 8; j++) ATA[k * 8 + j] -= f * ATA[i * 8 + j];
        ATb[k] -= f * ATb[i];
      }
    }
    var h = new Array(9); h[8] = 1;
    for (i = 7; i >= 0; i--) {
      var sum = ATb[i];
      for (j = i + 1; j < 8; j++) sum -= ATA[i * 8 + j] * h[j];
      h[i] = sum / ATA[i * 8 + i];
    }
    for (i = 0; i < 8; i++) if (!isFinite(h[i])) return null;
    return h;
  }
  // Points are normalized (centered, unit scale) so the least-squares solve stays well conditioned.
  function normalizer(pts) {
    var mx = 0, my = 0, d = 0, n = pts.length, i;
    for (i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) d += Math.hypot(pts[i].x - mx, pts[i].y - my);
    var s = d ? Math.SQRT2 * n / d : 1;
    return { s: s, mx: mx, my: my, pts: pts.map(function (p) { return { x: (p.x - mx) * s, y: (p.y - my) * s }; }) };
  }
  var RANSAC_ITERS = 300, RANSAC_PX = 4;
  function ransacHomography(from, to) {
    var n = from.length; if (n < 4) return null;
    var A = normalizer(from), B = normalizer(to);
    var thr = RANSAC_PX * B.s, thr2 = thr * thr;
    var bestCount = 0, bestMask = null, mask = new Uint8Array(n), idx = [0, 0, 0, 0], seed = 7 + n;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
    function score(h, out) {
      var c = 0;
      for (var k = 0; k < n; k++) {
        var p = A.pts[k], z = h[6] * p.x + h[7] * p.y + h[8];
        var u = (h[0] * p.x + h[1] * p.y + h[2]) / z - B.pts[k].x, v = (h[3] * p.x + h[4] * p.y + h[5]) / z - B.pts[k].y;
        var ok = z > 0 && u * u + v * v < thr2; out[k] = ok ? 1 : 0; c += out[k];
      }
      return c;
    }
    var iters = RANSAC_ITERS;
    for (var it = 0; it < iters; it++) {
      for (var a = 0; a < 4; a++) { var r; do { r = rnd(); } while (idx.slice(0, a).indexOf(r) >= 0); idx[a] = r; }
      var hs = solveH(A.pts, B.pts, idx, 4);
      if (!hs) continue;
      var c = score(hs, mask);
      if (c > bestCount) {
        bestCount = c; bestMask = mask.slice();
        var w = c / n, need = Math.log(0.005) / Math.log(1 - w * w * w * w);
        if (need < iters) iters = Math.max(20, Math.ceil(need));
      }
    }
    if (bestCount < 4) return null;
    // refine on all inliers; keep the refined fit unless it explains fewer points
    var inl = []; for (var k = 0; k < n; k++) if (bestMask[k]) inl.push(k);
    var h = solveH(A.pts, B.pts, inl, inl.length);
    if (!h) return null;
    var refined = new Uint8Array(n);
    if (score(h, refined) >= bestCount) bestMask = refined;
    // undo normalization: H = inv(TB) * h * TA
    var sa = A.s, sb = B.s;
    var TA = [sa, 0, -sa * A.mx, 0, sa, -sa * A.my, 0, 0, 1];
    var TBi = [1 / sb, 0, B.mx, 0, 1 / sb, B.my, 0, 0, 1];
    var H = mul3(TBi, mul3(h, TA)); var z = H[8];
    for (k = 0; k < 9; k++) H[k] /= z;
    return { H: H, mask: bestMask };
  }
  function mul3(a, b) {
    var r = new Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  }

  // Find mural views in a frame. Returns [{id (view), H (view px -> frame px), inliers}].
  // onlyIds (optional): search just these views, for speed while tracking.
  function findInFrame(rgba, w, h, onlyIds) {
    if (!refDesc || !refDesc.length) return [];
    var f = features(toGray(rgba, w, h), MAX_FRAME_KP);
    var nref = refs.length, useRef = new Uint8Array(nref), nearOf = new Float32Array(nref);
    refs.forEach(function (r, ri) {
      if (!onlyIds || onlyIds.indexOf(r.id) >= 0) useRef[ri] = 1;
      nearOf[ri] = NEAR * Math.max(r.w, r.h) / 400;
    });
    // Ratio test per reference, ignoring a runner-up at nearly the same spot in that reference
    // (the same feature found at two pyramid levels).
    var best = new Int32Array(nref), second = new Int32Array(nref), bi = new Int32Array(nref),
        bx = new Float32Array(nref), by = new Float32Array(nref), touched = [], byRef = {}, g, i;
    for (i = 0; i < f.kp.length; i++) {
      var o = i * 8;
      var d0 = f.desc[o], d1 = f.desc[o + 1], d2 = f.desc[o + 2], d3 = f.desc[o + 3],
          d4 = f.desc[o + 4], d5 = f.desc[o + 5], d6 = f.desc[o + 6], d7 = f.desc[o + 7];
      var nc = candidates(f.desc, o), cand = lsh.cand;
      touched.length = 0;
      for (var c = 0; c < nc; c++) {
        var j = cand[c];
        g = refOf[j];
        if (!useRef[g]) continue;
        if (bi[g] === 0) { bi[g] = -1; best[g] = 999; second[g] = 999; touched.push(g); }
        var r = j * 8;
        var dist = popcnt(d0 ^ refDesc[r]) + popcnt(d1 ^ refDesc[r + 1]) + popcnt(d2 ^ refDesc[r + 2]) +
          popcnt(d3 ^ refDesc[r + 3]);
        if (dist >= second[g]) continue;
        dist += popcnt(d4 ^ refDesc[r + 4]) + popcnt(d5 ^ refDesc[r + 5]) + popcnt(d6 ^ refDesc[r + 6]) +
          popcnt(d7 ^ refDesc[r + 7]);
        if (dist >= second[g]) continue;
        var qx = refX[j], qy = refY[j];
        var same = bi[g] > 0 && Math.abs(qx - bx[g]) < nearOf[g] && Math.abs(qy - by[g]) < nearOf[g];
        if (dist < best[g]) {
          if (!same) second[g] = best[g];
          best[g] = dist; bi[g] = j + 1; bx[g] = qx; by[g] = qy;
        } else if (!same) second[g] = dist;
      }
      for (var tg = 0; tg < touched.length; tg++) {
        g = touched[tg];
        if (bi[g] > 0 && best[g] <= MAX_HAMMING && best[g] < RATIO * second[g]) {
          var k = bi[g] - 1;
          (byRef[g] = byRef[g] || []).push({ from: { x: refX[k], y: refY[k] }, to: f.kp[i] });
        }
        bi[g] = 0;
      }
    }

    var byView = {};
    Object.keys(byRef).filter(function (ri) { return byRef[ri].length >= MIN_MATCHES; })
      .sort(function (a, b) { return byRef[b].length - byRef[a].length; }).slice(0, MAX_RANSAC_REFS)
      .forEach(function (ri) {
        var m = byRef[ri], ref = refs[ri];
        var from = m.map(function (p) { return p.from; }), to = m.map(function (p) { return p.to; });
        var fit = ransacHomography(from, to);
        if (!fit) return;
        var mask = { data: fit.mask };
        var inl = 0, k, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (k = 0; k < m.length; k++) if (mask.data[k]) {
          inl++;
          var q = from[k];
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
        }
        if (inl < MIN_INLIERS || inl < m.length * 0.25) return;
        var H = fit.H;
        // Sanity-check the mapping on the matched part of the reference (in an angled
        // close-up the rest of the view can legitimately fold behind the camera).
        var corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (k = 0; k < 4; k++) if (H[6] * corners[k][0] + H[7] * corners[k][1] + H[8] <= 0) return;
        var quad = corners.map(function (p) { return project(H, p[0], p[1]); });
        if (!isConvex(quad)) return;
        var area = Math.abs(quadArea(quad));
        if (area < w * h * 0.01 || area > w * h * 4) return;
        // tile px -> view px: X = a*x + ox, so view -> frame is H * inv(A)
        var a = ref.a, ox = ref.ox, oy = ref.oy;
        if (a !== 1 || ox || oy) H = [H[0] / a, H[1] / a, H[2] - (H[0] * ox + H[1] * oy) / a,
          H[3] / a, H[4] / a, H[5] - (H[3] * ox + H[4] * oy) / a,
          H[6] / a, H[7] / a, H[8] - (H[6] * ox + H[7] * oy) / a];
        var prev = byView[ref.id];
        if (!prev || inl > prev.inliers) byView[ref.id] = { id: ref.id, H: H, inliers: inl, matches: m.length };
      });
    var results = Object.keys(byView).map(function (id) { return byView[id]; });
    results.sort(function (a, b) { return b.inliers - a.inliers; });
    return results.slice(0, MAX_RESULTS);
  }

  var api = { extract: extract, loadPacked: loadPacked, findInFrame: findInFrame, project: project, BUILD: BUILD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vision = api;
})(typeof self !== 'undefined' ? self : this);
