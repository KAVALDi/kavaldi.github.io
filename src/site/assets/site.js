// Клиентская часть сайта: поиск по публичному индексу и сворачивание боковых блоков на узком экране.
(function () {
  const base = window.SITE_BASE || '/';
  const projectMenu = document.querySelector('.project-menu');
  if (projectMenu) {
    const trigger = projectMenu.querySelector('summary');
    let openedByHover = false;
    const closeMenu = () => {
      openedByHover = false;
      projectMenu.open = false;
    };
    trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' || projectMenu.open) return;
      openedByHover = true;
      projectMenu.open = true;
    });
    projectMenu.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse' || !openedByHover) return;
      if (!projectMenu.contains(document.activeElement)) closeMenu();
    });
    trigger.addEventListener('click', (event) => {
      if (!openedByHover) return;
      openedByHover = false;
      // Клик закрепляет открытое наведением меню. Следующий клик закрывает его.
      if (event.detail > 0) event.preventDefault();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!projectMenu.contains(event.target)) closeMenu();
    });
    document.addEventListener('focusin', (event) => {
      if (!projectMenu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !projectMenu.open) return;
      closeMenu();
      trigger.focus();
    });
  }
  if (window.matchMedia('(max-width: 70rem)').matches) {
    document.querySelectorAll('.doc-nav details, details.toc').forEach((d) => d.removeAttribute('open'));
  }
  enhance();
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

  // --- улучшения страниц записей: подсветка оглавления, фильтр длинных таблиц, модель улья ---
  function enhance() {
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    // Оглавление подсвечивает раздел, который сейчас на экране.
    const links = [...document.querySelectorAll('.toc a[href^="#"]')];
    const heads = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
    if (heads.length) {
      const spy = () => {
        let cur = heads[0];
        for (const h of heads) if (h.getBoundingClientRect().top < 140) cur = h;
        links.forEach((a) => a.classList.toggle('on', decodeURIComponent(a.hash.slice(1)) === cur.id));
      };
      addEventListener('scroll', spy, { passive: true });
      spy();
    }

    // Перетаскивание мышью за свободное место. Ссылки и прокрутка касанием работают как обычно.
    document.querySelectorAll('.graph-wrap, .home-timeline').forEach((wrap) => {
      const updateCursor = () => wrap.classList.toggle('is-pannable', wrap.scrollWidth > wrap.clientWidth);
      new ResizeObserver(updateCursor).observe(wrap);
      updateCursor();

      let drag = null;
      wrap.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('a')) return;
        if (wrap.scrollWidth <= wrap.clientWidth) return;
        const contentTop = wrap.getBoundingClientRect().top + wrap.clientTop;
        if (event.clientY >= contentTop + wrap.clientHeight) return;

        event.preventDefault();
        drag = { pointerId: event.pointerId, x: event.clientX };
        wrap.setPointerCapture(event.pointerId);
        wrap.classList.add('is-panning');
      });
      wrap.addEventListener('pointermove', (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        wrap.scrollLeft += drag.x - event.clientX;
        drag.x = event.clientX;
      });
      wrap.addEventListener('lostpointercapture', (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        drag = null;
        wrap.classList.remove('is-panning');
      });
    });

    const timeline = document.getElementById('home-timeline');
    if (timeline) {
      const controls = document.querySelector('.home-feed-controls');
      const [previous, next] = controls.querySelectorAll('button');
      const updateControls = () => {
        const max = timeline.scrollWidth - timeline.clientWidth;
        controls.hidden = max <= 1;
        previous.setAttribute('aria-disabled', timeline.scrollLeft <= 1);
        next.setAttribute('aria-disabled', timeline.scrollLeft >= max - 1);
      };
      for (const button of [previous, next]) {
        button.addEventListener('click', () => {
          if (button.getAttribute('aria-disabled') === 'true') return;
          const [first, second] = timeline.children;
          const step = second.getBoundingClientRect().left - first.getBoundingClientRect().left;
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          timeline.scrollBy({ left: step * Number(button.dataset.feedStep), behavior: reduceMotion ? 'auto' : 'smooth' });
        });
      }
      timeline.addEventListener('scroll', updateControls, { passive: true });
      new ResizeObserver(updateControls).observe(timeline);
      updateControls();
    }

    // Длинные таблицы получают поле фильтра.
    document.querySelectorAll('.prose .table-wrap').forEach((wrap) => {
      const rows = [...wrap.querySelectorAll('tbody tr')];
      if (rows.length < 9) return;
      const inp = el('input', 'table-filter');
      inp.type = 'search'; inp.placeholder = 'Фильтр по таблице'; inp.setAttribute('aria-label', 'Фильтр по таблице');
      inp.addEventListener('input', () => { const v = inp.value.trim().toLowerCase(); rows.forEach((r) => { r.hidden = !!v && !r.textContent.toLowerCase().includes(v); }); });
      wrap.before(inp);
    });

    // Модель роста колонии. Считает только то, что задано правилами: вместимость и минимальное время.
    document.querySelectorAll('.hive-sim').forEach((box) => {
      let p;
      try { p = JSON.parse(box.dataset.p); } catch { return; }
      let frames = Math.min(2, p.maxFrames), t = 0;
      box.textContent = '';
      const ctl = el('div', 'hive-ctl');
      ctl.append(el('span', '', 'Рамок в улье:'));
      const btns = [];
      for (let i = 1; i <= p.maxFrames; i++) {
        const b = el('button', '', String(i)); b.type = 'button';
        b.addEventListener('click', () => { frames = i; t = Math.min(t, full()); draw(); });
        btns.push(b); ctl.append(b);
      }
      const grid = el('div', 'hive-frames');
      const out = el('dl', 'hive-out');
      const time = el('label', 'hive-time');
      const range = el('input'); range.type = 'range'; range.min = 0; range.step = 1;
      const tl = el('span');
      time.append(el('span', '', 'Время:'), range, tl);
      range.addEventListener('input', () => { t = +range.value; draw(); });
      box.append(el('h3', '', 'Как растёт колония'), el('p', 'hint', 'Нижняя оценка: считается, что нектара хватает и матка кладёт пчёл без пауз.'), ctl, grid, time, out);
      const cap = () => frames * p.perFrame;
      const full = () => Math.max(0, cap() - p.start) * p.layMinutes;
      const stat = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); return d; };
      function draw() {
        btns.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === frames)));
        const bees = Math.min(cap(), p.start + Math.floor(t / p.layMinutes));
        grid.textContent = '';
        for (let f = 0; f < p.maxFrames; f++) {
          const fr = el('div', 'hive-frame' + (f < frames ? '' : ' off'));
          for (let k = 0; k < p.perFrame; k++) {
            const c = el('i', f * p.perFrame + k < bees && f < frames ? 'on' : '');
            c.classList.add('dot');
            fr.append(c);
          }
          grid.append(fr);
        }
        range.max = full() + p.eggMinutes; range.value = t;
        tl.textContent = t + ' мин';
        out.textContent = '';
        out.append(stat('Пчёл сейчас', bees + ' из ' + cap()), stat('Колония полная', full() ? 'через ' + full() + ' мин' : 'сразу'),
          stat('Яйцо матки', t >= full() + p.eggMinutes ? 'возможно' : 'не раньше ' + (full() + p.eggMinutes) + ' мин'));
      }
      draw();
    });
  }
})();
