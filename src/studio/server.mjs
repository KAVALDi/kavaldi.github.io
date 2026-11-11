// Студия: локальный редакторский интерфейс. Слушает только 127.0.0.1, проверяет Host и требует
// собственный заголовок у изменяющих запросов (защита от обращений с посторонних сайтов).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '../core/store.mjs';
import * as schema from '../core/schema.mjs';
import { analyze, retarget, approve, setVisibility, searchEntities } from '../core/importer.mjs';
import { buildPublicSnapshot, staleness, sanitizeBody, internalParts } from '../core/exporter.mjs';
import { release, gitStatus } from '../core/release.mjs';
import { syncCodeRefs } from '../core/github.mjs';
import { diffLines, diffStats } from '../core/text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_BODY = 3 * 1024 * 1024;

const metaOf = (store, e) => ({
  id: e.id, type: e.type, project: e.project, title: e.title, slug: e.slug, summary: e.summary, visibility: e.visibility,
  states: e.states, roadmap: e.roadmap || null, updated: e.updated, revision: e.revision, stale: staleness(store, e).length,
  sources: e.provenance.length,
});

function publicPreview(store, id) {
  const e = store.entities.get(id);
  const project = store.projects.get(e.project);
  const saved = e.visibility;
  e.visibility = 'public';
  try {
    const snap = buildPublicSnapshot(store);
    const pub = snap.entities.find((x) => x.id === id) || null;
    return {
      entity: pub,
      projectPublic: project?.visibility === 'public',
      withheld: {
        provenance: e.provenance.length,
        internalLines: internalParts(e.body).length,
        links: e.links.length - (pub ? pub.links.length : 0),
        code_refs: e.code_refs.length - (pub ? pub.code_refs.length : 0),
      },
    };
  } catch (err) { return { error: err.message }; } finally { e.visibility = saved; }
}

export function createStudio({ storePath, repoRoot, port = 4319 }) {
  const store = new Store(storePath);
  const previewDir = path.join(repoRoot, '.cache', 'preview');

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const need = (id) => { const e = store.entities.get(id); if (!e) throw new StoreError('Запись не найдена.', 'not_found'); return e; };
  const title = (id) => store.entities.get(id)?.title || null;

  on('GET', '/api/state', () => ({
    storePath: store.root,
    schema: { types: schema.ENTITY_TYPES, states: schema.STATE_DIMENSIONS, rels: schema.LINK_RELS, provenance: schema.PROVENANCE_KINDS, confidence: schema.CONFIDENCE, lanes: schema.ROADMAP_LANES, codeKinds: schema.CODE_REF_KINDS },
    projects: [...store.projects.values()].map((p) => ({ id: p.id, title: p.title, visibility: p.visibility, public_repos: p.public_repos || [] })),
    entities: [...store.entities.values()].map((e) => metaOf(store, e)).sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.title.localeCompare(b.title, 'ru'))),
    drafts: store.drafts().map((d) => ({ id: d.id, created: d.created, status: d.status, title: d.source.title, action: d.action, project: d.project.id, size: d.source.size })),
    problems: store.problems,
    sources: store.sources().length,
    events: store.events(25).reverse(),
  }));

  on('POST', '/api/import', (_, body) => analyze(store, { text: body.text, origin: body.origin || 'вставка в студии', title: body.title, fileName: body.fileName, project: body.project || undefined }));
  on('GET', '/api/drafts/:id', ({ id }) => {
    const d = store.draft(id);
    if (!d) throw new StoreError('Черновик не найден (возможно, уже обработан).', 'not_found');
    const t = d.target && store.entities.get(d.target);
    return { ...d, targetEntity: t ? { ...metaOf(store, t), body: t.body } : null };
  });
  on('POST', '/api/drafts/:id/retarget', ({ id }, body) => retarget(store, id, body));
  on('POST', '/api/drafts/:id/approve', ({ id }, body) => {
    const r = approve(store, id, body);
    return { action: r.action, entity: r.entity ? metaOf(store, r.entity) : null };
  });
  on('DELETE', '/api/drafts/:id', ({ id }) => {
    const d = store.draft(id);
    if (d) { store.removeDraft(id); store.logEvent({ event: 'import-discarded', hash: d.source.hash, title: d.source.title }); }
    return { ok: true };
  });

  on('GET', '/api/entities/:id', ({ id }) => {
    const e = need(id);
    const { file, ...rest } = e;
    return {
      entity: { ...rest, file: store.rel(file) },
      history: store.history(id).map((h) => ({ revision: h.revision, updated: h.updated, title: h.title, visibility: h.visibility })),
      provenance: e.provenance.map((p) => ({ ...p, sourceTitle: p.source ? store.source(p.source)?.title || null : null })),
      stale: staleness(store, e),
      backlinks: [...store.entities.values()].flatMap((o) => o.links.filter((l) => l.to === id).map((l) => ({ rel: l.rel, from: o.id, title: o.title }))),
      linkTitles: Object.fromEntries(e.links.map((l) => [l.to, title(l.to)])),
      preview: publicPreview(store, id),
    };
  });
  const editable = (b) => {
    const o = {};
    for (const k of ['type', 'project', 'title', 'slug', 'summary', 'body', 'states', 'links', 'code_refs', 'references', 'tags', 'ingame_url', 'docs_reviewed', 'roadmap']) if (k in b) o[k] = b[k];
    if (o.roadmap && !o.roadmap.lane) o.roadmap = undefined;
    for (const k of ['ingame_url', 'docs_reviewed']) if (o[k] === '') o[k] = undefined;
    return o;
  };
  on('PUT', '/api/entities/:id', ({ id }, body) => {
    const e = need(id);
    const next = { ...e, ...editable(body.fields || {}) };
    if ('roadmap' in (body.fields || {}) && !body.fields.roadmap?.lane) delete next.roadmap;
    for (const k of ['ingame_url', 'docs_reviewed']) if (body.fields && body.fields[k] === '') delete next[k];
    const saved = store.saveEntity(next, { baseEtag: body.baseEtag, event: 'edit', note: body.note || '' });
    store.commit(`Правка: ${saved.title}`);
    return metaOf(store, saved);
  });
  on('POST', '/api/entities', (_, body) => {
    const f = editable(body.fields || {});
    const saved = store.saveEntity({ ...f, visibility: 'private', provenance: [{ kind: body.kind || 'user-idea', confidence: 'unconfirmed', date: new Date().toISOString().slice(0, 10), action: 'create', note: 'Создано вручную в студии.' }] }, { event: 'create' });
    store.commit(`Новая запись: ${saved.title}`);
    return metaOf(store, saved);
  });
  on('POST', '/api/entities/:id/visibility', ({ id }, body) => metaOf(store, setVisibility(store, id, body.visibility, { baseEtag: body.baseEtag })));
  on('GET', '/api/entities/:id/history/:rev', ({ id, rev }) => {
    const e = need(id);
    const h = store.history(id).find((x) => String(x.revision) === rev);
    if (!h) throw new StoreError('Ревизия не найдена.', 'not_found');
    const diff = diffLines(h.body, e.body);
    return { revision: h.revision, updated: h.updated, diff, stats: diffStats(diff) };
  });
  on('GET', '/api/sources/:id', ({ id }) => {
    const s = /^src-[a-f0-9]+$/.test(id) && store.source(id);
    if (!s) throw new StoreError('Источник не найден.', 'not_found');
    return { ...s, generated_body: undefined, text: store.sourceText(id), derivedTitles: Object.fromEntries((s.derived || []).map((d) => [d, title(d)])) };
  });
  on('POST', '/api/diff', (_, body) => { const diff = diffLines(String(body.a ?? ''), String(body.b ?? '')); return { diff, stats: diffStats(diff) }; });
  on('POST', '/api/preview-body', (_, body) => ({ public: sanitizeBody(String(body.body ?? '')), internal: internalParts(String(body.body ?? '')) }));
  on('GET', '/api/search', (_, __, url) => searchEntities(store, url.searchParams.get('q') || '', 30).map((r) => ({ ...metaOf(store, r.entity), score: +r.score.toFixed(3), terms: r.terms })));
  on('POST', '/api/release', () => release(store, repoRoot, { previewBase: '/preview/' }));
  on('GET', '/api/release', () => ({ git: gitStatus(repoRoot), hasPreview: fs.existsSync(path.join(previewDir, 'index.html')) }));
  on('POST', '/api/sync', async () => syncCodeRefs(store));

  const send = (res, code, data, type = MIME['.json'], csp = true) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(csp ? { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'" } : {}) });
    res.end(buf);
  };
  const serveStatic = (res, root, rel, csp = true) => {
    let f = path.normalize(path.join(root, decodeURIComponent(rel)));
    if (!f.startsWith(root)) return send(res, 403, { error: 'Запрещено.' });
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) return send(res, 404, 'Не найдено', 'text/plain; charset=utf-8');
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', csp);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Студия доступна только с этого компьютера.' });
      const url = new URL(req.url, `http://${host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Метод не поддерживается.' });
        if (url.pathname.startsWith('/preview/')) return serveStatic(res, previewDir, url.pathname.slice('/preview/'.length), false);
        if (url.pathname === '/preview') { res.writeHead(302, { location: '/preview/' }); return res.end(); }
        return serveStatic(res, path.join(HERE, 'public'), url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      }
      let body = {};
      if (req.method !== 'GET') {
        if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'Запрос отклонён: нет служебного заголовка.' });
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: 'Слишком большой запрос (больше 3 МБ).' }); chunks.push(c); }
        if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Некорректный JSON.' }); } }
      }
      store.load(); // хранилище это файлы на диске. Их могли поменять в Obsidian, поэтому читаем заново
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) return send(res, 200, (await r.fn(m.groups || {}, body, url)) ?? { ok: true });
      }
      send(res, 404, { error: 'Нет такого адреса.' });
    } catch (e) {
      if (e instanceof StoreError) return send(res, { not_found: 404, revision_conflict: 409, duplicate: 409 }[e.code] || 400, { error: e.message, code: e.code, details: e.details });
      console.error(e);
      send(res, 500, { error: `Внутренняя ошибка: ${e.message}` });
    }
  });
  return {
    server, store,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); }),
    close: () => new Promise((r) => server.close(r)),
  };
}
