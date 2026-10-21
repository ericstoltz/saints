/* Dancing Saints: finds known mural photos in a camera frame.
 *
 * Uses ORB features (jsfeat) and a RANSAC homography, so it works on any
 * flat-ish painted surface and needs no server or trained model.
 * Runs inside vision-worker.js; also loadable in Node for tests. */
(function (root) {
  'use strict';
  var jsfeat = root.jsfeat;

  var MAX_FRAME_KP = 500;
  var MAX_REF_KP = 350;          // per pyramid level
  var REF_LONG_SIDE = 1000;       // references are normalized to this size
  var REF_SCALES = [1, 0.7, 0.5, 0.35, 0.25];
  var MAX_HAMMING = 70;          // of 256 bits
  var RATIO = 0.8;
  var MIN_MATCHES = 10;
  var MIN_INLIERS = 12;

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

  // Detect keypoints and ORB descriptors on a U8 grayscale matrix.
  function features(gray, maxN) {
    var w = gray.cols, h = gray.rows;
    var blur = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    jsfeat.imgproc.gaussian_blur(gray, blur, 5, 0);
    var corners = [];
    for (var i = 0; i < w * h / 4; i++) corners.push(new jsfeat.keypoint_t(0, 0, 0, 0, -1));
    jsfeat.yape06.laplacian_threshold = 25;
    jsfeat.yape06.min_eigen_value_threshold = 20;
    var n = jsfeat.yape06.detect(blur, corners, 17);
    var kp = corners.slice(0, n).sort(function (a, b) { return b.score - a.score; }).slice(0, maxN);
    for (i = 0; i < kp.length; i++) kp[i].angle = icAngle(gray, kp[i].x, kp[i].y);
    var desc = new jsfeat.matrix_t(32, kp.length, jsfeat.U8_t | jsfeat.C1_t);
    if (kp.length) jsfeat.orb.describe(blur, kp, kp.length, desc);
    var d32 = new Int32Array(kp.length * 8);
    var u8 = new Uint8Array(d32.buffer);
    u8.set(desc.data.subarray(0, kp.length * 32));
    return { kp: kp.map(function (k) { return { x: k.x, y: k.y }; }), desc: d32 };
  }

  function toGray(rgba, w, h) {
    var m = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    jsfeat.imgproc.grayscale(rgba, w, h, m, jsfeat.COLOR_RGBA2GRAY);
    return m;
  }

  function resize(gray, nw, nh) {
    var m = new jsfeat.matrix_t(nw, nh, jsfeat.U8_t | jsfeat.C1_t);
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

  // ---- reference library ----
  var refs = [];      // {id, w, h}
  var refKp = [];     // flat list of {x, y, ref}
  var refDesc = null; // Int32Array, 8 ints per keypoint

  // gray: U8 array (w*h), coordinates are kept in the reference's own pixels.
  function addReference(id, grayData, w, h) {
    var orig = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    orig.data.set(grayData.subarray(0, w * h));
    var k = REF_LONG_SIDE / Math.max(w, h);
    var bw = Math.round(w * k), bh = Math.round(h * k);
    var base = resize(orig, bw, bh);
    var refIndex = refs.length;
    var start = refKp.length;
    refs.push({ id: id, w: w, h: h, start: start, end: start });
    var parts = [];
    REF_SCALES.forEach(function (s) {
      var sw = Math.round(bw * s), sh = Math.round(bh * s);
      if (sw < 80 || sh < 80) return;
      var img = s === 1 ? base : resize(base, sw, sh);
      var f = features(img, MAX_REF_KP);
      f.kp.forEach(function (p) { refKp.push({ x: p.x / s / k, y: p.y / s / k, ref: refIndex }); });
      parts.push(f.desc);
    });
    var total = (refDesc ? refDesc.length : 0) + parts.reduce(function (a, p) { return a + p.length; }, 0);
    var next = new Int32Array(total), off = 0;
    if (refDesc) { next.set(refDesc); off = refDesc.length; }
    parts.forEach(function (p) { next.set(p, off); off += p.length; });
    refDesc = next;
    refs[refIndex].end = refKp.length;
    return refKp.length;
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

  // Find references in a frame. Returns [{id, H (ref -> frame), inliers}].
  // onlyIds (optional): search just these references, for speed while tracking.
  function findInFrame(rgba, w, h, onlyIds) {
    if (!refDesc) return [];
    var f = features(toGray(rgba, w, h), MAX_FRAME_KP);
    var ranges = refs.filter(function (r) { return !onlyIds || onlyIds.indexOf(r.id) >= 0; })
      .map(function (r) { return [r.start, r.end]; });
    var byRef = {};
    for (var i = 0; i < f.kp.length; i++) {
      var o = i * 8, best = 999, second = 999, bi = -1;
      var d0 = f.desc[o], d1 = f.desc[o + 1], d2 = f.desc[o + 2], d3 = f.desc[o + 3],
          d4 = f.desc[o + 4], d5 = f.desc[o + 5], d6 = f.desc[o + 6], d7 = f.desc[o + 7];
      for (var g = 0; g < ranges.length; g++)
      for (var j = ranges[g][0], r = j * 8; j < ranges[g][1]; j++, r += 8) {
        var dist = popcnt(d0 ^ refDesc[r]) + popcnt(d1 ^ refDesc[r + 1]) + popcnt(d2 ^ refDesc[r + 2]) +
          popcnt(d3 ^ refDesc[r + 3]);
        if (dist >= second) continue;
        dist += popcnt(d4 ^ refDesc[r + 4]) + popcnt(d5 ^ refDesc[r + 5]) + popcnt(d6 ^ refDesc[r + 6]) +
          popcnt(d7 ^ refDesc[r + 7]);
        if (dist < best) { second = best; best = dist; bi = j; } else if (dist < second) second = dist;
      }
      if (bi >= 0 && best <= MAX_HAMMING && best < RATIO * second) {
        var rk = refKp[bi];
        (byRef[rk.ref] = byRef[rk.ref] || []).push({ from: { x: rk.x, y: rk.y }, to: f.kp[i] });
      }
    }
    var results = [];
    Object.keys(byRef).forEach(function (ri) {
      var m = byRef[ri];
      if (m.length < MIN_MATCHES) return;
      var from = m.map(function (p) { return p.from; }), to = m.map(function (p) { return p.to; });
      var model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
      var mask = new jsfeat.matrix_t(m.length, 1, jsfeat.U8_t | jsfeat.C1_t);
      var params = new jsfeat.ransac_params_t(4, 4, 0.5, 0.995);
      var ok = jsfeat.motion_estimator.ransac(params, new jsfeat.motion_model.homography2d(),
        from, to, m.length, model, mask, 1000);
      if (!ok) return;
      var inl = 0;
      for (var k = 0; k < m.length; k++) inl += mask.data[k];
      if (inl < MIN_INLIERS || inl < m.length * 0.25) return;
      var H = Array.prototype.slice.call(model.data, 0, 9);
      var ref = refs[ri];
      var quad = [project(H, 0, 0), project(H, ref.w, 0), project(H, ref.w, ref.h), project(H, 0, ref.h)];
      if (!isConvex(quad)) return;
      var area = Math.abs(quadArea(quad));
      if (area < w * h * 0.02 || area > w * h * 400) return;
      results.push({ id: ref.id, H: H, inliers: inl, matches: m.length });
    });
    results.sort(function (a, b) { return b.inliers - a.inliers; });
    return results.slice(0, 2);
  }

  var api = { addReference: addReference, findInFrame: findInFrame, project: project };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vision = api;
})(typeof self !== 'undefined' ? self : this);
