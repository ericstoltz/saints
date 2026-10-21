/* Runs the mural matcher off the main thread. */
self.window = self;
importScripts('../vendor/jsfeat-min.js', 'vision.js');

self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'ref') {
    var n = Vision.addReference(m.id, new Uint8Array(m.gray), m.w, m.h);
    self.postMessage({ type: 'ref-ok', id: m.id, keypoints: n });
  } else if (m.type === 'frame') {
    var t0 = Date.now(), results = [];
    try { results = Vision.findInFrame(new Uint8ClampedArray(m.rgba), m.w, m.h, m.only); } catch (err) { /* skip frame */ }
    self.postMessage({ type: 'result', results: results, w: m.w, h: m.h, ms: Date.now() - t0, rgba: m.rgba }, [m.rgba]);
  }
};
