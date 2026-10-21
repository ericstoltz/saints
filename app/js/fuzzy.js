/* Forgiving name matching for the "Let me guess" box. */
(function () {
  'use strict';

  function norm(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[ʻ'’`]/g, '').replace(/[^a-z0-9]+/g, ' ')
      .replace(/^(saint|santa|santo|san|st) /, '').trim();
  }

  // Damerau-Levenshtein (optimal string alignment) distance.
  function dist(a, b) {
    var m = a.length, n = b.length, i, j, d = [];
    if (!m) return n; if (!n) return m;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      var c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[m][n];
  }

  function sim(a, b) { return 1 - dist(a, b) / Math.max(a.length, b.length); }

  // Score 0..1 of how well a query matches one name.
  function score(q, name) {
    if (!q) return 0;
    if (name === q) return 1;
    if (name.indexOf(q) === 0) return 0.9 + 0.1 * q.length / name.length;
    var best = sim(q, name);
    var words = name.split(' ').filter(function (w) { return w.length > 2 && ['the', 'with', 'of', 'de', 'las', 'del'].indexOf(w) < 0; });
    var qw = q.split(' ');
    words.forEach(function (w) {
      if (w.indexOf(q) === 0 && q.length >= 3) best = Math.max(best, 0.85);
      // compare against the same number of words, to allow "malcom x" or "gandi"
      best = Math.max(best, sim(q, w) * 0.95);
    });
    if (qw.length > 1) {
      var hits = qw.reduce(function (acc, x) {
        var b = 0; words.forEach(function (w) { b = Math.max(b, sim(x, w)); }); return acc + b;
      }, 0) / qw.length;
      best = Math.max(best, hits * 0.97);
    }
    return best;
  }

  // entries: [{id, label, names: [..]}]. Returns entries sorted by score.
  function search(query, entries, limit) {
    var q = norm(query);
    if (!q) return [];
    return entries.map(function (e) {
      var s = 0;
      e.names.forEach(function (n) { s = Math.max(s, score(q, norm(n))); });
      return { entry: e, score: s };
    }).filter(function (r) { return r.score >= 0.55; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit || 6);
  }

  window.Fuzzy = { search: search, norm: norm };
})();
