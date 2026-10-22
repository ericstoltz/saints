/* Dancing Saints: live camera, face hotspots and the "Who is this?" flow. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var video = $('#cam-video'), freezeCanvas = $('#cam-freeze'), spotsLayer = $('#cam-spots');
  var statusEl = $('#cam-status'), bannerEl = $('#cam-banner'), loader = $('#cam-loading'), errorBox = $('#cam-error');
  var tray = $('#tray'), screen = $('#screen-camera');
  var walls = {};
  // Each mural view is a photo of one stretch of wall, with its faces marked (see tools/views.json).
  (window.MURAL ? MURAL.views : []).forEach(function (w) { w.refW = w.w; w.refH = w.h; walls[w.id] = w; });

  var stream = null, running = false, rafId = 0, worker = null, refsLoaded = false;
  var busy = false, frozen = false, frameNo = 0, lastFound = { ids: [], at: 0 };
  var spots = {};       // saint id -> {el, x, y, r, seen}
  var banner = { key: null, seen: 0 };
  var analysis = document.createElement('canvas');
  var actx = analysis.getContext('2d', { willReadFrequently: true });
  var spare = null;     // recycled frame buffer
  var selected = null;  // {id, x, y, r}
  // Face finder (js/face-worker.js): circles any painted face, and names it from the portraits on tap.
  var faceWorker = null, nameWorker = null, faceBusy = false, faceRound = 0, faceSpare = null, faceSeq = 0;
  // Each new circle is checked against the portraits before it shows (see verifyPending).
  var encReady = false, encFailed = false, verifyBusy = false, verifyToken = 0, verifyIds = [];
  var identity = null, identToken = 0, onIdentity = null;
  var faceCanvas = document.createElement('canvas'), fctx = faceCanvas.getContext('2d', { willReadFrequently: true });

  function t(k) { return DS.t(k); }

  // ---------- worker and references ----------
  // ?faces=only turns off the wall photos, to test recognition from the portraits alone.
  var facesOnly = /[?&]faces=only\b/.test(location.search);
  function initWorker() {
    if (facesOnly) { refsLoaded = true; return; }
    if (worker) return;
    worker = new Worker('js/vision-worker.js?v=' + CONFIG.version);
    worker.onmessage = onWorker;
    if (!window.MURAL) { refsLoaded = true; return; }
    worker.postMessage({ type: 'refs', meta: MURAL.refs, url: new URL(MURAL.refsFile + '?v=' + CONFIG.version, location.href).href });
  }
  function initFaceWorker() {
    if (faceWorker || typeof WebAssembly !== 'object') return;
    faceWorker = new Worker('js/face-worker.js?v=' + CONFIG.version + '&role=find');
    faceWorker.onmessage = onFaceWorker;
    nameWorker = new Worker('js/face-worker.js?v=' + CONFIG.version + '&role=name');
    nameWorker.onmessage = onFaceWorker;
    nameWorker.postMessage({ type: 'warm' });   // start fetching the naming model in the background
  }
  function onFaceWorker(e) {
    var m = e.data;
    if (m.type === 'faces') {
      faceBusy = false; faceSpare = m.rgba;
      if (running && !frozen) handleFaces(m.faces, m.w);
    } else if (m.type === 'encoder-ready') {
      encReady = true; verifyPending();
    } else if (m.type === 'encoder-error') {
      encFailed = true; updateStale();
    } else if (m.type === 'verified' && m.token === verifyToken) {
      verifyBusy = false;
      if (m.error) { encFailed = true; } else {
        verifyIds.forEach(function (id, i) {
          var sp = spots[id];
          if (sp) { sp.sim = m.sims[i]; sp.ok = m.sims[i] >= CONFIG.faceMinSim; }
        });
      }
      updateStale(); verifyPending();
    } else if (m.type === 'identity' && m.token === identToken) {
      identity = m.error ? { error: m.error } : m;
      if (onIdentity) { var f = onIdentity; onIdentity = null; f(); }
    }
  }
  function refDone() { refsLoaded = true; maybeReady(); }

  function onWorker(e) {
    var m = e.data;
    if (m.type === 'refs-ok' || m.type === 'refs-error') { refDone(); return; }
    if (m.type === 'result') {
      busy = false; spare = m.rgba;
      if (!running || frozen) return;
      handleResults(m.results, m.w);
    }
  }

  // ---------- camera ----------
  function start() {
    screen.hidden = false;
    if (running) return;
    running = true;
    errorBox.hidden = true;
    loader.hidden = false;
    setStatus('');
    initWorker();
    initFaceWorker();
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (s) {
      if (!running) { s.getTracks().forEach(function (tr) { tr.stop(); }); return; }
      stream = s; video.srcObject = s;
      return video.play();
    }).then(function () { maybeReady(); })
      .catch(function () { loader.hidden = true; errorBox.hidden = false; running = false; document.body.classList.remove('cam-live'); });
  }

  function maybeReady() {
    if (!running || !stream || !refsLoaded) return;
    loader.hidden = true;
    document.body.classList.add('cam-live');
    setStatus(t('cameraPoint'));
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    document.body.classList.remove('cam-live');
    cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); });
    stream = null; video.srcObject = null;
    unfreeze(true);
    clearSpots();
  }

  $('#cam-retry').addEventListener('click', function () { running = false; start(); });
  document.addEventListener('visibilitychange', function () {
    if (screen.hidden) return;
    if (document.hidden) stop(); else start();
  });

  function tick() {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    if (frozen || (busy && !facesOnly) || video.readyState < 2 || !video.videoWidth) return;
    if (facesOnly && faceBusy) return;
    var aw = CONFIG.analysisWidth, vw = video.videoWidth, vh = video.videoHeight;
    var ah = Math.round(vh * aw / vw);
    if (analysis.width !== aw || analysis.height !== ah) { analysis.width = aw; analysis.height = ah; }
    actx.drawImage(video, 0, 0, aw, ah);
    var img = actx.getImageData(0, 0, aw, ah);
    var buf = (spare && spare.byteLength === img.data.byteLength) ? spare : new ArrayBuffer(img.data.byteLength);
    new Uint8ClampedArray(buf).set(img.data);
    spare = null; frameNo++;
    // While a wall is in view, look mostly for that wall (faster); do a full search every few frames.
    var tracking = Date.now() - lastFound.at < 1000 && frameNo % 4 !== 0;
    if (!facesOnly) { busy = true; worker.postMessage({ type: 'frame', rgba: buf, w: aw, h: ah, only: tracking ? lastFound.ids : null }, [buf]); }
    if (faceWorker && !faceBusy) {
      // the face finder looks at a larger picture, since painted faces are small
      var fw = Math.min(CONFIG.faceAnalysisWidth || 640, vw), fh = Math.round(vh * fw / vw);
      if (faceCanvas.width !== fw || faceCanvas.height !== fh) { faceCanvas.width = fw; faceCanvas.height = fh; }
      fctx.drawImage(video, 0, 0, fw, fh);
      var fimg = fctx.getImageData(0, 0, fw, fh);
      var fb = (faceSpare && faceSpare.byteLength === fimg.data.byteLength) ? faceSpare : new ArrayBuffer(fimg.data.byteLength);
      new Uint8ClampedArray(fb).set(fimg.data);
      faceSpare = null; faceBusy = true;
      faceWorker.postMessage({ type: 'detect', rgba: fb, w: fw, h: fh, rot: faceRound++ }, [fb]);
    }
    updateStale();
  }

  // ---------- geometry ----------
  function project(H, x, y) {
    var z = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / z, y: (H[3] * x + H[4] * y + H[5]) / z };
  }
  // analysis-frame pixels -> screen pixels (video uses object-fit: cover)
  function toScreen(p, aw) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var cw = screen.clientWidth, ch = screen.clientHeight;
    var s = Math.max(cw / vw, ch / vh), k = vw / aw;
    return { x: p.x * k * s + (cw - vw * s) / 2, y: p.y * k * s + (ch - vh * s) / 2, scale: k * s };
  }

  function handleResults(results, aw) {
    var now = Date.now();
    var cw = screen.clientWidth, ch = screen.clientHeight;
    if (results.length) lastFound = { ids: results.map(function (r) { return r.id; }), at: now };
    results.forEach(function (r) {
      var wall = walls[r.id];
      if (!wall || !wall.refW) return;
      if (wall.banner) { banner = { key: wall.banner, seen: now }; }
      wall.hotspots.forEach(function (h) {
        var cx = h.x * wall.refW, cy = h.y * wall.refH, rr = (h.r || 0.04) * wall.refW * 2;
        var c = project(r.H, cx, cy), e = project(r.H, cx + rr, cy), e2 = project(r.H, cx, cy + rr);
        var sc = toScreen(c, aw);
        var rad = (Math.hypot(e.x - c.x, e.y - c.y) + Math.hypot(e2.x - c.x, e2.y - c.y)) / 2 * sc.scale;
        if (sc.x < -rad || sc.y < -rad || sc.x > cw + rad || sc.y > ch + rad || !isFinite(rad)) return;
        if (h.saint === 'jesus') { banner = { key: 'jesusBanner', seen: now }; return; }
        placeSpot(h.saint, sc.x, sc.y, Math.max(36, rad), now);
        dropFacesNear(sc.x, sc.y, Math.max(36, rad));
      });
    });
    updateStale();
  }

  // Faces from the face finder. A face already circled from a wall photo keeps that circle.
  // Each face keeps its circle from frame to frame by matching it to the nearest one.
  function handleFaces(faces, aw) {
    var now = Date.now();
    faces.forEach(function (f) {
      var sc = toScreen({ x: f.x, y: f.y }, aw), r = Math.max(36, f.w * 1.5 * sc.scale);
      var near = null, nd = 1e9;
      Object.keys(spots).forEach(function (id) {
        var s = spots[id], d = Math.hypot(s.x - sc.x, s.y - sc.y);
        if (d < Math.max(s.r, r) * 0.8 && d < nd) { near = id; nd = d; }
      });
      if (near && near.charAt(0) !== '~') { if (now - spots[near].seen < 1500) return; }
      var id = near || ('~' + (++faceSeq));
      placeSpot(id, sc.x, sc.y, r, now);
      var s = spots[id]; s.face = { x: f.x, y: f.y, w: f.w, aw: aw, score: f.score };
      s.hits = (s.hits || 0) + 1; s.best = Math.max(s.best || 0, f.score);
    });
    verifyPending();
    updateStale();
  }

  // The face finder also circles robes, hands, feet and the wolf now and then. Before a circle
  // shows, its face is compared with the saints' portraits; a poor match keeps it hidden.
  function verifyPending() {
    if (!nameWorker || !encReady || encFailed || verifyBusy || frozen || !running) return;
    var now = Date.now(), cx = screen.clientWidth / 2, cy = screen.clientHeight / 2;
    // first circles still hidden, then shown ones not yet checked, then a second look at rejected ones
    function rank(sp) { return sp.ok === false ? 2 : sureFace(sp) ? 1 : 0; }
    var ids = Object.keys(spots).filter(function (id) {
      var sp = spots[id];
      return id.charAt(0) === '~' && sp.face && now - sp.seen < 600 &&
        (sp.ok === undefined || (sp.ok === false && now - sp.vAt > 8000));
    }).sort(function (a, b) {
      return rank(spots[a]) - rank(spots[b]) ||
        Math.hypot(spots[a].x - cx, spots[a].y - cy) - Math.hypot(spots[b].x - cx, spots[b].y - cy);
    }).slice(0, 1);   // one at a time, so circles appear one by one, nearest the middle first
    if (!ids.length) return;
    ids.forEach(function (id) { spots[id].vAt = now; });
    var crops = cropFaces(ids.map(function (id) { return spots[id].face; }));
    verifyBusy = true; verifyIds = ids; verifyToken++;
    nameWorker.postMessage({ type: 'verify', token: verifyToken, crops: crops }, crops.map(function (c) { return c.buffer; }));
  }

  // Should this face circle show? A checked one shows if it passed. An unchecked one shows
  // only if the face finder is confident and has seen it more than once (on the test photos,
  // every spot that confident was a face); the rest wait for their check.
  function sureFace(s) { return s.face && s.best >= 0.75 && s.hits >= 2; }
  function faceShown(s) {
    if (s.ok !== undefined && !encFailed) return s.ok;
    return sureFace(s);
  }

  function dropFacesNear(x, y, r) {
    Object.keys(spots).forEach(function (id) {
      var s = spots[id];
      if (id.charAt(0) === '~' && Math.hypot(s.x - x, s.y - y) < Math.max(r, s.r) * 0.8) { s.el.remove(); delete spots[id]; }
    });
  }

  function placeSpot(id, x, y, r, now) {
    var s = spots[id];
    if (!s) {
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'spot';
      el.dataset.id = id;
      el.setAttribute('aria-label', t('whoIsThis'));
      spotsLayer.appendChild(el);
      s = spots[id] = { el: el, x: x, y: y, r: r, seen: now };
    } else if (now - s.seen < 400) {
      // smooth small jitters
      s.x += (x - s.x) * 0.6; s.y += (y - s.y) * 0.6; s.r += (r - s.r) * 0.6;
    } else { s.x = x; s.y = y; s.r = r; }
    s.seen = now;
    s.el.style.width = s.el.style.height = (2 * s.r) + 'px';
    s.el.style.transform = 'translate(' + (s.x - s.r) + 'px,' + (s.y - s.r) + 'px)';
    s.el.classList.remove('is-stale');
  }

  function updateStale() {
    var now = Date.now(), any = false;
    Object.keys(spots).forEach(function (id) {
      var s = spots[id], stale = now - s.seen > (id.charAt(0) === '~' ? 2500 : CONFIG.holdMs);
      s.el.classList.toggle('is-stale', stale);
      if (now - s.seen > 4000) { s.el.remove(); delete spots[id]; }
    });
    // Hide face circles that wait for their check, failed it, or sit on top of a better one.
    var shown = [];
    Object.keys(spots).forEach(function (id) {
      var s = spots[id], hide = id.charAt(0) === '~' && !faceShown(s);
      if (!hide && id.charAt(0) === '~') shown.push(s);
      s.el.classList.toggle('is-pending', hide);
    });
    shown.sort(function (a, b) { return (b.sim || b.face.score) - (a.sim || a.face.score); });
    shown.forEach(function (s, i) {
      for (var j = 0; j < i; j++) {
        var o = shown[j];
        if (!o.el.classList.contains('is-pending') && Math.hypot(o.x - s.x, o.y - s.y) < 0.7 * Math.max(o.r, s.r)) {
          s.el.classList.add('is-pending'); break;
        }
      }
    });
    Object.keys(spots).forEach(function (id) {
      var c = spots[id].el.classList;
      if (!c.contains('is-stale') && !c.contains('is-pending')) any = true;
    });
    var showBanner = banner.key && now - banner.seen < CONFIG.holdMs + 600;
    bannerEl.hidden = !showBanner || frozen;
    if (showBanner) bannerEl.textContent = t(banner.key);
    if (!frozen && running && loader.hidden) setStatus(any ? t('cameraTap') : t('cameraPoint'));
  }

  function clearSpots() { Object.keys(spots).forEach(function (id) { spots[id].el.remove(); }); spots = {}; bannerEl.hidden = true; }
  function setStatus(s) { if (statusEl.textContent !== s) statusEl.textContent = s; }

  // ---------- tap a face ----------
  spotsLayer.addEventListener('click', function (e) {
    var el = e.target.closest('.spot');
    if (!el || frozen) return;
    var s = spots[el.dataset.id];
    freeze({ id: el.dataset.id, x: s.x, y: s.y, r: s.r, face: s.face });
  });

  // Cut the tapped face and its neighbours from the full-size picture and ask the face worker who it is.
  var cropCanvas = document.createElement('canvas'), cctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  function startIdentify(sel) {
    identity = null; onIdentity = null; identToken++;
    if (!nameWorker || !sel.face) { identity = { error: 'no face' }; return; }
    var others = Object.keys(spots).map(function (id) { return spots[id]; }).filter(function (s) {
      return s.face && s.face !== sel.face && s.ok !== false && Date.now() - s.seen < 3000 &&
        Math.hypot(s.face.x - sel.face.x, s.face.y - sel.face.y) < 5 * Math.max(s.face.w, sel.face.w);
    }).sort(function (a, b) {
      return Math.hypot(a.face.x - sel.face.x, a.face.y - sel.face.y) - Math.hypot(b.face.x - sel.face.x, b.face.y - sel.face.y);
    }).map(function (s) { return s.face; }).slice(0, 4);
    var list = [sel.face].concat(others), crops = cropFaces(list), k = video.videoWidth / sel.face.aw;
    nameWorker.postMessage({ type: 'identify', token: identToken, crops: crops,
      faces: list.map(function (f) { return { x: f.x * k, y: f.y * k, w: f.w * k }; }) },
      crops.map(function (c) { return c.buffer; }));
  }
  // Square crops around faces from the full-size picture, framed like the portrait crops.
  function cropFaces(list) {
    var size = 224;
    cropCanvas.width = cropCanvas.height = size;
    return list.map(function (f) {
      var k = video.videoWidth / f.aw, side = f.w * 1.8 * k, cx = f.x * k, cy = (f.y - 0.12 * f.w) * k;
      cctx.fillStyle = '#000'; cctx.fillRect(0, 0, size, size);
      cctx.drawImage(video, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
      return cctx.getImageData(0, 0, size, size).data;
    });
  }
  // Run fn once the name is known (shows "Looking closely" meanwhile).
  function whenIdentified(fn) {
    if (identity) { fn(); return; }
    showStep('wait');
    onIdentity = fn;
  }
  function isFace(sel) { return sel && sel.id.charAt(0) === '~'; }

  function freeze(sel) {
    frozen = true; selected = sel;
    screen.dataset.selected = sel.id;
    screen.classList.add('is-frozen');
    // Hold the current picture still while the person answers.
    var cw = screen.clientWidth, ch = screen.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    freezeCanvas.width = cw * dpr; freezeCanvas.height = ch * dpr;
    var fx = freezeCanvas.getContext('2d');
    var vw = video.videoWidth, vh = video.videoHeight, s = Math.max(cw / vw, ch / vh);
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.drawImage(video, (cw - vw * s) / 2, (ch - vh * s) / 2, vw * s, vh * s);
    freezeCanvas.hidden = false;
    Object.keys(spots).forEach(function (id) { spots[id].el.hidden = true; });
    bannerEl.hidden = true;
    var scrim = $('#cam-scrim'), r = sel.r * 1.1;
    ['#scrim-circle', '#scrim-ring'].forEach(function (q) {
      var c = $(q); c.setAttribute('cx', sel.x); c.setAttribute('cy', sel.y); c.setAttribute('r', r);
    });
    scrim.removeAttribute('hidden');
    showStep('ask');
    tray.hidden = false;
    if (isFace(sel)) startIdentify(sel);
    $('#who-btn').focus({ preventScroll: true });
  }

  function unfreeze(silent) {
    frozen = false; selected = null;
    screen.classList.remove('is-frozen');
    freezeCanvas.hidden = true;
    $('#cam-scrim').setAttribute('hidden', '');
    tray.hidden = true;
    Object.keys(spots).forEach(function (id) { spots[id].el.hidden = false; spots[id].seen = 0; });
    $('#guess-input').value = '';
    hideList();
    identToken++; identity = null; onIdentity = null; pickMode = false;
    if (!silent && running) setStatus(t('cameraPoint'));
  }

  function showStep(name) {
    $$('.tray__step', tray).forEach(function (s) {
      s.hidden = s.dataset.step !== name; s.classList.remove('is-dissolving');
    });
  }

  // Tapping the picture outside the selected face, or Escape, goes back to the live camera.
  screen.addEventListener('click', function (e) {
    if (frozen && !e.target.closest('.spot, #tray, button, a, input, form, [role="listbox"]')) unfreeze();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && frozen && !screen.hidden) unfreeze(); });
  $('#who-btn').addEventListener('click', function () { showStep('choose'); $('#guess-btn').focus(); });
  $('#tell-btn').addEventListener('click', function () { tell(); });

  // "Tell me": a wall-photo circle already knows the saint; a face from the face finder is named
  // from the portraits, and when the match isn't sure the person picks from the closest three.
  function tell() {
    if (!isFace(selected)) { reveal(); return; }
    whenIdentified(function () {
      if (!identity || identity.error) { showPick([]); return; }
      if (identity.sure) reveal(identity.id); else showPick(identity.ranked.slice(0, 3));
    });
  }
  var pickMode = false;
  function showPick(cands) {
    var ul = $('#pick-list');
    cands = cands.filter(function (c) { return DS.byId[c.id]; });
    ul.innerHTML = cands.map(function (c) {
      var s = DS.byId[c.id], name = s ? DS.saintText(s).name : c.id;
      return '<li><button type="button" class="pick__btn" data-id="' + c.id + '"><img src="img/saints/thumbs/' + c.id +
        '.jpg?v=' + CONFIG.version + '" alt="" width="64" height="64"><span>' + name.replace(/</g, '&lt;') + '</span></button></li>';
    }).join('');
    ul.hidden = !cands.length;
    showStep('pick');
    var first = $('.pick__btn', ul) || $('#pick-other'); first.focus({ preventScroll: true });
  }
  $('#pick-list').addEventListener('click', function (e) {
    var b = e.target.closest('.pick__btn'); if (b) reveal(b.dataset.id);
  });
  $('#pick-other').addEventListener('click', function () {
    pickMode = true; showStep('guess');
    setTimeout(function () { $('#guess-input').focus(); }, 50);
  });
  $('#guess-btn').addEventListener('click', function () {
    showStep('guess');
    setTimeout(function () { $('#guess-input').focus(); }, 50);
  });

  function reveal(id) {
    id = id || selected.id;
    if (!DS.byId[id]) {   // Jesus has no profile: show the caption instead
      unfreeze(); if (id === 'jesus') { banner = { key: 'jesusBanner', seen: Date.now() + 3000 }; updateStale(); }
      return;
    }
    tray.hidden = true;
    DS.openSheet(id, { onClose: function () { unfreeze(); } });
  }

  // ---------- guessing with autocomplete ----------
  var input = $('#guess-input'), listEl = $('#guess-list');
  var picked = null, active = -1, current = [];

  function entries() {
    var out = [];
    window.SAINTS.list.forEach(function (l) {
      var s = DS.byId[l.id], es = (window.SAINTS_ES || {})[l.id] || {};
      var names = [l.label];
      if (l.label === s.name) names = names.concat(s.aliases, es.name ? [es.name] : []);
      out.push({ id: l.id, label: l.label === s.name && DS.lang === 'es' && es.name ? es.name : l.label, names: names });
    });
    return out;
  }

  input.addEventListener('input', function () {
    picked = null;
    current = Fuzzy.search(input.value, entries(), 6);
    active = -1;
    if (!current.length) { hideList(); return; }
    listEl.innerHTML = current.map(function (r, i) {
      return '<li role="option" id="opt-' + i + '" data-i="' + i + '">' + r.entry.label.replace(/</g, '&lt;') + '</li>';
    }).join('');
    listEl.hidden = false; input.setAttribute('aria-expanded', 'true');
  });
  input.addEventListener('keydown', function (e) {
    if (listEl.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + current.length) % current.length;
      $$('li', listEl).forEach(function (li, i) { li.setAttribute('aria-selected', String(i === active)); });
      input.setAttribute('aria-activedescendant', 'opt-' + active);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); choose(active);
    } else if (e.key === 'Escape') hideList();
  });
  listEl.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  listEl.addEventListener('click', function (e) {
    var li = e.target.closest('li'); if (li) choose(+li.dataset.i);
  });
  function choose(i) { picked = current[i].entry; input.value = picked.label; hideList(); }
  function hideList() { listEl.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }

  $('#guess-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!input.value.trim()) { input.focus(); return; }
    var guessId = picked ? picked.id : null;
    if (!guessId) {
      var best = Fuzzy.search(input.value, entries(), 1)[0];
      if (best && best.score >= 0.8) guessId = best.entry.id;
    }
    input.blur(); hideList();
    if (pickMode) { if (guessId) reveal(guessId); else input.focus(); return; }
    if (isFace(selected)) { whenIdentified(function () { judgeFaceGuess(guessId); }); return; }
    var right = guessId === selected.id;
    var form = $('#guess-form');
    form.classList.add('is-dissolving');
    setTimeout(function () {
      showStep('result');
      $('.tray__result').textContent = right ? t('youreRight') : t('notQuite');
      setTimeout(reveal, 1200);
    }, 350);
  });

  // A guess about a face from the face finder: right if it is the sure match, or one of the
  // close matches when the portraits can't tell.
  function judgeFaceGuess(guessId) {
    var ok = identity && !identity.error, ranked = ok ? identity.ranked.map(function (c) { return c.id; }) : [];
    var right = ok && (identity.sure ? guessId === identity.id : ranked.indexOf(guessId) >= 0);
    showStep('result');
    $('.tray__result').textContent = right ? t('youreRight') : t('notQuite');
    setTimeout(function () {
      if (right) reveal(guessId);
      else if (ok && identity.sure) reveal(identity.id);
      else showPick(ok ? identity.ranked.slice(0, 3) : []);
    }, 1200);
  }

  document.addEventListener('langchange', function () {
    if (running && !frozen && loader.hidden) setStatus(t('cameraPoint'));
  });

  window.Camera = { start: start, stop: stop, _spots: function () { return spots; } };
})();
