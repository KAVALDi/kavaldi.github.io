// Проверка границы приватности. "Не опубликовано" = физически отсутствует в content/ и dist/,
// включая HTML, JSON и поисковый индекс. Проверка ищет в публичных артефактах "канарейки":
// фрагменты приватных записей, внутренних разделов, исходных материалов и черновиков, а также
// признаки секретов и локальных путей.
import fs from 'node:fs';
import path from 'node:path';
import { buildPublicSnapshot, internalParts } from './exporter.mjs';

const TEXT_EXT = new Set(['.html', '.htm', '.json', '.js', '.mjs', '.css', '.xml', '.txt', '.md', '.svg', '.webmanifest', '.map']);
const SECRET_PATTERNS = [
  [/gh[opsur]_[A-Za-z0-9]{30,}/, 'токен GitHub'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'токен GitHub'],
  [/sk-[A-Za-z0-9_-]{24,}/, 'ключ API'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/"'<\s]+[\\/]/, 'локальный путь Windows'],
  [/(?:^|[\s"'(=])\/(?:home|Users)\/[A-Za-z0-9_.-]+\//m, 'локальный путь'],
];

const MIN_CANARY = 28;
// Сравнение в пространстве "только буквы и цифры": устойчиво к разметке, переносам и HTML-экранированию.
const squash = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, ' ').replace(/&(quot|amp|lt|gt|#39|nbsp);/g, ' ');

function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'node_modules' && d.name !== '.git') yield* walk(f); }
    else yield f;
  }
}

/** Собирает канарейки: [{ needle, origin, sample }]. */
export function collectCanaries(store) {
  const snap = buildPublicSnapshot(store);
  const publicText = squash([
    ...snap.projects.flatMap((p) => [p.title, p.tagline, p.status_note, p.body]),
    ...snap.entities.flatMap((e) => [e.title, e.summary, e.body, ...e.tags, ...e.code_refs.map((c) => c.title), ...e.references.map((r) => r.title)]),
  ].join('\n'));
  const pubIds = new Set(snap.entities.map((e) => e.id));
  const pubProjects = new Set(snap.projects.map((p) => p.id));
  const canaries = new Map();
  const add = (text, origin) => {
    for (const line of String(text || '').split('\n')) {
      const n = squash(line);
      if (n.length < MIN_CANARY || publicText.includes(n) || canaries.has(n)) continue;
      canaries.set(n, { needle: n, origin, sample: line.trim().slice(0, 90) });
    }
  };
  const ids = [];
  for (const e of store.entities.values()) {
    if (pubIds.has(e.id)) { add(internalParts(e.body).join('\n'), `внутренняя часть записи ${e.id}`); continue; }
    ids.push(e.id);
    add([e.title, e.summary, e.body].join('\n'), `приватная запись ${e.id}`);
  }
  for (const p of store.projects.values()) {
    if (!pubProjects.has(p.id)) {
      add([p.title, p.tagline, p.body].join('\n'), `приватный проект ${p.id}`);
      // Скрытый проект не должен угадываться даже по короткому названию.
      const t = squash(p.title);
      if (t.length >= 6 && !publicText.includes(t) && !canaries.has(t)) canaries.set(t, { needle: t, origin: `название приватного проекта ${p.id}`, sample: p.title });
    }
    else add(internalParts(p.body).join('\n'), `внутренняя часть проекта ${p.id}`);
  }
  for (const s of store.sources()) add(store.sourceText(s.id), `исходный материал ${s.id}`);
  for (const d of store.drafts()) add(d.source.text, `черновик разбора ${d.id}`);
  return { canaries: [...canaries.values()], privateIds: ids, sourceIds: store.sources().map((s) => s.id) };
}

/** Проверяет каталоги публичных артефактов. Возвращает { ok, violations, scanned, canaries }. */
export function checkPrivacy(store, dirs) {
  const { canaries, privateIds, sourceIds } = collectCanaries(store);
  const violations = [];
  let scanned = 0;
  const storeRoot = store.root.replace(/\\/g, '/').toLowerCase();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
      scanned++;
      const raw = fs.readFileSync(f, 'utf8');
      const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
      for (const [re, what] of SECRET_PATTERNS) { const m = re.exec(raw); if (m) violations.push({ file: rel, kind: 'secret', what, sample: m[0].slice(0, 24) + '…' }); }
      if (raw.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase().includes(storeRoot)) violations.push({ file: rel, kind: 'path', what: 'путь к приватному хранилищу' });
      for (const id of [...privateIds, ...sourceIds]) if (raw.includes(id)) violations.push({ file: rel, kind: 'id', what: `идентификатор приватного объекта ${id}` });
      const hay = squash(decode(raw));
      for (const c of canaries) if (hay.includes(c.needle)) violations.push({ file: rel, kind: 'content', what: c.origin, sample: c.sample });
    }
  }
  return { ok: violations.length === 0, violations, scanned, canaries: canaries.length };
}
