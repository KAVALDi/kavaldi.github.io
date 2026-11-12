// Приватное хранилище знаний: обычная папка с Markdown (YAML frontmatter) и JSON.
// Открывается как vault в Obsidian, читается без каких-либо инструментов, живёт в отдельном приватном Git.
//
//   store.yaml                      паспорт хранилища (версия формата)
//   projects/<id>.md                проекты
//   entities/<project>/<file>.md    записи. Имя файла косметическое, запись находят по id во frontmatter
//   sources/<srcId>.json + raw/     импортированные материалы (неизменяемые, по хешу содержимого)
//   drafts/<draftId>.json           очередь разбора (предложения до одобрения)
//   history/<entityId>/<rev>.md     снимки предыдущих ревизий
//   log/events.jsonl                журнал событий (только дописывается)
//   media/                          файлы с обязательной атрибуцией
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { validateEntity, validateProject, defaultStates, ENTITY_TYPES } from './schema.mjs';
import { randomId, slugify, normalizeText, sha256 } from './text.mjs';

const etagOf = (raw) => sha256(String(raw).replace(/\r\n?/g, '\n')).slice(0, 16);

export const STORE_FORMAT = 1;

export function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  return { meta: YAML.parse(m[1]) || {}, body: text.slice(m[0].length).trim() };
}

const ENTITY_KEYS = ['id', 'type', 'project', 'title', 'slug', 'aliases', 'summary', 'visibility', 'states',
  'roadmap', 'links', 'code_refs', 'references', 'ingame_url', 'docs_reviewed', 'tags', 'provenance',
  'created', 'updated', 'revision'];

export function stringifyFrontmatter(meta, body, order = ENTITY_KEYS) {
  const o = {};
  for (const k of order) if (meta[k] !== undefined && meta[k] !== null && !(Array.isArray(meta[k]) && !meta[k].length)) o[k] = meta[k];
  for (const k of Object.keys(meta)) if (!(k in o) && !order.includes(k) && meta[k] != null) o[k] = meta[k];
  return `---\n${YAML.stringify(o, { lineWidth: 0 }).trimEnd()}\n---\n\n${(body || '').trim()}\n`;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

export class StoreError extends Error {
  constructor(message, code = 'store_error', details) { super(message); this.code = code; this.details = details; }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.projects = new Map();
    this.entities = new Map();
    this.problems = [];
  }

  static init(root, { git = true } = {}) {
    root = path.resolve(root);
    for (const d of ['projects', 'entities', 'sources/raw', 'drafts', 'history', 'log', 'media']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    const passport = path.join(root, 'store.yaml');
    if (!fs.existsSync(passport)) {
      fs.writeFileSync(passport, YAML.stringify({ format: STORE_FORMAT, created: today(), note: 'Приватное хранилище Developer Knowledge Hub. Не публиковать целиком.' }));
    }
    const gi = path.join(root, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*.tmp\n.obsidian/workspace*.json\n.trash/\n');
    // Git не должен менять переводы строк: файлы хранилища сравниваются по содержимому.
    const ga = path.join(root, '.gitattributes');
    if (!fs.existsSync(ga)) fs.writeFileSync(ga, '* -text\n');
    if (git && !fs.existsSync(path.join(root, '.git'))) {
      try { execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' }); } catch { /* git необязателен */ }
    }
    return new Store(root).load();
  }

  p(...parts) { return path.join(this.root, ...parts); }

  load() {
    if (!fs.existsSync(this.p('store.yaml'))) {
      throw new StoreError(`Здесь нет хранилища: ${this.root}. Создайте его командой "hub init" или укажите путь через HUB_STORE.`, 'no_store');
    }
    this.projects.clear(); this.entities.clear(); this.problems = [];
    for (const f of this.#mdFiles(this.p('projects'))) {
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        const errs = validateProject(meta);
        if (errs.length) this.problems.push({ file: this.rel(f), level: 'error', messages: errs });
        if (meta.id) this.projects.set(meta.id, { ...meta, body, file: f });
      } catch (e) { this.problems.push({ file: this.rel(f), level: 'error', messages: [`не читается: ${e.message}`] }); }
    }
    for (const f of this.#mdFiles(this.p('entities'))) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        if (!meta.id) { this.problems.push({ file: this.rel(f), level: 'error', messages: ['нет id во frontmatter, файл пропущен'] }); continue; }
        if (this.entities.has(meta.id)) {
          this.problems.push({ file: this.rel(f), level: 'error', messages: [`дубликат id ${meta.id} (уже в ${this.rel(this.entities.get(meta.id).file)}), файл пропущен`] });
          continue;
        }
        this.entities.set(meta.id, this.#normalize({ ...meta, body, file: f, etag: etagOf(raw) }));
      } catch (e) { this.problems.push({ file: this.rel(f), level: 'error', messages: [`не читается: ${e.message}`] }); }
    }
    const ctx = { projects: this.projects, entities: this.entities };
    const slugs = new Map();
    for (const en of this.entities.values()) {
      const { errors, warnings } = validateEntity(en, ctx);
      const key = `${en.project}/${en.slug}`;
      if (slugs.has(key)) errors.push(`slug "${en.slug}" уже занят записью ${slugs.get(key)}`);
      slugs.set(key, en.id);
      if (errors.length) this.problems.push({ file: this.rel(en.file), id: en.id, level: 'error', messages: errors });
      if (warnings.length) this.problems.push({ file: this.rel(en.file), id: en.id, level: 'warning', messages: warnings });
    }
    return this;
  }

  rel(f) { return path.relative(this.root, f).replace(/\\/g, '/'); }

  *#mdFiles(dir) {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) yield* this.#mdFiles(f);
      else if (d.name.endsWith('.md')) yield f;
    }
  }

  #normalize(en) {
    en.visibility ||= 'private';
    en.states = { ...defaultStates(), ...(en.states || {}) };
    en.revision = Number.isInteger(en.revision) ? en.revision : 1;
    for (const k of ['aliases', 'links', 'code_refs', 'provenance', 'references', 'tags']) en[k] = Array.isArray(en[k]) ? en[k] : [];
    en.summary = en.summary || '';
    en.slug = en.slug || slugify(en.title);
    for (const k of ['created', 'updated', 'docs_reviewed']) if (en[k] instanceof Date) en[k] = en[k].toISOString().slice(0, 10);
    return en;
  }

  get errors() { return this.problems.filter((p) => p.level === 'error'); }

  /** Свободный slug в пределах проекта. */
  uniqueSlug(project, wanted, selfId) {
    const taken = new Set();
    for (const e of this.entities.values()) if (e.project === project && e.id !== selfId) { taken.add(e.slug); for (const a of e.aliases) taken.add(a); }
    let s = slugify(wanted), i = 2;
    const base = s;
    while (taken.has(s)) s = `${base}-${i++}`;
    return s;
  }

  /**
   * Сохраняет запись. Новая получает id и ревизию 1. У существующей прежняя версия уходит в history/,
   * ревизия растёт. baseRevision защищает от молчаливой перезаписи чужих правок (например, из Obsidian).
   */
  saveEntity(input, { baseEtag, event = 'edit', note = '' } = {}) {
    const isNew = !input.id || !this.entities.has(input.id);
    const prev = isNew ? null : this.entities.get(input.id);
    if (prev) {
      // Перечитываем файл с диска: его могли изменить вне студии.
      const diskTag = etagOf(fs.readFileSync(prev.file, 'utf8'));
      if (baseEtag != null && baseEtag !== diskTag) {
        throw new StoreError('Запись изменилась с момента открытия (другая вкладка или правка в Obsidian). Откройте её заново и повторите.', 'revision_conflict', { current: diskTag, base: baseEtag });
      }
    }
    if (!ENTITY_TYPES[input.type]) throw new StoreError(`Неизвестный тип записи: ${input.type}`, 'invalid');
    if (!this.projects.has(input.project)) throw new StoreError(`Неизвестный проект: ${input.project}`, 'invalid');
    const en = this.#normalize({ ...(prev || {}), ...input });
    en.id = prev ? prev.id : (input.id || randomId(ENTITY_TYPES[en.type].prefix));
    en.title = String(en.title || '').trim();
    en.body = normalizeText(en.body || '');
    en.slug = this.uniqueSlug(en.project, input.slug || en.slug || en.title, en.id);
    if (prev && prev.slug !== en.slug && !en.aliases.includes(prev.slug)) en.aliases = [...en.aliases, prev.slug];
    en.aliases = en.aliases.filter((a) => a !== en.slug);
    en.created = prev?.created || today();
    en.updated = today();
    en.revision = prev ? prev.revision + 1 : 1;
    const ctx = { projects: this.projects, entities: new Map([...this.entities, [en.id, en]]) };
    const { errors } = validateEntity(en, ctx);
    if (errors.length) throw new StoreError(`Запись не прошла проверку: ${errors.join('. ')}`, 'invalid', errors);

    let file = prev?.file;
    if (prev) {
      const snap = this.p('history', en.id, `${String(prev.revision).padStart(4, '0')}.md`);
      if (!fs.existsSync(snap)) writeAtomic(snap, fs.readFileSync(prev.file));
      if (prev.project !== en.project) { file = this.p('entities', en.project, path.basename(prev.file)); }
    } else {
      file = this.p('entities', en.project, `${en.slug}.${en.id.split('-').pop()}.md`);
    }
    const { body, file: _f, etag: _e, ...meta } = en;
    const out = stringifyFrontmatter(meta, body);
    writeAtomic(file, out);
    en.etag = etagOf(out);
    if (prev && prev.file !== file) fs.rmSync(prev.file);
    en.file = file;
    this.entities.set(en.id, en);
    this.logEvent({ event, entity: en.id, revision: en.revision, note });
    return en;
  }

  history(id) {
    const dir = this.p('history', id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { revision: meta.revision ?? Number(f.slice(0, 4)), updated: meta.updated instanceof Date ? meta.updated.toISOString().slice(0, 10) : meta.updated, title: meta.title, visibility: meta.visibility, body };
    });
  }

  logEvent(ev) {
    fs.mkdirSync(this.p('log'), { recursive: true });
    fs.appendFileSync(this.p('log', 'events.jsonl'), JSON.stringify({ at: now(), ...ev }) + '\n');
  }

  events(limit = 200) {
    const f = this.p('log', 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // --- источники ---
  sources() {
    const dir = this.p('sources');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
  }
  source(id) { const f = this.p('sources', `${id}.json`); return fs.existsSync(f) ? readJson(f) : null; }
  sourceText(id) { const f = this.p('sources', 'raw', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; }
  saveSource(src, text) {
    if (text != null && !fs.existsSync(this.p('sources', 'raw', `${src.id}.md`))) writeAtomic(this.p('sources', 'raw', `${src.id}.md`), text);
    writeAtomic(this.p('sources', `${src.id}.json`), JSON.stringify(src, null, 2) + '\n');
    return src;
  }

  // --- черновики разбора ---
  drafts() {
    const dir = this.p('drafts');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)))
      .sort((a, b) => (a.created < b.created ? 1 : -1));
  }
  draft(id) {
    if (!/^draft-[a-z0-9]+$/.test(id)) return null;
    const f = this.p('drafts', `${id}.json`);
    return fs.existsSync(f) ? readJson(f) : null;
  }
  saveDraft(d) { writeAtomic(this.p('drafts', `${d.id}.json`), JSON.stringify(d, null, 2) + '\n'); return d; }
  removeDraft(id) { fs.rmSync(this.p('drafts', `${id}.json`), { force: true }); }

  /** Коммит в приватный Git хранилища, если он есть. Сбой Git не ломает сохранение. */
  commit(message) {
    if (!fs.existsSync(this.p('.git'))) return { committed: false, reason: 'хранилище не под Git' };
    try {
      execFileSync('git', ['add', '-A'], { cwd: this.root, stdio: 'ignore' });
      const st = execFileSync('git', ['status', '--porcelain'], { cwd: this.root, encoding: 'utf8' });
      if (!st.trim()) return { committed: false, reason: 'нет изменений' };
      execFileSync('git', ['commit', '-q', '-m', message], { cwd: this.root, stdio: 'ignore' });
      return { committed: true };
    } catch (e) { return { committed: false, reason: e.message.split('\n')[0] }; }
  }
}

export function resolveStorePath(repoRoot, explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.HUB_STORE) return path.resolve(process.env.HUB_STORE);
  const local = path.join(repoRoot, 'hub.local.json');
  if (fs.existsSync(local)) { const c = readJson(local); if (c.store) return path.resolve(repoRoot, c.store); }
  return path.resolve(repoRoot, '..', 'knowledge');
}
