// Экспорт публичного снимка: единственный путь, которым знания покидают приватное хранилище.
// Работает по белому списку полей. Всё, чего здесь нет, в публичный репозиторий не попадает.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { StoreError } from './store.mjs';
import { PLACEHOLDER } from './importer.mjs';

export const SNAPSHOT_FORMAT = 1;

// Разделы, которые остаются внутренними даже у опубликованной записи.
const INTERNAL_HEADING = /^(материал источника|дополнение из импорта|внутреннее|для себя)|\(внутреннее\)\s*$/i;

/** Убирает приватные комментарии %%…%%, внутренние и незаполненные разделы. */
export function sanitizeBody(body) {
  const noComments = String(body || '').replace(/%%[\s\S]*?%%/g, '');
  const lines = noComments.split('\n');
  const sections = [{ head: null, level: 0, lines: [] }];
  let fence = false;
  for (const l of lines) {
    if (/^(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*?)\s*$/.exec(l);
    if (m) sections.push({ head: l, title: m[2], level: m[1].length, lines: [] });
    else sections[sections.length - 1].lines.push(l);
  }
  const out = [];
  let skipLevel = 0;
  sections.forEach((s, i) => {
    if (skipLevel && s.level > skipLevel) return;
    skipLevel = 0;
    if (s.head && INTERNAL_HEADING.test(s.title)) { skipLevel = s.level; return; }
    const content = s.lines.join('\n').trim();
    const empty = !content || content === PLACEHOLDER;
    const next = sections[i + 1];
    const hasChildren = next && next.level > s.level;
    if (s.head && empty && !hasChildren) return;
    if (s.head) out.push(s.head, '');
    if (!empty) out.push(content, '');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Внутренние фрагменты записи (то, что вырезает sanitizeBody). Они нужны проверке приватности. */
export function internalParts(body) {
  const pub = new Set(sanitizeBody(body).split('\n').map((l) => l.trim()).filter(Boolean));
  return String(body || '').replace(/%%/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !pub.has(l));
}

const isPublicEntity = (store, e) => e.visibility === 'public' && store.projects.get(e.project)?.visibility === 'public';

/** Какие связанные изменения кода новее последней сверки документации. */
export function staleness(store, en) {
  if (!en.docs_reviewed) return [];
  const targets = [en, ...en.links.filter((l) => l.rel === 'documents').map((l) => store.entities.get(l.to)).filter(Boolean)];
  const out = [];
  for (const t of targets) {
    for (const c of t.code_refs) {
      const changed = c.merged_at || c.changed_at;
      if (changed && String(changed).slice(0, 10) > en.docs_reviewed) {
        out.push({ repo: c.repo, kind: c.kind, ref: String(c.ref), title: c.title || '', date: String(changed).slice(0, 10), via: t.id });
      }
    }
  }
  return out;
}

export function codeRefUrl(c) {
  const base = `https://github.com/${c.repo}`;
  switch (c.kind) {
    case 'pr': return `${base}/pull/${c.ref}`;
    case 'issue': return `${base}/issues/${c.ref}`;
    case 'commit': return `${base}/commit/${c.ref}`;
    case 'branch': return `${base}/tree/${c.ref}`;
    case 'discussion': return `${base}/discussions/${c.ref}`;
    default: return `${base}/blob/${c.at || 'HEAD'}/${c.path || c.ref}`;
  }
}

export function buildPublicSnapshot(store) {
  if (store.errors.length) {
    throw new StoreError(`В хранилище есть ошибки (${store.errors.length}). Экспорт остановлен, чтобы не опубликовать повреждённые данные. Запустите "hub validate".`, 'store_invalid', store.errors);
  }
  const media = new Map();
  const isPub = (id) => { const e = store.entities.get(id); return !!e && isPublicEntity(store, e); };
  // Витрина проекта: крупный блок на главной из настоящих игровых спрайтов. Все файлы проходят проверку атрибуции.
  const mediaFile = (f, owner) => {
    if (typeof f !== 'string' || !/^media\/[\w./-]+$/.test(f) || f.includes('..')) throw new StoreError(`Витрина ${owner}: недопустимый путь к файлу "${f}".`, 'invalid');
    media.set(f, owner);
    return f;
  };
  const layer = (l, owner) => (typeof l === 'string' ? { file: mediaFile(l, owner) } : { file: mediaFile(l.file, owner), ...(l.tint ? { tint: true } : {}) });
  const showcase = (p) => {
    const s = p.showcase;
    if (!s) return null;
    const owner = `проекта ${p.id}`;
    return {
      eyebrow: s.eyebrow || '', title: s.title || p.title, text: s.text || '', cta: s.cta || 'Открыть',
      entity: s.entity && isPub(s.entity) ? s.entity : null,
      tint: /^#[0-9a-fA-F]{6}$/.test(s.tint || '') ? s.tint : '#E8A21C',
      layers: (s.layers || []).map((l) => layer(l, owner)),
      flyers: (s.flyers || []).map((f) => ({ layers: (f.layers || []).map((l) => layer(l, owner)), cols: Number(f.cols) || 1, rows: Number(f.rows) || 1, count: Math.min(Number(f.count) || 1, 8) })),
      items: (s.items || []).map((i) => ({ label: String(i.label || ''), layers: (i.layers || []).map((l) => layer(l, owner)) })),
    };
  };
  const projects = [...store.projects.values()].filter((p) => p.visibility === 'public').map((p) => ({
    id: p.id, title: p.title, nature: p.nature || 'project', tagline: p.tagline || '', order: p.order ?? 100,
    status_note: p.status_note || '', showcase: showcase(p),
    repos: (p.public_repos || []).map((r) => ({ repo: r, url: `https://github.com/${r}` })),
    links: (p.links || []).filter((l) => /^https?:\/\//.test(l.url || '')).map((l) => ({ title: l.title || l.url, url: l.url })),
    body: sanitizeBody(p.body),
  })).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const pub = new Set([...store.entities.values()].filter((e) => isPublicEntity(store, e)).map((e) => e.id));
  const entities = [...pub].sort().map((id) => {
    const e = store.entities.get(id);
    const publicRepos = new Set(store.projects.get(e.project).public_repos || []);
    // Ссылки на записи по стабильному id: [[id]], [[id|текст]], [текст](hub:id). Ссылки на непубличные записи
    // превращаются в обычный текст, чтобы наружу не утёк даже идентификатор.
    const body = sanitizeBody(e.body)
      .replace(/\[\[([a-z]+-[a-z0-9]{6,})(?:\|([^\]]+))?\]\]/g, (m, id, t) => (pub.has(id) ? `[${t || store.entities.get(id).title}](hub:${id})` : (t || '')))
      .replace(/\[([^\]]+)\]\(hub:([a-z]+-[a-z0-9]{6,})\)/g, (m, t, id) => (pub.has(id) ? m : t));
    for (const m of body.matchAll(/!\[[^\]]*\]\((media\/[^)\s]+)\)/g)) media.set(m[1], e.id);
    const stale = staleness(store, e);
    return {
      id: e.id, type: e.type, project: e.project, title: e.title, slug: e.slug, aliases: e.aliases,
      summary: e.summary, tags: e.tags, states: e.states,
      roadmap: e.roadmap ? { lane: e.roadmap.lane, order: e.roadmap.order ?? 100 } : null,
      links: e.links.filter((l) => pub.has(l.to)).map((l) => ({ rel: l.rel, to: l.to, ...(l.note ? { note: l.note } : {}) })),
      code_refs: e.code_refs.filter((c) => publicRepos.has(c.repo)).map((c) => ({
        repo: c.repo, kind: c.kind, ref: String(c.ref), title: c.title || '', state: c.state || '',
        merged_at: c.merged_at || null, url: codeRefUrl(c), ...(c.path ? { path: c.path } : {}), ...(c.note ? { note: c.note } : {}),
      })),
      references: e.references.map((r) => ({ title: r.title || r.url, url: r.url })),
      ingame_url: e.ingame_url || null,
      docs_reviewed: e.docs_reviewed || null,
      // Устаревание показываем публично, а детали только для кода из публичных репозиториев.
      stale: stale.map((s) => (publicRepos.has(s.repo) ? { ...s, url: codeRefUrl(s), via: pub.has(s.via) ? s.via : null } : { date: s.date })),
      created: e.created, updated: e.updated, revision: e.revision,
      body,
    };
  });

  // Медиа публикуются только с атрибуцией: рядом с файлом обязателен <файл>.yaml с license и source/author.
  const credits = [];
  for (const [rel, owner] of media) {
    const file = store.p(rel);
    if (!fs.existsSync(file)) throw new StoreError(`Запись ${owner} ссылается на отсутствующий файл ${rel}.`, 'media_missing');
    if (!fs.existsSync(file + '.yaml')) throw new StoreError(`У файла ${rel} нет атрибуции (${rel}.yaml с полями license и source). Без неё медиа не публикуется.`, 'media_unattributed');
    const meta = YAML.parse(fs.readFileSync(file + '.yaml', 'utf8')) || {};
    if (!meta.license || !(meta.source || meta.author)) throw new StoreError(`В ${rel}.yaml нужны license и source или author.`, 'media_unattributed');
    credits.push({ file: rel, license: meta.license, author: meta.author || '', source: meta.source || '', note: meta.note || '' });
  }
  credits.sort((a, b) => a.file.localeCompare(b.file));
  return { format: SNAPSHOT_FORMAT, projects, entities, credits };
}

const stable = (o) => JSON.stringify(o, null, 2) + '\n';

/** Пишет снимок в каталог content/ публичного репозитория. Детерминированно: без дат экспорта, лишние файлы удаляются. */
export function writeSnapshot(store, snap, outDir) {
  const want = new Map();
  for (const p of snap.projects) want.set(`projects/${p.id}.json`, stable(p));
  for (const e of snap.entities) want.set(`entities/${e.id}.json`, stable(e));
  want.set('manifest.json', stable({
    format: snap.format,
    note: 'Сгенерировано командой "hub export" из приватного хранилища. Не редактировать вручную.',
    projects: snap.projects.map((p) => p.id), entities: snap.entities.length, credits: snap.credits,
  }));
  const changes = { added: [], changed: [], removed: [] };
  for (const sub of ['projects', 'entities']) {
    const dir = path.join(outDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json') && !want.has(`${sub}/${f}`)) { fs.rmSync(path.join(dir, f)); changes.removed.push(`${sub}/${f}`); }
  }
  for (const [rel, data] of want) {
    const f = path.join(outDir, rel);
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (old === data) continue;
    (old == null ? changes.added : changes.changed).push(rel);
    fs.writeFileSync(f, data);
  }
  const mdir = path.join(outDir, 'media');
  fs.rmSync(mdir, { recursive: true, force: true });
  for (const c of snap.credits) {
    const dst = path.join(outDir, c.file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(store.p(c.file), dst);
  }
  return changes;
}

export function exportPublic(store, outDir) {
  const snap = buildPublicSnapshot(store);
  const changes = writeSnapshot(store, snap, outDir);
  store.logEvent({ event: 'export', entities: snap.entities.length, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.length])) });
  return { snapshot: snap, changes };
}

/** Читает снимок обратно. Им пользуется сборщик сайта (он не знает о приватном хранилище). */
export function readSnapshot(contentDir) {
  const read = (sub) => {
    const dir = path.join(contentDir, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  const mf = path.join(contentDir, 'manifest.json');
  const manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : { credits: [] };
  const af = path.join(contentDir, 'activity.json');
  const sf = path.join(contentDir, 'site.json');
  return {
    projects: read('projects').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    entities: read('entities'),
    credits: manifest.credits || [],
    activity: fs.existsSync(af) ? JSON.parse(fs.readFileSync(af, 'utf8')) : null,
    site: fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {},
  };
}
