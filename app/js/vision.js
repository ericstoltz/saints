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
  var MAX_RANSAC_REFS = 4;       // RANSAC is slow: only try the best-matched references
  var NEAR = 12;                 // runner-up matches this close (per 400 ref px) are the same feature

  // Build-time settings (tools/build_refs.py)
  var BUILD = {
    view: { longSide: 1600, scales: [1, 0.7, 0.5, 0.35, 0.25, 0.18], maxKp: 350 },
    tile: { longSide: 512, scales: [1.4, 1, 0.7, 0.5, 0.35], maxKp: 250 }
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
    var desc = new Int32Array(kps.length * 8), off = 0;
    parts.forEach(function (p) { desc.set(p, off); off += p.length; });
    return { kp: kps, desc: desc };
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
        var model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
        var mask = new jsfeat.matrix_t(m.length, 1, jsfeat.U8_t | jsfeat.C1_t);
        var params = new jsfeat.ransac_params_t(4, 4, 0.5, 0.995);
        var ok = jsfeat.motion_estimator.ransac(params, new jsfeat.motion_model.homography2d(),
          from, to, m.length, model, mask, 1000);
        if (!ok) return;
        var inl = 0, k, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (k = 0; k < m.length; k++) if (mask.data[k]) {
          inl++;
          var q = from[k];
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
        }
        if (inl < MIN_INLIERS || inl < m.length * 0.25) return;
        var H = Array.prototype.slice.call(model.data, 0, 9);
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
    return results.slice(0, 2);
  }

  var api = { extract: extract, loadPacked: loadPacked, findInFrame: findInFrame, project: project, BUILD: BUILD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vision = api;
})(typeof self !== 'undefined' ? self : this);
