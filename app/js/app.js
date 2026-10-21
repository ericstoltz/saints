/* Dancing Saints: screens, language, list and profile sheet. */
(function () {
  'use strict';
  var C = window.CONTENT, S = window.SAINTS, ES = window.SAINTS_ES || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var params = new URLSearchParams(location.search);
  var isMobile = params.has('mobile') || (!params.has('desktop') && (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

  var byId = {};
  S.saints.forEach(function (s) { byId[s.id] = s; });

  // ---------- language ----------
  var lang = store('lang') || ((navigator.language || 'en').slice(0, 2) === 'es' ? 'es' : 'en');
  function t(key) { return (C[lang] && C[lang][key] != null) ? C[lang][key] : C.en[key]; }

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem('ds.' + k);
      localStorage.setItem('ds.' + k, v);
    } catch (e) { return null; }
  }

  function setLang(l) {
    lang = l; store('lang', l);
    document.documentElement.lang = l;
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $$('[data-i18n-alt]').forEach(function (el) { el.alt = t(el.dataset.i18nAlt); });
    $$('[data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === l)); });
    renderProse();
    renderList();
    if (sheetState.id) fillSheet(sheetState.id);
    document.dispatchEvent(new CustomEvent('langchange'));
  }

  // Spanish dates: months, centuries, "c.", "BCE"
  var MONTHS_ES = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio',
    July: 'julio', August: 'agosto', September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre' };
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
  function feastText(f) {
    if (!f || lang !== 'es') return f;
    if (f === 'Easter Day') return 'Domingo de Pascua';
    var m = f.match(/^(\w+) (\d+)$/);
    return m ? m[2] + ' de ' + MONTHS_ES[m[1]] : f;
  }
  function datesText(d) {
    if (!d || lang !== 'es') return d;
    return d
      .replace(/(\d+)(?:st|nd|rd|th)–(\d+)(?:st|nd|rd|th)\? century/, function (_, a, b) { return 'siglos ' + ROMAN[+a] + '–' + ROMAN[+b] + '?'; })
      .replace(/(\d+)(?:st|nd|rd|th) century/, function (_, a) { return 'siglo ' + ROMAN[+a]; })
      .replace(/BCE/g, 'a. e. c.').replace(/^reigned /, 'reinó ');
  }
  function saintText(s) {
    var es = lang === 'es' ? (ES[s.id] || {}) : {};
    return {
      name: es.name || s.name,
      bio: es.bio || s.bio,
      dates: es.lifespan || datesText(s.lifespan),
      feast: feastText(s.feast),
    };
  }
  window.DS = { byId: byId, t: t, saintText: saintText, openSheet: openSheet, isMobile: isMobile,
    get lang() { return lang; } };

  // ---------- images with local-first fallback ----------
  function srcChain(img, list) {
    var i = 0;
    img.onerror = function () { if (++i < list.length) img.src = list[i]; else img.onerror = null; };
    img.src = list[0];
  }
  $$('[data-src-logo]').forEach(function (img) { srcChain(img, CONFIG.logo); });
  $$('[data-src-loading]').forEach(function (img) { srcChain(img, CONFIG.loadingImage); });

  $$('[data-when]').forEach(function (el) {
    el.hidden = (el.dataset.when === 'mobile') !== isMobile;
  });

  // ---------- splash flow ----------
  var splash = $('#screen-loading'), intro = $('#screen-intro'), shell = $('#shell');
  var startHash = location.hash;

  $$('[data-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      setLang(b.dataset.lang);
      if (!splash.hidden) leaveSplash();
    });
  });

  var splashDone = false;
  function leaveSplash() {
    store('seen', '1');
    splashDone = true;
    splash.classList.add('is-out');
    setTimeout(function () { splash.hidden = true; }, 400);
    if (startHash && startHash.length > 2) { showShell(); return; }
    showIntro();
  }

  var crawlAnim = null;
  function showIntro() {
    intro.hidden = false;
    var crawl = $('.intro__crawl'), box = $('.intro__scroller');
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var distance = crawl.scrollHeight - box.clientHeight * 0.75;
    if (reduce || !crawl.animate) { crawl.style.paddingTop = '24px'; box.style.overflow = 'auto'; return; }
    crawlAnim = crawl.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(' + (-distance) + 'px)' }],
      { duration: Math.max(14000, distance * 28), easing: 'linear', fill: 'forwards' });
    // Let people take over by touching or scrolling.
    var stop = function () {
      if (!crawlAnim) return;
      var y = new DOMMatrix(getComputedStyle(crawl).transform).m42;
      crawlAnim.cancel(); crawlAnim = null;
      crawl.style.transform = 'none'; box.style.overflow = 'auto'; box.scrollTop = -y;
    };
    box.addEventListener('pointerdown', stop, { once: true });
    box.addEventListener('wheel', stop, { once: true, passive: true });
  }

  function hideIntro() {
    if (crawlAnim) { crawlAnim.cancel(); crawlAnim = null; }
    intro.hidden = true;
  }

  $('#intro-camera').addEventListener('click', function () {
    hideIntro(); shell.hidden = false;
    if (location.hash === '#/camera') route(); else location.hash = '#/camera';
  });
  intro.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#/"]');
    if (a) { hideIntro(); shell.hidden = false; if (a.getAttribute("href") === location.hash) route(); }
  });

  function showShell() { shell.hidden = false; route(); }

  // ---------- routing ----------
  var screens = { camera: '#screen-camera', browse: '#screen-browse', commentary: '#screen-commentary',
    iconographer: '#screen-iconographer', home: '#screen-home' };

  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var name = parts[0] || (isMobile ? 'camera' : 'home');
    if (name === 'camera' && !isMobile) name = 'home';
    if (name === 'saint') { // deep link: #/saint/<id>
      name = 'browse';
      if (byId[parts[1]]) setTimeout(function () { openSheet(parts[1], { browse: true }); }, 50);
    }
    if (!screens[name]) name = isMobile ? 'camera' : 'home';
    if (!(splashDone || splash.hidden) || !intro.hidden) return;
    shell.hidden = false;
    Object.keys(screens).forEach(function (k) { $(screens[k]).hidden = k !== name; });
    document.body.classList.toggle('is-camera', name === 'camera');
    $$('#menu a').forEach(function (a) {
      if (a.getAttribute('href') === '#/' + name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    closeMenu();
    if (name === 'camera') window.Camera && Camera.start(); else window.Camera && Camera.stop();
    if (name !== 'camera') window.scrollTo(0, 0);
    if (name === 'browse') lazyThumbs();
  }
  window.addEventListener('hashchange', route);

  // ---------- menu ----------
  var menu = $('#menu'), menuBtn = $('#menu-open');
  function openMenu() { menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); $('#menu-close').focus(); }
  function closeMenu() { if (menu.hidden) return; menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
  menuBtn.addEventListener('click', openMenu);
  $('#menu-close').addEventListener('click', function () { closeMenu(); menuBtn.focus(); });
  menu.addEventListener('click', function (e) { if (e.target === menu) closeMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  // ---------- prose pages ----------
  function paras(list, firstClass) {
    return list.map(function (p, i) {
      return '<p' + (i === 0 && firstClass ? ' class="' + firstClass + '"' : '') + '>' + esc(p) + '</p>';
    }).join('');
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function renderProse() {
    var c = t('commentary');
    $('#commentary-body').innerHTML =
      paras(c.slice(0, 2), 'dropcap') +
      '<figure><img src="img/rotunda.jpg" alt="' + esc(t('commentaryPhotoAlt')) + '" width="540" height="708" loading="lazy"></figure>' +
      paras(c.slice(2)) +
      '<blockquote class="poem">' + t('commentaryPoem').map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
      '<cite>— ' + esc(t('introQuoteBy')) + '</cite></blockquote>';
    $('#iconographer-body').innerHTML = paras(t('iconographer'), 'dropcap');
  }

  // ---------- browse list ----------
  var list = $('#saint-list');
  var sortedList = S.list.slice();
  function shownName(e) {
    var s = byId[e.id];
    return e.label === s.name ? saintText(s).name : (t('memberNames')[e.label] || e.label);
  }

  // Small list pictures; Nellie and Dorothy Lincoln each have their own portrait.
  var MEMBER_THUMBS = { 'Nellie Lincoln': 'nellie-lincoln', 'Dorothy Lincoln': 'dorothy-lincoln' };
  function thumbOf(e) { return 'img/saints/thumbs/' + (MEMBER_THUMBS[e.label] || e.id) + '.jpg?v=' + CONFIG.version; }

  function renderList() {
    // Alphabetical by first name, as the names are shown ("Anne Frank" under A).
    sortedList.sort(function (a, b) {
      return shownName(a).localeCompare(shownName(b), lang, { sensitivity: 'base' });
    });
    list.innerHTML = sortedList.map(function (e) {
      var s = byId[e.id], tx = saintText(s);
      var label = shownName(e);
      var names = [e.label, label, s.name, tx.name].concat(s.aliases);
      return '<li data-names="' + esc(names.join('|')) + '">' +
        '<button type="button" class="saint-row" data-id="' + s.id + '">' +
        '<span class="thumb"><img data-src="' + thumbOf(e) + '" alt="" width="60" height="60"></span>' +
        '<span class="saint-row__text"><span class="saint-row__name">' + esc(label) + '</span>' +
        (tx.dates ? '<span class="saint-row__dates">' + esc(tx.dates) + '</span>' : '') +
        '</span></button></li>';
    }).join('');
    lazyThumbs();
    applyFilter();
  }

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) { loadThumb(en.target); io.unobserve(en.target); } });
  }, { rootMargin: '200px' }) : null;
  function loadThumb(img) {
    img.onload = function () { img.parentNode.classList.add('is-loaded'); };
    img.src = img.dataset.src;
  }
  function lazyThumbs() {
    $$('img[data-src]', list).forEach(function (img) {
      if (img.src) return;
      if (io) io.observe(img); else loadThumb(img);
    });
  }

  list.addEventListener('click', function (e) {
    var b = e.target.closest('.saint-row');
    if (b) openSheet(b.dataset.id, { browse: true, opener: b });
  });

  var filter = $('#filter');
  function applyFilter() {
    var q = filter.value || '';
    var shown = 0;
    $$('li', list).forEach(function (li) {
      var ok = Fuzzy.matches(q, li.dataset.names.split('|'));
      li.hidden = !ok; if (ok) shown++;
    });
    $('#no-results').hidden = shown > 0;
  }
  filter.addEventListener('input', applyFilter);

  // ---------- profile sheet ----------
  var sheet = $('#sheet');
  var sheetState = { id: null, browse: false, opener: null, onClose: null };

  function fillSheet(id) {
    var s = byId[id], tx = saintText(s);
    var img = $('#sheet-img');
    img.src = s.image + '?v=' + CONFIG.version; img.alt = tx.name;
    $('#sheet-name').textContent = tx.name;
    $('#sheet-dates').textContent = tx.dates || '';
    $('#sheet-dates').hidden = !tx.dates;
    $('#sheet-bio').innerHTML = tx.bio;
    var feast = $('#sheet-feast');
    feast.textContent = tx.feast ? t('celebratedOn').replace('{date}', tx.feast) : '';
    feast.hidden = !tx.feast;
    var idx = browseIds().indexOf(id);
    $('#sheet-prev').disabled = idx <= 0;
    $('#sheet-next').disabled = idx < 0 || idx >= browseIds().length - 1;
    $('.sheet__scroll').scrollTop = 0;
  }
  function browseIds() {
    var seen = {}, ids = [];
    sortedList.forEach(function (e) {
      var li = list.querySelector('[data-id="' + e.id + '"]');
      if (!seen[e.id] && !(li && li.closest('li').hidden)) { seen[e.id] = 1; ids.push(e.id); }
    });
    return ids;
  }

  function openSheet(id, opts) {
    opts = opts || {};
    sheetState = { id: id, browse: !!opts.browse, opener: opts.opener || document.activeElement, onClose: opts.onClose || null };
    sheet.classList.toggle('is-browse', sheetState.browse);
    fillSheet(id);
    if (!sheet.open) {
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', '');
      requestAnimationFrame(function () { requestAnimationFrame(function () { sheet.classList.add('is-open'); }); });
    }
    $('.sheet__close').focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheet.open) return;
    sheet.classList.remove('is-open');
    var done = sheetState.onClose, opener = sheetState.opener;
    setTimeout(function () {
      if (sheet.close) sheet.close(); else sheet.removeAttribute('open');
      sheetState.id = null;
      if (opener && opener.focus && document.contains(opener)) opener.focus({ preventScroll: true });
      if (done) done();
    }, 280);
  }

  $$('[data-close]', sheet).forEach(function (b) { b.addEventListener('click', closeSheet); });
  sheet.addEventListener('cancel', function (e) { e.preventDefault(); closeSheet(); });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  function step(d) {
    var ids = browseIds(), i = ids.indexOf(sheetState.id) + d;
    if (i >= 0 && i < ids.length) { sheetState.id = ids[i]; fillSheet(ids[i]); }
  }
  $('#sheet-prev').addEventListener('click', function () { step(-1); });
  $('#sheet-next').addEventListener('click', function () { step(1); });
  sheet.addEventListener('keydown', function (e) {
    if (!sheetState.browse) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // Drag the sheet down to close it.
  (function () {
    var panel = $('.sheet__panel'), startY = null, dy = 0;
    panel.addEventListener('touchstart', function (e) {
      var sc = $('.sheet__scroll');
      if (sc.scrollTop > 0 && sc.contains(e.target)) return;
      startY = e.touches[0].clientY; dy = 0; panel.style.transition = 'none';
    }, { passive: true });
    panel.addEventListener('touchmove', function (e) {
      if (startY == null) return;
      var d = e.touches[0].clientY - startY;
      // Swiping up scrolls the text; only a downward pull drags the sheet.
      if (d < 0 && !dy) { startY = null; panel.style.transition = ''; return; }
      dy = Math.max(0, d);
      panel.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    panel.addEventListener('touchend', function () {
      if (startY == null) return;
      panel.style.transition = ''; panel.style.transform = '';
      if (dy > 110) closeSheet();
      startY = null;
    });
  })();

  // Tapping the app name in the header starts over at the opening screen.
  $('.topbar__title').addEventListener('click', function (e) {
    e.preventDefault();
    if (window.Camera) Camera.stop();
    closeMenu();
    if (sheet.open) closeSheet();
    history.replaceState(null, '', location.pathname + location.search);
    startHash = ''; splashDone = false;
    shell.hidden = true; hideIntro();
    splash.classList.remove('is-out'); splash.hidden = false;
    var first = $('[data-lang]', splash); if (first) first.focus({ preventScroll: true });
  });

  // ---------- start ----------
  setLang(lang);
  if (location.hash.length > 2 && store('seen')) {
    // Returning with a link: skip straight to the screen.
    splash.hidden = true; shell.hidden = false; route();
  }
})();
