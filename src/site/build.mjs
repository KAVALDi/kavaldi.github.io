// Сборщик публичного сайта. Читает ТОЛЬКО каталог content/ (публичный снимок) и ничего не знает
// о приватном хранилище, поэтому его можно запускать в GitHub Actions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { readSnapshot } from '../core/exporter.mjs';
import { ENTITY_TYPES, STATE_DIMENSIONS, LINK_RELS, ROADMAP_LANES } from '../core/schema.mjs';
import { slugify } from '../core/text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d + (String(d).length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const dirOf = (e) => (e.type === 'article' ? 'wiki' : e.type === 'devlog' ? 'devlog' : 'kb');
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

export function buildSite({ contentDir, outDir, base = '/' } = {}) {
  if (!base.endsWith('/')) base += '/';
  const snap = readSnapshot(contentDir);
  const site = { title: 'Developer Knowledge Hub', login: '', ...snap.site };
  const byId = new Map(snap.entities.map((e) => [e.id, e]));
  const projects = new Map(snap.projects.map((p) => [p.id, p]));
  const ofProject = (pid) => snap.entities.filter((e) => e.project === pid);
  const urlOf = (e) => `${base}projects/${e.project}/${dirOf(e)}/${e.slug}/`;
  const purl = (p, sub = '') => `${base}projects/${p.id}/${sub}`;
  const pages = new Map();
  const put = (rel, html) => pages.set(rel.replace(/^\//, ''), html);

  // --- Markdown ---
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
  md.renderer.rules.table_close = () => '</table></div>';
  const defLink = md.renderer.rules.link_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const href = t.attrGet('href') || '';
    if (href.startsWith('hub:')) {
      const target = byId.get(href.slice(4));
      t.attrSet('href', target ? urlOf(target) : '#');
      if (!target) t.attrSet('class', 'broken');
    } else if (/^https?:/.test(href)) { t.attrSet('rel', 'noopener'); t.attrSet('class', 'ext'); }
    return defLink(tokens, idx, opts, env, self);
  };
  const defImg = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') || '';
    if (src.startsWith('media/')) t.attrSet('src', base + src);
    t.attrSet('loading', 'lazy');
    return defImg(tokens, idx, opts, env, self);
  };
  md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const text = tokens[idx + 1].children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
    let id = slugify(text), n = 2;
    env.ids ||= new Set();
    const b = id;
    while (env.ids.has(id)) id = `${b}-${n++}`;
    env.ids.add(id);
    t.attrSet('id', id);
    const level = Number(t.tag.slice(1));
    if (level === 2 || level === 3) (env.toc ||= []).push({ level, id, text });
    return self.renderToken(tokens, idx, opts);
  };
  const render = (src) => { const env = {}; const html = md.render(src || '', env); return { html, toc: env.toc || [] }; };
  const plain = (src) => md.render(src || '').replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();

  // --- общие блоки ---
  const chips = (e, { all = false } = {}) => Object.entries(STATE_DIMENSIONS).map(([dim, d]) => {
    const v = e.states?.[dim] || 'unknown';
    if (v === 'unknown' && !all) return '';
    return `<span class="chip chip-${dim} v-${v}"><span class="chip-k">${esc(d.label)}</span>${esc(d.values[v] || v)}</span>`;
  }).join('');
  const typeTag = (e) => `<span class="type type-${e.type}">${esc(ENTITY_TYPES[e.type]?.label || e.type)}</span>`;
  const refLine = (c) => `<a class="ext" rel="noopener" href="${esc(c.url)}">${esc(c.repo.split('/')[1])} ${c.kind === 'pr' || c.kind === 'issue' ? '#' + esc(c.ref) : esc(String(c.path || c.ref).slice(0, 40))}</a>${c.state ? ` <span class="ref-state s-${esc(c.state)}">${esc({ merged: 'влит', open: 'открыт', closed: 'закрыт' }[c.state] || c.state)}</span>` : ''}${c.title ? `<span class="ref-title">${esc(c.title)}</span>` : ''}`;
  // plain: карточка для каталога: только название и одна фраза. Состояния читаются внутри записи.
  const card = (e, { showProject = false, plain = false } = {}) => (plain
    ? `<a class="card card-plain" href="${urlOf(e)}"><strong>${esc(e.title)}</strong>${e.summary ? `<span class="card-sum">${esc(e.summary)}</span>` : ''}</a>`
    : `<a class="card" href="${urlOf(e)}">
    <span class="card-top">${typeTag(e)}${showProject ? `<span class="muted">${esc(projects.get(e.project)?.title || '')}</span>` : ''}</span>
    <strong>${esc(e.title)}</strong>${e.summary ? `<span class="card-sum">${esc(e.summary)}</span>` : ''}
    <span class="chips">${chips(e)}</span></a>`);

  // Спрайт из слоёв. Слой с tint окрашивается умножением, как в игре. Лист кадров (cols) анимируется.
  const spr = (layers, tint, { cls = '', cols = 0 } = {}) => `<span class="spr ${cls}"${cols ? ` style="--c:${cols}"` : ''}>${layers.map((l) => `<i${l.tint ? ' class="tint"' : ''} style="--img:url('${esc(base + l.file)}')${l.tint ? `;--tint:${esc(tint)}` : ''}"></i>`).join('')}</span>`;
  const FLY = [[14, 16, 7.5, 0], [70, 8, 9, -3], [82, 52, 8, -5], [6, 60, 10, -2], [44, 2, 11, -6], [58, 70, 9.5, -1], [28, 74, 8.5, -4], [90, 28, 10.5, -7]];
  const showcaseBlock = (p) => {
    const s = p.showcase;
    const target = s.entity && byId.get(s.entity);
    let n = 0;
    const flyers = s.flyers.flatMap((f) => Array.from({ length: f.count }, () => {
      const [x, y, d, delay] = FLY[n++ % FLY.length];
      return `<span class="flyer" style="left:${x}%;top:${y}%;animation-duration:${d}s;animation-delay:${delay}s">${spr(f.layers, s.tint, { cls: 'sheet', cols: f.cols })}</span>`;
    })).join('');
    return `<section class="show" aria-labelledby="show-title">
  <div class="show-text">
    ${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}
    <h2 id="show-title">${esc(s.title)}</h2>
    <p>${esc(s.text)}</p>
    <p class="show-actions"><a class="btn btn-primary" href="${target ? urlOf(target) : purl(p)}">${esc(s.cta)}</a><a href="${purl(p)}">Всё о проекте →</a></p>
  </div>
  <div class="show-scene" aria-hidden="true">
    <div class="show-stage">${spr(s.layers, s.tint, { cls: 'hero-spr' })}${flyers}</div>
    ${s.items.length ? `<ul class="show-items">${s.items.map((i) => `<li>${spr(i.layers, s.tint)}<span>${esc(i.label)}</span></li>`).join('')}</ul>` : ''}
  </div>
</section>`;
  };

  const layout = ({ title, description = '', body, project = null, tab = '', wide = false }) => {
    const nav = snap.projects.map((p) => `<a href="${purl(p)}"${project?.id === p.id ? ' aria-current="true"' : ''}>${esc(p.title)}</a>`).join('');
    let sub = '';
    if (project) {
      const ents = ofProject(project.id);
      const tabs = [
        ['', 'Обзор', true],
        ['wiki/', 'Wiki', ents.some((e) => e.type === 'article')],
        ['kb/', 'Каталог', ents.some((e) => dirOf(e) === 'kb')],
        ['roadmap/', 'Roadmap', ents.some((e) => e.roadmap)],
        ['devlog/', 'Devlog', ents.some((e) => e.type === 'devlog')],
        ['code/', 'Код и задачи', ents.some((e) => e.code_refs.length || e.type === 'task')],
      ].filter((t) => t[2]);
      sub = `<nav class="subnav" aria-label="Разделы проекта"><div class="wrap"><span class="subnav-title">${esc(project.title)}</span>${tabs.map(([s, l]) => `<a href="${purl(project, s)}"${tab === s ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</div></nav>`;
    }
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title === site.title ? '' : ` · ${esc(site.title)}`}</title>
${description ? `<meta name="description" content="${esc(description.slice(0, 200))}">` : ''}
<link rel="stylesheet" href="${base}assets/site.css">
<script>window.SITE_BASE=${JSON.stringify(base)}</script>
<script defer src="${base}assets/site.js"></script>
</head>
<body>
<a class="skip" href="#main">К содержимому</a>
<header class="top"><div class="wrap">
  <a class="brand" href="${base}">${esc(site.title)}</a>
  <nav class="topnav" aria-label="Проекты">${nav}</nav>
  <a class="search-link" href="${base}search/">Поиск</a>
</div></header>
${sub}
<main id="main" class="wrap${wide ? ' wide' : ''}">
${body}
</main>
<footer class="foot"><div class="wrap">
  <span>Собрано из базы знаний Developer Knowledge Hub.</span>
  <a href="${base}credits/">Атрибуция и лицензии</a>
  ${(site.links || []).map((l) => `<a class="ext" rel="noopener" href="${esc(l.url)}">${esc(l.title)}</a>`).join('')}
</div></footer>
</body>
</html>
`;
  };

  // --- календарь активности: только реальные данные ---
  const activityBlock = () => {
    const a = snap.activity;
    if (!a || !Array.isArray(a.days) || !a.days.length) {
      return `<div class="notice">Данные об активности на GitHub ещё не получены. Они загружаются при публикации сайта. Выдуманных значений здесь не бывает.${site.login ? ` <a class="ext" rel="noopener" href="https://github.com/${esc(site.login)}">Профиль на GitHub</a>` : ''}</div>`;
    }
    const days = a.days.slice(-371);
    const max = Math.max(1, ...days.map((d) => d.count));
    const lvl = (c) => (c === 0 ? 0 : Math.min(4, 1 + Math.floor((c / max) * 3.999)));
    const first = new Date(days[0].date + 'T00:00:00Z');
    const pad = (first.getUTCDay() + 6) % 7; // неделя с понедельника
    const cells = Array.from({ length: pad }, () => '<i class="pad"></i>')
      .concat(days.map((d) => `<i class="l${lvl(d.count)}" title="${fmtDate(d.date)}: ${d.count}"></i>`)).join('');
    const sum = days.reduce((s, d) => s + d.count, 0);
    return `<div class="activity" role="img" aria-label="Календарь активности на GitHub: ${sum} за год"><div class="activity-grid">${cells}</div></div>
<p class="muted small">${sum} ${plural(sum, 'вклад', 'вклада', 'вкладов')} за последний год по данным GitHub. Обновлено ${fmtDate(a.fetched_at.slice(0, 10))}. <a class="ext" rel="noopener" href="https://github.com/${esc(a.login)}">Профиль</a></p>`;
  };

  // --- главная ---
  // Первый экран: кто автор и один крупный материал, который хочется открыть. Остальные проекты показаны компактно.
  const recent = [...snap.entities].sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.title.localeCompare(b.title))).slice(0, 5);
  const featured = snap.projects.find((p) => p.showcase);
  const others = snap.projects.filter((p) => p !== featured);
  put('index.html', layout({
    title: site.title, description: site.intro, wide: true,
    body: `<section class="hero">
  <p class="eyebrow">${esc(site.role || '')}</p>
  <h1>${esc(site.title)}</h1>
  <p class="lead">${esc(site.intro || '')}</p>
</section>
${featured ? showcaseBlock(featured) : ''}
<div class="home-cols">
<section><h2>Что нового</h2>
${recent.length ? `<ul class="news">${recent.map((e) => `<li><a href="${urlOf(e)}"><strong>${esc(e.title)}</strong></a>${e.summary ? `<p>${esc(e.summary)}</p>` : ''}<time class="muted small" datetime="${esc(e.updated)}">${fmtDate(e.updated)}</time></li>`).join('')}</ul>` : '<p class="muted">Опубликованных материалов пока нет.</p>'}
</section>
<aside class="home-side">
${others.length || !featured ? `<section><h2>${featured ? 'Ещё проекты' : 'Проекты'}</h2><ul class="proj-list">${(featured ? others : snap.projects).map((p) => `<li><a href="${purl(p)}"><strong>${esc(p.title)}</strong></a><span class="muted">${esc(p.tagline)}</span></li>`).join('') || '<li class="muted">Проектов пока нет.</li>'}</ul></section>` : ''}
${site.tech?.length ? `<section><h2>Чем пользуюсь</h2><p class="tags">${site.tech.map((t) => `<span>${esc(t)}</span>`).join('')}</p></section>` : ''}
</aside>
</div>
<section><h2>Активность на GitHub</h2>${activityBlock()}</section>
${site.feedback_note ? `<p class="muted small feedback">${esc(site.feedback_note)}</p>` : ''}`,
  }));

  // --- страницы проектов ---
  const backlinks = new Map();
  for (const e of snap.entities) for (const l of e.links) { if (!backlinks.has(l.to)) backlinks.set(l.to, []); backlinks.get(l.to).push({ rel: l.rel, from: e.id, note: l.note }); }

  for (const p of snap.projects) {
    const ents = ofProject(p.id);
    const articles = ents.filter((e) => e.type === 'article').sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    const kb = ents.filter((e) => dirOf(e) === 'kb');
    const devlog = ents.filter((e) => e.type === 'devlog').sort((a, b) => (a.created < b.created ? 1 : -1));
    const road = ents.filter((e) => e.roadmap);
    const stale = ents.filter((e) => e.stale.length);
    const pr = render(p.body);
    const empty = `<div class="notice">Материалы по этому проекту ещё не опубликованы. Страница появится в полном виде, когда записи будут добавлены в базу знаний и разрешены к публикации.</div>`;

    put(`projects/${p.id}/index.html`, layout({
      title: p.title, description: p.tagline, project: p, tab: '',
      body: `<header class="page-head"><p class="eyebrow">Проект</p><h1>${esc(p.title)}</h1><p class="lead">${esc(p.tagline)}</p>
${p.status_note ? `<p class="status-note">${esc(p.status_note)}</p>` : ''}
<p class="link-row">${[...p.repos.map((r) => ({ title: r.repo, url: r.url })), ...p.links].map((l) => `<a class="ext" rel="noopener" href="${esc(l.url)}">${esc(l.title)}</a>`).join('')}</p></header>
<div class="prose">${pr.html}</div>
${!ents.length ? empty : ''}
${stale.length ? `<section><h2>Требует сверки</h2><p class="muted">Связанный код изменился после последней проверки этих страниц.</p><div class="grid">${stale.map((e) => card(e)).join('')}</div></section>` : ''}
${articles.length ? `<section><h2>Wiki</h2><div class="grid">${articles.map((e) => card(e)).join('')}</div></section>` : ''}
${road.length ? `<section><h2>Сейчас в работе</h2><div class="grid">${road.filter((e) => e.roadmap.lane === 'now').map((e) => card(e)).join('') || '<p class="muted">Нет карточек в работе.</p>'}</div><p><a href="${purl(p, 'roadmap/')}">Вся дорожная карта →</a></p></section>` : ''}
${kb.length ? `<section><h2>Механики, идеи и решения</h2><div class="grid">${kb.slice().sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 6).map((e) => card(e, { plain: true })).join('')}</div><p><a href="${purl(p, 'kb/')}">Весь каталог →</a></p></section>` : ''}`,
    }));

    if (articles.length) {
      put(`projects/${p.id}/wiki/index.html`, layout({
        title: `Wiki · ${p.title}`, project: p, tab: 'wiki/',
        body: `<header class="page-head"><h1>Wiki</h1><p class="lead">Статьи для чтения и изучения. Это самостоятельная веб-Wiki: она может быть подробнее внутриигрового руководства.</p></header><div class="grid">${articles.map((e) => card(e)).join('')}</div>`,
      }));
    }
    if (kb.length) {
      const groups = Object.keys(ENTITY_TYPES).map((t) => [t, kb.filter((e) => e.type === t).sort((a, b) => a.title.localeCompare(b.title, 'ru'))]).filter(([, l]) => l.length);
      put(`projects/${p.id}/kb/index.html`, layout({
        title: `Каталог · ${p.title}`, project: p, tab: 'kb/',
        body: `<header class="page-head"><h1>Каталог</h1><p class="lead">Механики, идеи и решения проекта. Что уже в игре, а что в работе, видно внутри каждой записи.</p>
<p class="link-row">${groups.map(([t, l]) => `<a href="#${t}">${esc(ENTITY_TYPES[t].plural)} <span class="muted">${l.length}</span></a>`).join('')}</p></header>
${groups.map(([t, l]) => `<section id="${t}"><h2>${esc(ENTITY_TYPES[t].plural)}</h2><div class="grid">${l.map((e) => card(e, { plain: true })).join('')}</div></section>`).join('')}`,
      }));
    }
    if (road.length) {
      put(`projects/${p.id}/roadmap/index.html`, layout({
        title: `Roadmap · ${p.title}`, project: p, tab: 'roadmap/', wide: true,
        // "В работе" идёт первым и во всю ширину. Пустые колонки не показываются.
        body: `<header class="page-head"><h1>Дорожная карта</h1><p class="lead">Над чем я работаю сейчас, что будет следом и что уже попало в игру.</p></header>
<div class="lanes">${['now', 'next', 'done', 'later'].map((lane) => { const l = road.filter((e) => e.roadmap.lane === lane).sort((a, b) => a.roadmap.order - b.roadmap.order || a.title.localeCompare(b.title, 'ru')); return l.length ? `<section class="lane lane-${lane}"><h2>${ROADMAP_LANES[lane]} <span class="muted">${l.length}</span></h2><div class="lane-cards">${l.map((e) => `<article class="rcard"><a href="${urlOf(e)}"><strong>${esc(e.title)}</strong></a>${e.summary ? `<p>${esc(e.summary)}</p>` : ''}${e.code_refs.length ? `<ul class="refs">${e.code_refs.map((c) => `<li>${refLine(c)}</li>`).join('')}</ul>` : ''}</article>`).join('')}</div></section>` : ''; }).join('')}</div>`,
      }));
    }
    if (devlog.length) {
      put(`projects/${p.id}/devlog/index.html`, layout({
        title: `Devlog, ${p.title}`, project: p, tab: 'devlog/',
        body: `<header class="page-head"><h1>Devlog</h1></header><ul class="changes">${devlog.map((e) => `<li><time datetime="${esc(e.created)}">${fmtDate(e.created)}</time><a href="${urlOf(e)}">${esc(e.title)}</a><span class="muted">${esc(e.summary)}</span></li>`).join('')}</ul>`,
      }));
    }
    const withCode = ents.filter((e) => e.code_refs.length);
    const tasks = ents.filter((e) => e.type === 'task');
    if (withCode.length || tasks.length) {
      put(`projects/${p.id}/code/index.html`, layout({
        title: `Код и задачи · ${p.title}`, project: p, tab: 'code/',
        body: `<header class="page-head"><h1>Код и задачи</h1><p class="lead">Какие PR, коммиты и задачи связаны с записями проекта. Состояния PR сверяются с GitHub командой <code>hub sync</code>.</p></header>
<div class="table-wrap"><table><thead><tr><th>Запись</th><th>Ссылка на код</th><th>Состояние записи</th></tr></thead><tbody>
${withCode.map((e) => `<tr><td><a href="${urlOf(e)}">${esc(e.title)}</a></td><td><ul class="refs">${e.code_refs.map((c) => `<li>${refLine(c)}</li>`).join('')}</ul></td><td><div class="chips">${chips(e)}</div></td></tr>`).join('')}
</tbody></table></div>
${tasks.length ? `<section><h2>Задачи</h2><div class="grid">${tasks.map((e) => card(e)).join('')}</div></section>` : ''}`,
      }));
    }

    // --- страницы записей ---
    for (const e of ents) {
      const r = render(e.body);
      const out = e.links.map((l) => ({ label: LINK_RELS[l.rel]?.label || l.rel, e: byId.get(l.to), note: l.note }));
      const inc = (backlinks.get(e.id) || []).map((l) => ({ label: LINK_RELS[l.rel]?.inverse || l.rel, e: byId.get(l.from), note: l.note }));
      const rel = [...out, ...inc].filter((x) => x.e);
      const relGroups = [...new Set(rel.map((x) => x.label))].map((label) => [label, rel.filter((x) => x.label === label)]);
      const isArticle = e.type === 'article';
      const side = `
${r.toc.length > 1 ? `<details class="toc" open><summary>На странице</summary><ul>${r.toc.map((t) => `<li class="t${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></details>` : ''}
${relGroups.length ? `<section class="side-block"><h2>Связи</h2>${relGroups.map(([label, items]) => `<p class="rel-label">${esc(label)}</p><ul>${items.map((x) => `<li><a href="${urlOf(x.e)}">${esc(x.e.title)}</a> <span class="muted small">${esc(ENTITY_TYPES[x.e.type]?.label || '')}</span>${x.note ? `<span class="muted small">, ${esc(x.note)}</span>` : ''}</li>`).join('')}</ul>`).join('')}</section>` : ''}
${e.code_refs.length ? `<section class="side-block"><h2>Код и задачи</h2><ul class="refs">${e.code_refs.map((c) => `<li>${refLine(c)}</li>`).join('')}</ul></section>` : ''}
${e.references.length ? `<section class="side-block"><h2>Источники</h2><ul>${e.references.map((x) => `<li><a class="ext" rel="noopener" href="${esc(x.url)}">${esc(x.title)}</a></li>`).join('')}</ul></section>` : ''}
<section class="side-block meta"><p>Обновлено ${fmtDate(e.updated)} · ревизия ${e.revision}</p>${e.docs_reviewed ? `<p>Сверено с кодом ${fmtDate(e.docs_reviewed)}</p>` : ''}<p><a href="${base}e/${e.id}/">Постоянная ссылка</a></p></section>`;
      put(`projects/${p.id}/${dirOf(e)}/${e.slug}/index.html`, layout({
        title: e.title, description: e.summary, project: p, tab: `${dirOf(e)}/`, wide: true,
        body: `<div class="doc${isArticle ? ' doc-wiki' : ''}">
${isArticle && articles.length > 1 ? `<nav class="doc-nav" aria-label="Статьи Wiki"><details open><summary>Статьи</summary><ul>${articles.map((a) => `<li><a href="${urlOf(a)}"${a.id === e.id ? ' aria-current="page"' : ''}>${esc(a.title)}</a></li>`).join('')}</ul></details></nav>` : ''}
<article class="doc-main">
<p class="crumbs"><a href="${purl(p)}">${esc(p.title)}</a> / <a href="${purl(p, dirOf(e) + '/')}">${{ wiki: 'Wiki', kb: 'Каталог', devlog: 'Devlog' }[dirOf(e)]}</a></p>
<header class="doc-head">${typeTag(e)}<h1>${esc(e.title)}</h1>${e.summary ? `<p class="lead">${esc(e.summary)}</p>` : ''}
<div class="chips">${chips(e, { all: !isArticle && e.type !== 'devlog' })}</div>
${e.ingame_url ? `<p><a class="btn ext" rel="noopener" href="${esc(e.ingame_url)}">Открыть в режиме "как в игре"</a> <span class="muted small">Отдельное представление в оформлении игрового руководства.</span></p>` : ''}</header>
${e.stale.length ? `<aside class="stale" role="note"><strong>Страница может быть устаревшей.</strong> После последней сверки (${fmtDate(e.docs_reviewed)}) изменился связанный код:<ul>${e.stale.map((s) => `<li>${s.url ? `<a class="ext" rel="noopener" href="${esc(s.url)}">${esc(s.repo)} ${s.kind === 'pr' ? '#' : ''}${esc(s.ref)}</a>${s.title ? `, ${esc(s.title)}` : ''}, ${fmtDate(s.date)}` : `связанное изменение от ${fmtDate(s.date)}`}</li>`).join('')}</ul></aside>` : ''}
<div class="prose">${r.html || '<p class="muted">Текст ещё не написан.</p>'}</div>
</article>
<aside class="doc-side">${side}</aside>
</div>`,
      }));
      const redirect = (to) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(e.title)}</title><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"></head><body><p><a href="${to}">${esc(e.title)}</a></p></body></html>\n`;
      put(`e/${e.id}/index.html`, redirect(urlOf(e)));
      for (const a of e.aliases) {
        const rel2 = `projects/${p.id}/${dirOf(e)}/${a}/index.html`;
        if (!pages.has(rel2)) put(rel2, redirect(urlOf(e)));
      }
    }
  }

  // --- поиск, атрибуция, 404 ---
  const index = snap.entities.map((e) => ({ t: e.title, s: e.summary, u: urlOf(e), p: projects.get(e.project)?.title || '', k: ENTITY_TYPES[e.type]?.label || e.type, x: plain(e.body).slice(0, 4000) }));
  put('search/index.html', layout({
    title: 'Поиск',
    body: `<header class="page-head"><h1>Поиск</h1></header>
<input id="q" class="search-input" type="search" placeholder="Например: воск, рой, признаки" aria-label="Поисковый запрос" autofocus>
<p id="search-status" class="muted small" aria-live="polite">Поиск работает по опубликованным материалам.</p><div id="results" class="results"></div>`,
  }));
  put('credits/index.html', layout({
    title: 'Атрибуция и лицензии',
    body: `<header class="page-head"><h1>Атрибуция и лицензии</h1></header><div class="prose">
<p>Сайт использует системные шрифты и собственное оформление. Игровые ресурсы показываются только с указанием автора и лицензии.</p>
${snap.credits.length ? `<div class="table-wrap"><table><thead><tr><th>Файл</th><th>Автор</th><th>Лицензия</th><th>Источник</th></tr></thead><tbody>${snap.credits.map((c) => `<tr><td>${esc(c.file)}</td><td>${esc(c.author)}</td><td>${esc(c.license)}</td><td>${/^https?:/.test(c.source) ? `<a class="ext" rel="noopener" href="${esc(c.source)}">${esc(c.source)}</a>` : esc(c.source)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Сейчас на сайте нет сторонних изображений и других медиафайлов.</p>'}</div>`,
  }));
  put('404.html', layout({ title: 'Страница не найдена', body: `<header class="page-head"><h1>Страница не найдена</h1><p class="lead">Возможно, материал переименован или снят с публикации.</p><p><a href="${base}">На главную</a> · <a href="${base}search/">Поиск</a></p></header>` }));

  // --- запись ---
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [rel, html] of pages) {
    const f = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
  }
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(path.join(HERE, 'assets'))) fs.copyFileSync(path.join(HERE, 'assets', f), path.join(outDir, 'assets', f));
  fs.writeFileSync(path.join(outDir, 'search-index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  const mediaDir = path.join(contentDir, 'media');
  if (fs.existsSync(mediaDir)) fs.cpSync(mediaDir, path.join(outDir, 'media'), { recursive: true });
  return { pages: pages.size, entities: snap.entities.length, projects: snap.projects.length, outDir, hasActivity: !!snap.activity };
}
