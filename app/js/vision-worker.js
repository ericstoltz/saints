/* Runs the mural matcher off the main thread. */
self.window = self;
importScripts('../vendor/jsfeat-min.js', 'vision.js');

self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'refs') {
    fetch(m.url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var n = Vision.loadPacked(m.meta, buf);
      self.postMessage({ type: 'refs-ok', keypoints: n });
    }).catch(function (err) {
      self.postMessage({ type: 'refs-error', error: String(err) });
    });
  } else if (m.type === 'frame') {
    var t0 = Date.now(), results = [];
    try { results = Vision.findInFrame(new Uint8ClampedArray(m.rgba), m.w, m.h, m.only); } catch (err) { /* skip frame */ }
    self.postMessage({ type: 'result', results: results, w: m.w, h: m.h, ms: Date.now() - t0, rgba: m.rgba }, [m.rgba]);
  }
};
