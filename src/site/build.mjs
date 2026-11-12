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
  // Схема: строки вида "-> Название {media/файл.png} | пояснение". Спрайт: слои через "+", "*" отмечает окрашиваемый слой, "@3" задаёт лист из 3 кадров.
  const flowSpr = (spec, tint) => {
    const parts = spec.split('+').map((x) => x.trim()).filter(Boolean);
    if (!parts.length || !parts.every((x) => /^media\/[\w./-]+?\*?(@\d)?$/.test(x))) return '';
    const cols = Number((/@(\d)$/.exec(parts[0]) || [])[1]) || 0;
    return spr(parts.map((x) => { const f = x.replace(/@\d$/, ''); return { file: f.replace(/\*$/, ''), tint: f.endsWith('*') }; }), tint, { cls: cols ? 'sheet' : '', cols });
  };
  const defFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const lang = t.info.trim();
    if (lang === 'flow') {
      let title = '';
      const steps = [];
      for (const l of t.content.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const m = /^title:\s*(.+)$/i.exec(l);
        if (m) { title = m[1]; continue; }
        const [head, note = ''] = l.replace(/^->\s*/, '').split('|').map((x) => x.trim());
        const sm = /\{([^}]+)\}/.exec(head);
        steps.push({ text: head.replace(/\{[^}]+\}/, '').trim(), spr: sm ? sm[1] : '', note });
      }
      return `<figure class="flow">${title ? `<figcaption>${esc(title)}</figcaption>` : ''}<ol>${steps.map((x) => `<li>${x.spr ? flowSpr(x.spr, env.tint) : ''}<strong>${esc(x.text)}</strong>${x.note ? `<span>${esc(x.note)}</span>` : ''}</li>`).join('')}</ol></figure>`;
    }
    if (lang === 'hive') {
      let p = null;
      try { p = JSON.parse(t.content); } catch { /* показываем как обычный код */ }
      if (p) {
        const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
        const safe = { start: num(p.start, 5), perFrame: num(p.perFrame, 5), maxFrames: Math.min(num(p.maxFrames, 4), 12), layMinutes: num(p.layMinutes, 1), eggMinutes: num(p.eggMinutes, 3), cols: num(p.cols, 1), bee: /^media\/[\w./-]+$/.test(p.bee || '') ? base + p.bee : '' };
        return `<div class="hive-sim" data-p="${esc(JSON.stringify(safe))}"><p class="muted">Здесь интерактивная модель роста колонии. Для неё нужен JavaScript.</p></div>`;
      }
    }
    return defFence(tokens, idx, opts, env, self);
  };
  md.renderer.rules.code_inline = (tokens, idx) => {
    const c = tokens[idx].content;
    return /^#[0-9a-fA-F]{6}$/.test(c) ? `<code class="sw"><i style="background:${c}"></i>${c}</code>` : `<code>${esc(c)}</code>`;
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
  // Рабочие названия разделов базы знаний читателю сайта показываются человеческими словами.
  const HEADINGS = { 'Предлагаемые механики': 'Как это работает', 'Известные факты': 'Что уже известно', 'Суть': 'Коротко', 'Назначение': 'Зачем это нужно', 'Следующий шаг': 'Что дальше' };
  const friendly = (src) => String(src || '').replace(/^## (.+)$/gm, (m, t) => (HEADINGS[t.trim()] ? '## ' + HEADINGS[t.trim()] : m));
  const render = (src, tint = '#E8A21C') => { const env = { tint }; const html = md.render(friendly(src), env); return { html, toc: env.toc || [] }; };
  const tintOf = (p) => p?.showcase?.tint || '#E8A21C';
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
  // Одна человеческая фраза о том, где сейчас механика. Это подпись к измерению "Код", а не новый статус.
  const badge = (e) => (e.type === 'article' || e.type === 'devlog' ? '' : ({ merged: 'уже в игре', released: 'уже в игре', pr: 'на ревью', local: 'в разработке', none: 'в планах' }[e.states?.implementation] || ''));
  const ico = (e, cls = '') => (e.icon ? spr(e.icon.layers, e.icon.tint, { cls: `${e.icon.cols ? 'sheet ' : ''}${cls}`, cols: e.icon.cols }) : '');
  const card = (e, { showProject = false, plain = false, badge: withBadge = false } = {}) => (plain
    ? `<a class="card card-plain" href="${urlOf(e)}">${ico(e)}<span class="card-body">${withBadge && badge(e) ? `<span class="badge b-${esc(e.states.implementation)}">${esc(badge(e))}</span>` : ''}<strong>${esc(e.title)}</strong>${e.summary ? `<span class="card-sum">${esc(e.summary)}</span>` : ''}</span></a>`
    : `<a class="card" href="${urlOf(e)}">
    <span class="card-top">${typeTag(e)}${showProject ? `<span class="muted">${esc(projects.get(e.project)?.title || '')}</span>` : ''}</span>
    <strong>${esc(e.title)}</strong>${e.summary ? `<span class="card-sum">${esc(e.summary)}</span>` : ''}
    <span class="chips">${chips(e)}</span></a>`);

  // Спрайт из слоёв. Слой с tint окрашивается умножением, как в игре. Лист кадров (cols) анимируется.
  const spr = (layers, tint, { cls = '', cols = 0 } = {}) => `<span class="spr ${cls}"${cols ? ` style="--c:${cols}"` : ''}>${layers.map((l) => `<i${l.tint ? ' class="tint"' : ''} style="--img:url('${esc(base + l.file)}')${l.tint ? `;--tint:${esc(tint)}` : ''}"></i>`).join('')}</span>`;
  const FLY = [[14, 16, 7.5, 0], [70, 8, 9, -3], [82, 52, 8, -5], [6, 60, 10, -2], [44, 2, 11, -6], [58, 70, 9.5, -1], [28, 74, 8.5, -4], [90, 28, 10.5, -7]];
  // --- карта связей ---
  // Строится при сборке, без JavaScript: записи раскладываются по слоям слева направо
  // (слева то, от чего зависят, справа то, что на этом построено). Линии рисуются SVG под карточками.
  const LAYER_RELS = new Set(['depends-on', 'part-of', 'documents', 'decided-by', 'evidence-for', 'implements', 'supersedes', 'rejects']);
  const REL_NOTE = { 'depends-on': 'нужно для', 'part-of': 'включает', documents: 'описано в', 'decided-by': 'определяет', 'evidence-for': 'обосновано в', implements: 'реализовано в', supersedes: 'заменено на', rejects: 'отклонено в', relates: 'связано' };
  const graphBlock = (list, { current = null, label = 'Карта связей' } = {}) => {
    const ids = new Set(list.map((e) => e.id));
    const edges = list.flatMap((e) => e.links.filter((l) => ids.has(l.to) && l.to !== e.id).map((l) => ({ from: e.id, to: l.to, rel: l.rel })));
    if (!edges.length) return '';
    const nodes = list.filter((e) => edges.some((x) => x.from === e.id || x.to === e.id));
    const depth = new Map();
    const dep = (id, seen = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const outs = edges.filter((x) => x.from === id && LAYER_RELS.has(x.rel));
      const d = outs.length ? 1 + Math.max(...outs.map((x) => dep(x.to, seen))) : 0;
      depth.set(id, d);
      return d;
    };
    nodes.forEach((e) => dep(e.id));
    const W = 232, H = 72, GX = 84, GY = 18;
    const cols = [];
    for (const e of nodes) (cols[depth.get(e.id)] ||= []).push(e);
    const row = new Map();
    cols.forEach((col, d) => {
      const bary = (e) => { const ps = edges.filter((x) => x.from === e.id && row.has(x.to)).map((x) => row.get(x.to)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1e3; };
      col.sort((a, b) => (d ? bary(a) - bary(b) : 0) || a.title.localeCompare(b.title, 'ru'));
      col.forEach((e, i) => row.set(e.id, i));
    });
    const maxRows = Math.max(...cols.map((c) => c.length));
    const pos = new Map();
    cols.forEach((col, d) => col.forEach((e, i) => pos.set(e.id, { x: d * (W + GX), y: i * (H + GY) + ((maxRows - col.length) * (H + GY)) / 2 })));
    const width = cols.length * W + (cols.length - 1) * GX, height = maxRows * H + (maxRows - 1) * GY;
    const used = [...new Set(edges.map((x) => x.rel))];
    const paths = edges.map((x) => {
      const a = pos.get(x.to), b = pos.get(x.from); // от основы к зависящему
      let d;
      if (a.x === b.x) {
        const [t, u] = a.y < b.y ? [a, b] : [b, a];
        d = `M${t.x + W / 2},${t.y + H} L${u.x + W / 2},${u.y}`;
      } else {
        const [l, r] = a.x < b.x ? [a, b] : [b, a];
        const x1 = l.x + W, y1 = l.y + H / 2, x2 = r.x, y2 = r.y + H / 2, c = (x2 - x1) / 2;
        d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
      }
      const hot = current && (x.from === current || x.to === current);
      return `<path class="ge r-${esc(x.rel)}${hot ? ' hot' : ''}" d="${d}"><title>${esc(byId.get(x.to).title)} → ${esc(REL_NOTE[x.rel] || x.rel)} → ${esc(byId.get(x.from).title)}</title></path>`;
    }).join('');
    return `<div class="graph-wrap" role="group" aria-label="${esc(label)}"><div class="graph" style="width:${width}px;height:${height}px">
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${paths}</svg>
${nodes.map((e) => { const p0 = pos.get(e.id); return `<a class="gnode${e.id === current ? ' cur' : ''}" style="left:${p0.x}px;top:${p0.y}px;width:${W}px;height:${H}px" href="${urlOf(e)}"${e.id === current ? ' aria-current="page"' : ''}>${ico(e)}<span><strong>${esc(e.title)}</strong><small>${esc([ENTITY_TYPES[e.type]?.label, badge(e)].filter(Boolean).join(' · '))}</small></span></a>`; }).join('')}
</div></div>
<p class="graph-legend muted small">Слева основа, справа то, что на ней построено. ${used.map((r) => `<span><i class="lg r-${esc(r)}"></i>${esc(REL_NOTE[r] || r)}</span>`).join('')}</p>`;
  };

  const votes = snap.feedback?.items || {};
  const voteBlock = (e) => {
    const v = votes[e.id];
    if (!v) return '';
    const total = v.like + v.ok + v.dislike;
    const bar = (n, cls, label, emoji) => `<div class="vote ${cls}"><span class="vote-e" aria-hidden="true">${emoji}</span><strong>${n}</strong><span>${label}</span><i style="--w:${total ? Math.round((n / total) * 100) : 0}%"></i></div>`;
    return `<section class="votes" aria-label="Оценки посетителей"><div class="sec-head"><h2>Как вам?</h2><a class="btn ext" rel="noopener" href="${esc(v.url)}">Проголосовать на GitHub</a></div>
<div class="vote-row">${bar(v.like, 'v-like', 'нравится', '👍')}${bar(v.ok, 'v-ok', 'нормально', '😕')}${bar(v.dislike, 'v-dislike', 'не нравится', '👎')}</div>
<p class="muted small">${total ? `Голосов: ${total}` : 'Голосов пока нет'} · комментариев: ${v.comments} · данные GitHub на ${fmtDate(snap.feedback.fetched_at.slice(0, 10))}. Голос это реакция под обсуждением, один на аккаунт. Оценки показывают мнение игроков и не меняют состояние механики.</p></section>`;
  };
  const feedOf = (ents) => {
    const seen = new Set();
    const out = [];
    for (const e of [...ents].sort((a, b) => (a.type === 'mechanic' ? 0 : 1) - (b.type === 'mechanic' ? 0 : 1))) {
      for (const c of e.code_refs) {
        if (!c.merged_at || seen.has(c.url)) continue;
        seen.add(c.url);
        out.push({ date: c.merged_at.slice(0, 10), title: c.title || e.title, e, url: c.url, ref: `${c.repo.split('/')[1]}${c.kind === 'pr' ? ' #' + c.ref : ''}` });
      }
      if (e.type === 'devlog') out.push({ date: e.created, title: e.title, e, url: null, text: e.summary });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  };
  const feedList = (items) => `<ol class="feed">${items.map((i) => `<li>${ico(i.e) || '<span class="feed-dot"></span>'}<div class="card-body"><time class="muted small" datetime="${esc(i.date)}">${fmtDate(i.date)}</time><strong>${esc(i.title)}</strong><span class="feed-meta">${i.text ? esc(i.text) : `<a href="${urlOf(i.e)}">${esc(i.e.title)}</a>`}${i.url ? ` · <a class="ext" rel="noopener" href="${esc(i.url)}">${esc(i.ref)}</a>` : ''}</span></div></li>`).join('')}</ol>`;

  const showcaseBlock = (p, { self = false } = {}) => {
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
    <p class="show-actions"><a class="btn btn-primary" href="${target ? urlOf(target) : purl(p)}">${esc(s.cta)}</a>${self ? '' : `<a href="${purl(p)}">Всё о проекте →</a>`}</p>
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
        ['map/', 'Карта', ents.some((e) => e.links.some((l) => byId.get(l.to)?.project === project.id))],
        ['devlog/', 'Лента', ents.some((e) => e.type === 'devlog' || e.code_refs.some((c) => c.merged_at))],
        ['why/', 'Почему так', ents.some((e) => e.type === 'decision')],
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
  const homeFeed = feedOf(snap.entities);
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
<section><h2>${homeFeed.length ? 'Что появилось в игре' : 'Что нового'}</h2>
${homeFeed.length ? feedList(homeFeed.slice(0, 5)) : recent.length ? `<ul class="news">${recent.map((e) => `<li>${ico(e)}<div class="card-body"><a href="${urlOf(e)}"><strong>${esc(e.title)}</strong></a>${e.summary ? `<p>${esc(e.summary)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="muted">Опубликованных материалов пока нет.</p>'}
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
    const pr = render(p.body, tintOf(p));
    const empty = `<div class="notice">Материалы по этому проекту ещё не опубликованы. Страница появится в полном виде, когда записи будут добавлены в базу знаний и разрешены к публикации.</div>`;

    put(`projects/${p.id}/index.html`, layout({
      title: p.title, description: p.tagline, project: p, tab: '',
      wide: true,
      body: `<header class="page-head"><p class="eyebrow">Проект</p><h1>${esc(p.title)}</h1><p class="lead">${esc(p.tagline)}</p>
${p.status_note ? `<p class="status-note">${esc(p.status_note)}</p>` : ''}</header>
${p.showcase ? showcaseBlock(p, { self: true }) : ''}
${!ents.length ? empty : ''}
${road.some((e) => e.roadmap.lane === 'now') ? `<section><div class="sec-head"><h2>Сейчас в работе</h2><a href="${purl(p, 'roadmap/')}">Вся дорожная карта →</a></div><div class="grid">${road.filter((e) => e.roadmap.lane === 'now').sort((a, b) => a.roadmap.order - b.roadmap.order).map((e) => card(e, { plain: true, badge: true })).join('')}</div></section>` : ''}
${articles.length ? `<section><div class="sec-head"><h2>Wiki</h2>${articles.length > 3 ? `<a href="${purl(p, 'wiki/')}">Все статьи →</a>` : ''}</div><div class="grid grid-wide">${articles.slice(0, 4).map((e) => card(e, { plain: true })).join('')}</div></section>` : ''}
${kb.length ? `<section><div class="sec-head"><h2>Механики и идеи</h2><a href="${purl(p, 'kb/')}">Весь каталог →</a></div><div class="grid">${kb.slice().sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 6).map((e) => card(e, { plain: true, badge: true })).join('')}</div></section>` : ''}
${pr.html ? `<section class="about"><h2>О проекте</h2><div class="prose">${pr.html}</div>
<p class="link-row">${[...p.repos.map((r) => ({ title: r.repo, url: r.url })), ...p.links].map((l) => `<a class="ext" rel="noopener" href="${esc(l.url)}">${esc(l.title)}</a>`).join('')}</p></section>` : ''}`,
    }));

    if (articles.length) {
      put(`projects/${p.id}/wiki/index.html`, layout({
        title: `Wiki · ${p.title}`, project: p, tab: 'wiki/',
        body: `<header class="page-head"><h1>Wiki</h1><p class="lead">Статьи для чтения и изучения. Это самостоятельная веб-Wiki: она может быть подробнее внутриигрового руководства.</p></header><div class="grid grid-wide">${articles.map((e) => card(e, { plain: true })).join('')}</div>`,
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
<div class="lanes">${['now', 'next', 'done', 'later'].map((lane) => { const l = road.filter((e) => e.roadmap.lane === lane).sort((a, b) => a.roadmap.order - b.roadmap.order || a.title.localeCompare(b.title, 'ru')); return l.length ? `<section class="lane lane-${lane}"><h2>${ROADMAP_LANES[lane]} <span class="muted">${l.length}</span></h2><div class="lane-cards">${l.map((e) => `<article class="rcard">${ico(e)}<div class="card-body"><a href="${urlOf(e)}"><strong>${esc(e.title)}</strong></a>${e.summary ? `<p>${esc(e.summary)}</p>` : ''}${e.code_refs.length ? `<ul class="refs">${e.code_refs.map((c) => `<li>${refLine(c)}</li>`).join('')}</ul>` : ''}</div></article>`).join('')}</div></section>` : ''; }).join('')}</div>`,
      }));
    }
    const map = graphBlock(ents, { label: `Карта связей проекта ${p.title}` });
    if (map) {
      put(`projects/${p.id}/map/index.html`, layout({
        title: `Карта · ${p.title}`, project: p, tab: 'map/', wide: true,
        body: `<header class="page-head"><h1>Карта связей</h1><p class="lead">Как механики, статьи и решения проекта держатся друг за друга. Каждая карточка открывает запись.</p></header>${map}`,
      }));
    }
    const feed = feedOf(ents);
    if (feed.length) {
      put(`projects/${p.id}/devlog/index.html`, layout({
        title: `Лента · ${p.title}`, project: p, tab: 'devlog/',
        body: `<header class="page-head"><h1>Лента изменений</h1><p class="lead">Что и когда попало в игру. Записи появляются сами, когда связанный PR вливается в основную ветку.</p></header>${feedList(feed)}`,
      }));
    }
    // "Почему так": принятые решения и варианты, от которых отказались.
    const decisions = ents.filter((e) => e.type === 'decision').sort((a, b) => (a.updated < b.updated ? 1 : -1));
    if (decisions.length) {
      const rejected = (e) => (/(?:^|\n)## Отклонённые варианты\s*\n([\s\S]*?)(?=\n## |$)/.exec(e.body) || [])[1] || '';
      put(`projects/${p.id}/why/index.html`, layout({
        title: `Почему так · ${p.title}`, project: p, tab: 'why/',
        body: `<header class="page-head"><h1>Почему так</h1><p class="lead">Решения, которые определили механики, и варианты, от которых я отказался, с причинами.</p></header>
<div class="why">${decisions.map((e) => `<article class="why-card"><h2><a href="${urlOf(e)}">${esc(e.title)}</a></h2>${e.summary ? `<p class="lead">${esc(e.summary)}</p>` : ''}${rejected(e) ? `<div class="why-no"><p class="eyebrow">Не сделали</p><div class="prose">${render(rejected(e), tintOf(p)).html}</div></div>` : ''}</article>`).join('')}</div>`,
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
      const r = render(e.body, tintOf(p));
      const out = e.links.map((l) => ({ label: LINK_RELS[l.rel]?.label || l.rel, e: byId.get(l.to), note: l.note }));
      const inc = (backlinks.get(e.id) || []).map((l) => ({ label: LINK_RELS[l.rel]?.inverse || l.rel, e: byId.get(l.from), note: l.note }));
      const rel = [...out, ...inc].filter((x) => x.e);
      const relGroups = [...new Set(rel.map((x) => x.label))].map((label) => [label, rel.filter((x) => x.label === label)]);
      const isArticle = e.type === 'article';
      const hasNav = isArticle && articles.length > 1;
      const stateRows = Object.entries(STATE_DIMENSIONS).filter(([dim]) => (e.states?.[dim] || 'unknown') !== 'unknown')
        .map(([dim, d]) => `<div><dt>${esc(d.label)}</dt><dd class="v-${esc(e.states[dim])}">${esc(d.values[e.states[dim]] || e.states[dim])}</dd></div>`).join('');
      const side = `
${r.toc.length > 1 ? `<details class="toc" open><summary>На странице</summary><ul>${r.toc.map((t) => `<li class="t${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></details>` : ''}
${stateRows && !isArticle ? `<section class="side-block"><h2>Состояние</h2><dl class="states">${stateRows}</dl></section>` : ''}
${e.code_refs.length ? `<section class="side-block"><h2>Код и задачи</h2><ul class="refs">${e.code_refs.map((c) => `<li>${refLine(c)}</li>`).join('')}</ul></section>` : ''}
${e.references.length ? `<section class="side-block"><h2>По теме</h2><ul class="src-list">${e.references.map((x) => `<li><a class="src" rel="noopener" href="${esc(x.url)}"><strong>${esc(x.title)}</strong><small>${esc(new URL(x.url).hostname.replace(/^www\./, ''))}</small></a></li>`).join('')}</ul></section>` : ''}
<section class="side-block"><h2>О странице</h2><dl class="meta-list"><div><dt>Обновлено</dt><dd>${fmtDate(e.updated)}</dd></div>${e.docs_reviewed ? `<div><dt>Сверено с игрой</dt><dd class="${e.stale.length ? 'v-stale' : 'v-ok'}">${fmtDate(e.docs_reviewed)}</dd></div>` : ''}<div><dt>Правок</dt><dd>${e.revision}</dd></div></dl><p class="small"><a href="${base}e/${e.id}/">Постоянная ссылка</a></p></section>`;
      put(`projects/${p.id}/${dirOf(e)}/${e.slug}/index.html`, layout({
        title: e.title, description: e.summary, project: p, tab: `${dirOf(e)}/`, wide: true,
        body: `<header class="rec-head${e.icon ? ' has-art' : ''}">
<div class="rec-head-text">
<p class="crumbs"><a href="${purl(p)}">${esc(p.title)}</a> / <a href="${purl(p, dirOf(e) + '/')}">${{ wiki: 'Wiki', kb: 'Каталог', devlog: 'Devlog' }[dirOf(e)]}</a></p>
<p class="eyebrow">${esc(ENTITY_TYPES[e.type]?.label || e.type)}${badge(e) ? ` · ${esc(badge(e))}` : ''}</p>
<h1>${esc(e.title)}</h1>${e.summary ? `<p class="lead">${esc(e.summary)}</p>` : ''}
${e.ingame_url ? `<p class="rec-actions"><a class="btn ext" rel="noopener" href="${esc(e.ingame_url)}">Открыть в режиме "как в игре"</a><span class="muted small">Та же тема в оформлении игрового руководства</span></p>` : ''}
</div>
${e.icon ? `<div class="rec-art" aria-hidden="true">${ico(e, 'art-spr')}</div>` : ''}
</header>
<div class="doc${hasNav ? ' doc-wiki' : ''}">
${hasNav ? `<nav class="doc-nav" aria-label="Статьи Wiki"><details open><summary>Статьи</summary><ul>${articles.map((a) => `<li><a href="${urlOf(a)}"${a.id === e.id ? ' aria-current="page"' : ''}>${esc(a.title)}</a></li>`).join('')}</ul></details></nav>` : ''}
<article class="doc-main">
${e.stale.length ? `<aside class="stale" role="note"><strong>Страница может быть устаревшей.</strong> После последней сверки (${fmtDate(e.docs_reviewed)}) изменился связанный код:<ul>${e.stale.map((s) => `<li>${s.url ? `<a class="ext" rel="noopener" href="${esc(s.url)}">${esc(s.repo)} ${s.kind === 'pr' ? '#' : ''}${esc(s.ref)}</a>${s.title ? `, ${esc(s.title)}` : ''}, ${fmtDate(s.date)}` : `связанное изменение от ${fmtDate(s.date)}`}</li>`).join('')}</ul></aside>` : ''}
<div class="prose">${r.html || '<p class="muted">Текст ещё не написан.</p>'}</div>
${voteBlock(e)}
${(e.changes || []).length ? `<section class="changes-ba"><h2>Что изменилось</h2>${e.changes.map((ch) => { const c = e.code_refs.find((x) => String(x.ref) === String(ch.ref)); return `<div class="ba"><p class="ba-head">${c ? `<a class="ext" rel="noopener" href="${esc(c.url)}">${esc(c.repo.split('/')[1])} #${esc(c.ref)}</a>${c.merged_at ? ` · в игре с ${fmtDate(c.merged_at.slice(0, 10))}` : ''}` : esc(ch.title || '')}</p><div class="table-wrap"><table><thead><tr><th>Что</th><th>Было</th><th>Стало</th></tr></thead><tbody>${ch.items.map((i) => `<tr><td>${esc(i.what)}</td><td class="ba-before">${esc(i.before)}</td><td class="ba-after">${esc(i.after)}</td></tr>`).join('')}</tbody></table></div></div>`; }).join('')}</section>` : ''}
${rel.length ? `<section class="related"><div class="sec-head"><h2>Связи</h2><a href="${purl(p, 'map/')}">Вся карта проекта →</a></div>${graphBlock([e, ...new Set(rel.map((x) => x.e))], { current: e.id, label: `Связи записи "${e.title}"` })}</section>` : ''}
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
