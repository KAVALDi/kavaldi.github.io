// Клиентская часть сайта: поиск по публичному индексу и сворачивание боковых блоков на узком экране.
(function () {
  const base = window.SITE_BASE || '/';
  if (window.matchMedia('(max-width: 70rem)').matches) {
    document.querySelectorAll('.doc-nav details, details.toc').forEach((d) => d.removeAttribute('open'));
  }
  const q = document.getElementById('q');
  if (!q) return;
  const out = document.getElementById('results');
  const status = document.getElementById('search-status');
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  // Грубое усечение окончаний, чтобы "рамки" находили "рамка".
  const stem = (w) => (w.length > 4 ? w.replace(/(ами|ями|ого|ему|ыми|ими|ия|ие|ий|ый|ой|ая|ое|ые|ов|ев|ей|ом|ем|ах|ях|а|я|ы|и|о|е|у|ю|ь)$/, '') : w);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let index = null;
  const load = () => fetch(base + 'search-index.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => { index = d.map((e) => ({ e, t: norm(e.t), s: norm(e.s), x: norm(e.x) })); });
  function run() {
    const words = norm(q.value).split(/[^\p{L}\p{N}#]+/u).filter((w) => w.length > 1).map(stem);
    out.textContent = '';
    if (!words.length) { status.textContent = 'Поиск работает по опубликованным материалам.'; return; }
    const res = [];
    for (const d of index) {
      let score = 0, all = true;
      for (const w of words) {
        const hit = (d.t.includes(w) ? 5 : 0) + (d.s.includes(w) ? 2 : 0) + (d.x.includes(w) ? 1 : 0);
        if (!hit) { all = false; break; }
        score += hit;
      }
      if (all) res.push([score, d.e]);
    }
    res.sort((a, b) => b[0] - a[0]);
    status.textContent = res.length ? 'Найдено: ' + res.length : 'Ничего не найдено. Попробуйте другое слово.';
    for (const [, e] of res.slice(0, 30)) {
      const a = document.createElement('a');
      a.className = 'card'; a.href = e.u;
      a.innerHTML = '<span class="card-top"><span class="type">' + esc(e.k) + '</span><span class="muted">' + esc(e.p) + '</span></span><strong>' + esc(e.t) + '</strong><span class="card-sum">' + esc(e.s || e.x.slice(0, 160)) + '</span>';
      out.appendChild(a);
    }
  }
  load().then(() => { q.addEventListener('input', run); const p = new URLSearchParams(location.search).get('q'); if (p) { q.value = p; } run(); })
    .catch(() => { status.textContent = 'Не удалось загрузить поисковый индекс. Обновите страницу.'; });
})();
