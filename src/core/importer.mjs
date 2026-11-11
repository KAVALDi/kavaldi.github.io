// Импорт материала → предложение → черновик → одобрение. Работает без AI: всё, что здесь названо
// "предложением", получено детерминированными правилами (хеш, TF-IDF, шинглы, построчное слияние),
// и интерфейс обязан так это и показывать. AI-слой может дополнять предложение (см. ai.mjs), но не обязателен.
import { StoreError } from './store.mjs';
import { ENTITY_TYPES, PROVENANCE_KINDS, defaultStates } from './schema.mjs';
import { normalizeText, sha256, randomId, tokenize, termFreq, buildCorpus, shingleSimilarity, diffLines, diffStats, merge3 } from './text.mjs';

export const PLACEHOLDER = '_не заполнено_';
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const VERSION_THRESHOLD = 0.3; // доля общих шинглов, с которой текст считается новой версией прежнего источника
const UPDATE_THRESHOLD = 0.5; // похожесть на запись, с которой предлагается обновление вместо создания
const LINK_THRESHOLD = 0.12;

// Разделы черновика и заголовки источника, которые в них попадают.
const SECTIONS = [
  ['Суть', /^(суть|кратко|резюме|summary|описание)\b/i],
  ['Назначение', /^(назначение|зачем|цель|цели|мотивация)/i],
  ['Предлагаемые механики', /^(механик|предлагаем|правила|как (это )?работает|дизайн)/i],
  ['Известные факты', /^(факты|известн|текущее состояние|что есть)/i],
  ['Гипотезы', /^(гипотез|предположени)/i],
  ['Открытые вопросы', /^(открытые вопросы|вопросы|неясно)/i],
  ['Возможные противоречия', /^(противореч|конфликт|риски)/i],
  ['Следующий шаг', /^(следующ|дальше|план|todo|что делать)/i],
];

function splitBlocks(text) {
  const blocks = [{ heading: null, level: 0, lines: [] }];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (m) blocks.push({ heading: m[2].trim(), level: m[1].length, lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length).trim() : text;
}

export function guessTitle(text, fallback, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim().slice(0, 120);
  const t = stripFrontmatter(text);
  const h = /^#{1,3}\s+(.+?)\s*#*$/m.exec(t);
  if (h) return h[1].trim().slice(0, 120);
  if (fallback) return String(fallback).replace(/\.(md|txt|markdown)$/i, '').slice(0, 120);
  const first = t.split('\n').find((l) => l.trim()) || 'Без названия';
  return first.replace(/^[-*>\s]+/, '').slice(0, 80).trim();
}

/**
 * Детерминированно раскладывает источник по разделам черновика. Ничего не "понимает":
 * разделы источника с узнаваемыми заголовками попадают в одноимённые разделы, вопросительные
 * предложения собираются в "Открытые вопросы", всё остальное дословно уходит в "Материал источника".
 */
export function buildDraftBody(sourceText) {
  const text = stripFrontmatter(normalizeText(sourceText));
  const buckets = new Map(SECTIONS.map(([name]) => [name, []]));
  const rest = [];
  const questions = [];
  let titleSeen = false;
  for (const b of splitBlocks(text)) {
    const content = b.lines.join('\n').trim();
    const sec = b.heading && SECTIONS.find(([, re]) => re.test(b.heading));
    if (sec) { if (content) buckets.get(sec[0]).push(content); continue; }
    if (b.heading && b.level === 1 && !titleSeen) { titleSeen = true; if (content) rest.push(content); }
    else if (b.heading) rest.push(`### ${b.heading}${content ? '\n\n' + content : ''}`);
    else if (content) rest.push(content);
    for (const line of content.split('\n')) {
      if (/^\s*(```|~~~|\||>)/.test(line)) continue;
      for (const s of line.replace(/^[\s\-*\d.)]+/, '').split(/(?<=[.!?…])\s+/)) {
        const q = s.trim();
        if (q.endsWith('?') && q.length > 12 && q.length < 300 && !questions.includes(q)) questions.push(q);
      }
    }
  }
  if (questions.length) buckets.get('Открытые вопросы').push(questions.map((q) => `- ${q}`).join('\n'));
  const out = [];
  for (const [name] of SECTIONS) {
    out.push(`## ${name}`, '', buckets.get(name).join('\n\n') || PLACEHOLDER, '');
  }
  if (rest.length) out.push('## Материал источника', '', rest.join('\n\n'), '');
  return out.join('\n').trim();
}

export function guessSummary(text) {
  const t = stripFrontmatter(normalizeText(text));
  const para = t.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|```|~~~|\||- |\* |\d+\. |>|!\[)/.test(p));
  if (!para) return '';
  const flat = para.replace(/\s+/g, ' ').replace(/[*_`]/g, '');
  return flat.length > 240 ? flat.slice(0, 237).replace(/\s+\S*$/, '') + '…' : flat;
}

const entityTf = (e) => {
  const tf = new Map();
  termFreq(tokenize(e.title), 4, tf);
  termFreq(tokenize(e.summary), 2, tf);
  termFreq(tokenize((e.tags || []).join(' ') + ' ' + (e.aliases || []).join(' ')), 2, tf);
  termFreq(tokenize(e.body), 1, tf);
  return tf;
};

export function entityCorpus(store) {
  return buildCorpus([...store.entities.values()].map((e) => ({ id: e.id, tf: entityTf(e) })));
}

/** Поиск по хранилищу (для студии). */
export function searchEntities(store, query, limit = 20) {
  return entityCorpus(store).query(termFreq(tokenize(query)), limit)
    .map((r) => ({ ...r, entity: store.entities.get(r.id) }));
}

function classifyProject(store, tf, hint) {
  const docs = [...store.projects.values()].map((p) => {
    const d = new Map();
    termFreq(tokenize(p.title), 3, d);
    termFreq(tokenize((p.keywords || []).join(' ')), 4, d);
    termFreq(tokenize(p.body), 1, d);
    for (const e of store.entities.values()) if (e.project === p.id) { termFreq(tokenize(e.title), 2, d); termFreq(tokenize(e.summary), 1, d); }
    return { id: p.id, tf: d };
  });
  const scores = buildCorpus(docs).query(tf, 50).map((s) => ({ id: s.id, score: +s.score.toFixed(3), terms: s.terms }));
  if (hint) return { id: hint.id, confidence: 'high', reason: hint.reason, scores };
  const [a, b] = scores;
  if (!a) return { id: null, confidence: 'none', reason: 'В тексте нет слов, знакомых хотя бы одному проекту. Выберите проект вручную.', scores };
  const margin = b ? b.score / a.score : 0;
  const confident = a.score >= 0.05 && margin < 0.65;
  return {
    id: a.id,
    confidence: confident ? 'high' : 'low',
    reason: confident
      ? `Совпадают ключевые слова: ${a.terms.join(', ')}.`
      : `Уверенности мало${b ? ` (следующий кандидат: ${b.id})` : ''}. Проверьте проект.`,
    scores,
  };
}

/** Шаги 1-4 сценария: распознать повтор и версию, предложить проект, найти близкие записи, выбрать действие. */
export function analyze(store, { text, origin = 'вставка', title, fileName, project, ai } = {}) {
  const norm = normalizeText(text);
  if (!norm) throw new StoreError('Пустой материал: нечего импортировать.', 'empty');
  if (Buffer.byteLength(norm) > MAX_IMPORT_BYTES) throw new StoreError('Материал больше 2 МБ. Разделите его на части.', 'too_large');
  if (norm.includes('\u0000')) throw new StoreError('Похоже на двоичный файл. Поддерживаются текст и Markdown.', 'binary');
  const hash = sha256(norm);
  const sources = store.sources();
  const existing = (ids) => (ids || []).filter((id) => store.entities.has(id));

  const dup = sources.find((s) => s.hash === hash) || null;
  let prior = null;
  if (!dup) {
    for (const s of sources) {
      const st = store.sourceText(s.id);
      if (!st) continue;
      const sim = shingleSimilarity(norm, st);
      if (sim >= VERSION_THRESHOLD && (!prior || sim > prior.similarity)) prior = { id: s.id, title: s.title, imported_at: s.imported_at, similarity: +sim.toFixed(3), derived: existing(s.derived) };
    }
    // цепочка версий: берём самую свежую версию того же материала
  }

  const tf = termFreq(tokenize(norm));
  const anchor = existing(dup?.derived)[0] || prior?.derived[0];
  const hint = project
    ? { id: project, reason: 'Проект выбран вручную.' }
    : anchor ? { id: store.entities.get(anchor).project, reason: 'Проект взят из записи, созданной по прежней версии этого материала.' } : null;
  const proj = classifyProject(store, tf, hint);

  const sourceTitle = guessTitle(norm, fileName, title);
  const srcTitle = new Set(tokenize(sourceTitle));
  const matches = entityCorpus(store).query(tf, 8).filter((m) => m.score >= 0.05).map((m) => {
    const e = store.entities.get(m.id);
    // Заголовок записи целиком содержится в заголовке материала. Это сильный признак той же темы.
    const tt = [...new Set(tokenize(e.title))];
    const sameTitle = tt.length >= 2 && tt.every((t) => srcTitle.has(t));
    return { id: e.id, title: e.title, type: e.type, project: e.project, score: +m.score.toFixed(3), terms: m.terms, sameTitle };
  }).sort((a, b) => (b.sameTitle - a.sameTitle) || b.score - a.score);

  let action, target = null, reason;
  if (dup) {
    const d = existing(dup.derived);
    action = 'skip'; target = d[0] || null;
    reason = d.length
      ? `Этот текст уже импортирован ${dup.imported_at.slice(0, 10)} (источник ${dup.id}). По нему ведётся запись "${store.entities.get(d[0]).title}". Новая запись не нужна.`
      : `Этот текст уже импортирован ${dup.imported_at.slice(0, 10)} (источник ${dup.id}), но записи по нему нет.`;
  } else if (prior && prior.derived.length) {
    action = 'update'; target = prior.derived[0];
    reason = `Текст на ${Math.round(prior.similarity * 100)}% совпадает с ранее импортированным источником "${prior.title}". Похоже на новую версию: предлагается обновить запись, созданную по прежней версии.`;
  } else if (tokenize(norm).length < 8) {
    action = 'defer';
    reason = 'В тексте слишком мало слов для сопоставления. Можно отложить или создать запись вручную.';
  } else if (matches[0] && (matches[0].score >= UPDATE_THRESHOLD || (matches[0].sameTitle && matches[0].score >= LINK_THRESHOLD))) {
    action = 'update'; target = matches[0].id;
    reason = matches[0].sameTitle
      ? `Заголовок материала совпадает с записью "${matches[0].title}". Предлагается дополнить её, а не заводить новую.`
      : `Очень близко к записи "${matches[0].title}" (похожесть ${matches[0].score}). Предлагается дополнить её, а не заводить новую.`;
  } else {
    action = 'create';
    reason = matches.length
      ? 'Точного совпадения нет. Предлагается новая запись. Близкие по теме записи можно связать с ней.'
      : 'Похожих записей не найдено. Предлагается новая запись.';
  }

  const draft = {
    id: randomId('draft'),
    created: new Date().toISOString(),
    status: 'open',
    source: { hash, title: sourceTitle, origin, size: Buffer.byteLength(norm), text: norm },
    duplicateOf: dup ? { id: dup.id, imported_at: dup.imported_at, derived: existing(dup.derived) } : null,
    priorVersion: prior,
    project: proj,
    matches,
    action, target, reason,
    analysis: { engine: 'rules', note: 'Сопоставление выполнено правилами (хеш, TF-IDF, шинглы). AI не использовался.' },
  };
  draft.proposal = buildProposal(store, draft, { action, target });
  if (ai?.enrich) Object.assign(draft, ai.enrich(draft, store) || {});
  return store.saveDraft(draft);
}

const demote = (md) => md.replace(/^(#{1,5})\s/gm, (m, h) => `${h.length < 3 ? '###' : h + '#'} `);

/** Шаг 5: редактируемый черновик под выбранное действие. Вызывается заново, когда владелец меняет действие или цель. */
export function buildProposal(store, draft, { action, target }) {
  const text = draft.source.text;
  const base = {
    type: 'idea', title: draft.source.title, summary: guessSummary(text), body: '', states: defaultStates(),
    links: [], diff: null, conflicts: [], mergeMode: null, baseEtag: null,
  };
  if (action === 'create' || action === 'defer') {
    return {
      ...base,
      body: buildDraftBody(text),
      links: draft.matches.filter((m) => m.score >= LINK_THRESHOLD && (!draft.project.id || m.project === draft.project.id)).slice(0, 4).map((m) => ({ rel: 'relates', to: m.id })),
    };
  }
  const en = target && store.entities.get(target);
  if (!en) return { ...base, body: buildDraftBody(text) };
  const keep = { type: en.type, title: en.title, summary: en.summary, states: en.states, links: en.links, baseEtag: en.etag };
  if (action === 'update') {
    const prior = draft.priorVersion && draft.priorVersion.derived.includes(en.id) ? store.source(draft.priorVersion.id) : null;
    let body, conflicts = [], mergeMode;
    if (prior) {
      const baseBody = prior.generated_body ?? buildDraftBody(store.sourceText(prior.id) || '');
      const m = merge3(baseBody, en.body, buildDraftBody(text));
      body = m.text; conflicts = m.conflicts; mergeMode = 'three-way';
    } else {
      body = `${en.body}\n\n## Дополнение из импорта: ${draft.source.title}\n\n${demote(stripFrontmatter(text))}`;
      mergeMode = 'append';
    }
    const diff = diffLines(en.body, body);
    return { ...base, ...keep, body, conflicts, mergeMode, diff, diffStats: diffStats(diff) };
  }
  // link / skip: тело записи не меняется
  return { ...base, ...keep, body: en.body, mergeMode: 'none' };
}

/** Владелец сменил проект, действие или цель. Пересобираем предложение, не теряя источник. */
export function retarget(store, draftId, { action, target, project }) {
  const draft = store.draft(draftId);
  if (!draft) throw new StoreError('Черновик не найден.', 'not_found');
  if (project && project !== draft.project.id) {
    if (!store.projects.has(project)) throw new StoreError(`Неизвестный проект: ${project}`, 'invalid');
    draft.project = { ...draft.project, id: project, confidence: 'high', reason: 'Проект выбран вручную.' };
  }
  if (action) draft.action = action;
  if (target !== undefined) draft.target = target || null;
  draft.proposal = buildProposal(store, draft, draft);
  return store.saveDraft(draft);
}

function registerSource(store, draft, entityId, generatedBody) {
  const id = draft.duplicateOf?.id || `src-${draft.source.hash.slice(0, 12)}`;
  const prev = store.source(id);
  const src = prev || {
    id, hash: draft.source.hash, title: draft.source.title, origin: draft.source.origin, size: draft.source.size,
    imported_at: new Date().toISOString(), derived: [], supersedes: draft.priorVersion?.id || null,
  };
  if (entityId && !src.derived.includes(entityId)) src.derived.push(entityId);
  if (generatedBody && !src.generated_body) src.generated_body = generatedBody;
  return store.saveSource(src, draft.source.text);
}

/**
 * Шаг 6-7: решение владельца. Одобрение записи НЕ меняет видимость: публикация это отдельное действие (setVisibility).
 * decision = { action, target, project, entity: { type, title, summary, body, states, links, ... }, kind, confidence, note }
 */
export function approve(store, draftId, decision) {
  const draft = store.draft(draftId);
  if (!draft) throw new StoreError('Черновик не найден (возможно, уже обработан).', 'not_found');
  const action = decision.action || draft.action;
  const kind = decision.kind || 'user-idea';
  if (!PROVENANCE_KINDS[kind]) throw new StoreError(`Неизвестный вид происхождения: ${kind}`, 'invalid');
  const date = new Date().toISOString().slice(0, 10);

  if (action === 'defer') {
    draft.status = 'deferred';
    store.saveDraft(draft);
    store.logEvent({ event: 'import-deferred', draft: draft.id, hash: draft.source.hash });
    return { action, draft };
  }
  if (action === 'skip') {
    if (draft.duplicateOf) {
      const src = store.source(draft.duplicateOf.id);
      if (src) { src.reimports = [...(src.reimports || []), new Date().toISOString()]; store.saveSource(src); }
    }
    store.removeDraft(draft.id);
    store.logEvent({ event: 'import-skipped', hash: draft.source.hash, duplicate_of: draft.duplicateOf?.id || null, title: draft.source.title });
    store.commit(`Импорт пропущен: ${draft.source.title}`);
    return { action };
  }

  const fields = decision.entity || draft.proposal;
  const project = decision.project || draft.project.id;
  const prov = (srcId, act, extra = '') => ({
    source: srcId, kind, confidence: decision.confidence || 'unconfirmed', date, action: act,
    ...(decision.note || extra ? { note: [decision.note, extra].filter(Boolean).join(' ') } : {}),
  });
  const srcId = draft.duplicateOf?.id || `src-${draft.source.hash.slice(0, 12)}`;
  let entity;

  if (action === 'create') {
    if (draft.duplicateOf?.derived.length) {
      throw new StoreError('Этот материал уже импортирован, и по нему есть запись. Новую независимую запись создать нельзя: выберите "Связать" или "Обновить".', 'duplicate', draft.duplicateOf);
    }
    if (!project) throw new StoreError('Не выбран проект.', 'invalid');
    if (!ENTITY_TYPES[fields.type]) throw new StoreError('Не выбран тип записи.', 'invalid');
    entity = store.saveEntity({
      type: fields.type, project, title: fields.title, summary: fields.summary, body: fields.body, slug: fields.slug,
      states: { ...defaultStates(), ...(fields.states || {}) }, links: fields.links || [], tags: fields.tags || [],
      roadmap: fields.roadmap || undefined, visibility: 'private', provenance: [prov(srcId, 'create')],
    }, { event: 'import-create', note: draft.source.title });
  } else if (action === 'update' || action === 'link') {
    const target = decision.target || draft.target;
    const en = target && store.entities.get(target);
    if (!en) throw new StoreError('Не выбрана запись для обновления.', 'invalid');
    const unresolved = action === 'update' ? (draft.proposal.conflicts || []).length : 0;
    const patch = action === 'update'
      ? { title: fields.title ?? en.title, summary: fields.summary ?? en.summary, body: fields.body ?? en.body, states: { ...en.states, ...(fields.states || {}) }, links: fields.links || en.links }
      : {};
    entity = store.saveEntity({
      ...en, ...patch,
      provenance: [...en.provenance, prov(srcId, action, unresolved ? `При слиянии найдено расхождений с новой версией источника: ${unresolved}. Текст записи имел приоритет.` : '')],
    }, { baseEtag: draft.proposal.baseEtag || undefined, event: `import-${action}`, note: draft.source.title });
  } else {
    throw new StoreError(`Неизвестное действие: ${action}`, 'invalid');
  }

  registerSource(store, draft, entity.id, buildDraftBody(draft.source.text));
  store.removeDraft(draft.id);
  store.commit(`Импорт (${action}): ${entity.title}`);
  return { action, entity };
}

/** Разрешение и запрет публикации это отдельное от одобрения действие с собственной записью в журнале. */
export function setVisibility(store, id, visibility, { baseEtag } = {}) {
  const en = store.entities.get(id);
  if (!en) throw new StoreError('Запись не найдена.', 'not_found');
  if (en.visibility === visibility) return en;
  const saved = store.saveEntity({ ...en, visibility }, { baseEtag, event: visibility === 'public' ? 'publish-allowed' : 'publish-revoked' });
  store.commit(`${visibility === 'public' ? 'Разрешена публикация' : 'Публикация отозвана'}: ${saved.title}`);
  return saved;
}
