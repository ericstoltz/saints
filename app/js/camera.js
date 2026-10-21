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

  function t(k) { return DS.t(k); }

  // ---------- worker and references ----------
  function initWorker() {
    if (worker) return;
    worker = new Worker('js/vision-worker.js');
    worker.onmessage = onWorker;
    if (!window.MURAL) { refsLoaded = true; return; }
    worker.postMessage({ type: 'refs', meta: MURAL.refs, url: new URL(MURAL.refsFile, location.href).href });
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
    if (frozen || busy || video.readyState < 2 || !video.videoWidth) return;
    var aw = CONFIG.analysisWidth, vw = video.videoWidth, vh = video.videoHeight;
    var ah = Math.round(vh * aw / vw);
    if (analysis.width !== aw || analysis.height !== ah) { analysis.width = aw; analysis.height = ah; }
    actx.drawImage(video, 0, 0, aw, ah);
    var img = actx.getImageData(0, 0, aw, ah);
    var buf = (spare && spare.byteLength === img.data.byteLength) ? spare : new ArrayBuffer(img.data.byteLength);
    new Uint8ClampedArray(buf).set(img.data);
    spare = null; busy = true; frameNo++;
    // While a wall is in view, look mostly for that wall (faster); do a full search every few frames.
    var tracking = Date.now() - lastFound.at < 1000 && frameNo % 4 !== 0;
    worker.postMessage({ type: 'frame', rgba: buf, w: aw, h: ah, only: tracking ? lastFound.ids : null }, [buf]);
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
        var cx = h.x * wall.refW, cy = h.y * wall.refH, rr = (h.r || 0.04) * wall.refW;
        var c = project(r.H, cx, cy), e = project(r.H, cx + rr, cy), e2 = project(r.H, cx, cy + rr);
        var sc = toScreen(c, aw);
        var rad = (Math.hypot(e.x - c.x, e.y - c.y) + Math.hypot(e2.x - c.x, e2.y - c.y)) / 2 * sc.scale;
        if (sc.x < -rad || sc.y < -rad || sc.x > cw + rad || sc.y > ch + rad || !isFinite(rad)) return;
        if (h.saint === 'jesus') { banner = { key: 'jesusBanner', seen: now }; return; }
        placeSpot(h.saint, sc.x, sc.y, Math.max(22, rad), now);
      });
    });
    updateStale();
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
      var s = spots[id], stale = now - s.seen > CONFIG.holdMs;
      s.el.classList.toggle('is-stale', stale);
      if (now - s.seen > 4000) { s.el.remove(); delete spots[id]; } else if (!stale) any = true;
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
    freeze({ id: el.dataset.id, x: s.x, y: s.y, r: s.r });
  });

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
    var scrim = $('#cam-scrim'), r = sel.r * 1.08;
    ['#scrim-circle', '#scrim-ring'].forEach(function (q) {
      var c = $(q); c.setAttribute('cx', sel.x); c.setAttribute('cy', sel.y); c.setAttribute('r', r);
    });
    scrim.removeAttribute('hidden');
    showStep('ask');
    tray.hidden = false;
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
    if (!silent && running) setStatus(t('cameraPoint'));
  }

  function showStep(name) {
    $$('.tray__step', tray).forEach(function (s) {
      s.hidden = s.dataset.step !== name; s.classList.remove('is-dissolving');
    });
  }

  $('#tray-close').addEventListener('click', function () { unfreeze(); });
  $('#who-btn').addEventListener('click', function () { showStep('choose'); $('#guess-btn').focus(); });
  $('#tell-btn').addEventListener('click', function () { reveal(); });
  $('#guess-btn').addEventListener('click', function () {
    showStep('guess');
    setTimeout(function () { $('#guess-input').focus(); }, 50);
  });

  function reveal() {
    var id = selected.id;
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
    var right = guessId === selected.id;
    input.blur(); hideList();
    var form = $('#guess-form');
    form.classList.add('is-dissolving');
    setTimeout(function () {
      showStep('result');
      $('.tray__result').textContent = right ? t('youreRight') : t('notQuite');
      setTimeout(reveal, 1200);
    }, 350);
  });

  document.addEventListener('langchange', function () {
    if (running && !frozen && loader.hidden) setStatus(t('cameraPoint'));
  });

  window.Camera = { start: start, stop: stop };
})();
