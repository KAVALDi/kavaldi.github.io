// Модель данных: типы сущностей, независимые измерения состояния, виды связей и происхождения.
// Единственное место, где перечислены допустимые значения. Студия, экспорт и сайт читают их отсюда.

export const ENTITY_TYPES = {
  mechanic: { prefix: 'mech', label: 'Механика', plural: 'Механики' },
  idea: { prefix: 'idea', label: 'Идея', plural: 'Идеи' },
  decision: { prefix: 'dec', label: 'Решение', plural: 'Решения' },
  research: { prefix: 'res', label: 'Исследование', plural: 'Исследования' },
  task: { prefix: 'task', label: 'Задача', plural: 'Задачи' },
  article: { prefix: 'art', label: 'Статья Wiki', plural: 'Wiki' },
  devlog: { prefix: 'log', label: 'Запись devlog', plural: 'Devlog' },
  component: { prefix: 'cmp', label: 'Компонент', plural: 'Компоненты' },
};

// Независимые измерения состояния. Их нельзя сводить к одному полю status:
// дизайн может быть принят, код лежать в PR, а публичная статья устареть.
export const STATE_DIMENSIONS = {
  design: {
    label: 'Дизайн',
    values: {
      unknown: 'неизвестно', draft: 'черновик', proposed: 'предложено', accepted: 'согласовано',
      rejected: 'отклонено', superseded: 'заменено', deferred: 'отложено',
    },
  },
  implementation: {
    label: 'Код',
    values: {
      unknown: 'неизвестно', none: 'нет', local: 'локально', pr: 'в PR', merged: 'в основной ветке',
      released: 'выпущено',
    },
  },
  verification: {
    label: 'Проверка',
    values: {
      unknown: 'неизвестно', none: 'не проверялось', partial: 'частично', tests: 'автотесты',
      manual: 'вручную', model: 'только модель',
    },
  },
  docs: {
    label: 'Документация',
    values: {
      unknown: 'неизвестно', none: 'нет', ready: 'готово для Wiki', published: 'опубликовано',
      stale: 'устарело',
    },
  },
};

export const LINK_RELS = {
  relates: { label: 'связано с', inverse: 'связано с' },
  'part-of': { label: 'часть', inverse: 'включает' },
  'depends-on': { label: 'зависит от', inverse: 'нужно для' },
  implements: { label: 'реализует', inverse: 'реализовано в' },
  documents: { label: 'документирует', inverse: 'описано в' },
  'decided-by': { label: 'определено решением', inverse: 'определяет' },
  supersedes: { label: 'заменяет', inverse: 'заменено на' },
  rejects: { label: 'отклоняет', inverse: 'отклонено в' },
  'evidence-for': { label: 'обосновывает', inverse: 'обосновано в' },
};

// Чем является утверждение/материал: проверяемый источник, идея человека, гипотеза AI и т.д.
export const PROVENANCE_KINDS = {
  'verified-source': 'проверяемый источник',
  'user-idea': 'идея владельца',
  'participant-idea': 'идея участника обсуждения',
  'ai-suggestion': 'гипотеза или предложение AI',
  decision: 'согласованное решение',
  rejected: 'отклонённый подход',
  implementation: 'реализация в коде',
  verification: 'результат проверки',
  publication: 'публикация документации',
  discussion: 'обсуждение',
  unknown: 'неизвестно',
};

export const CONFIDENCE = { confirmed: 'подтверждено', unconfirmed: 'не подтверждено', unknown: 'неизвестно' };
export const VISIBILITY = { private: 'только для меня', public: 'разрешено публиковать' };
export const ROADMAP_LANES = { done: 'Готово', now: 'В работе', next: 'Далее', later: 'Когда-нибудь' };
export const CODE_REF_KINDS = ['pr', 'issue', 'commit', 'branch', 'file', 'test', 'discussion'];

const ID_RE = /^[a-z]+-[a-z0-9]{6,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function defaultStates() {
  return { design: 'unknown', implementation: 'unknown', verification: 'unknown', docs: 'unknown' };
}

/** Проверка проекта. Возвращает массив строк-ошибок. */
export function validateProject(p) {
  const e = [];
  if (!p.id || !SLUG_RE.test(p.id)) e.push('id проекта должен быть латиницей через дефис');
  if (!p.title) e.push('нет title');
  if (p.visibility && !VISIBILITY[p.visibility]) e.push(`visibility: ${p.visibility}`);
  for (const k of ['keywords', 'public_repos', 'repos']) {
    if (p[k] != null && !Array.isArray(p[k])) e.push(`${k} должен быть списком`);
  }
  return e;
}

/** Проверка сущности. ctx = { projects: Map, entities: Map } нужен для проверки ссылок. */
export function validateEntity(en, ctx = {}) {
  const e = [];
  const w = [];
  if (!en.id || !ID_RE.test(en.id)) e.push(`некорректный id: ${en.id}`);
  if (!ENTITY_TYPES[en.type]) e.push(`неизвестный type: ${en.type}`);
  if (!en.title || !String(en.title).trim()) e.push('нет title');
  if (!en.slug || !SLUG_RE.test(en.slug)) e.push(`некорректный slug: ${en.slug}`);
  if (!VISIBILITY[en.visibility]) e.push(`visibility: ${en.visibility}`);
  if (!Number.isInteger(en.revision) || en.revision < 1) e.push('revision должен быть целым ≥ 1');
  if (ctx.projects && !ctx.projects.has(en.project)) e.push(`неизвестный проект: ${en.project}`);
  for (const [dim, val] of Object.entries(en.states || {})) {
    if (!STATE_DIMENSIONS[dim]) e.push(`неизвестное измерение состояния: ${dim}`);
    else if (!STATE_DIMENSIONS[dim].values[val]) e.push(`states.${dim}: ${val}`);
  }
  for (const l of en.links || []) {
    if (!LINK_RELS[l.rel]) e.push(`неизвестная связь: ${l.rel}`);
    if (!l.to) e.push('связь без цели');
    else if (ctx.entities && !ctx.entities.has(l.to)) w.push(`связь ведёт на отсутствующую запись ${l.to}`);
    if (l.to === en.id) e.push('связь на саму себя');
  }
  for (const c of en.code_refs || []) {
    if (!CODE_REF_KINDS.includes(c.kind)) e.push(`code_refs.kind: ${c.kind}`);
    if (!c.repo || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) e.push(`code_refs.repo: ${c.repo}`);
    if (c.ref == null || c.ref === '') e.push('code_refs без ref');
  }
  for (const p of en.provenance || []) {
    if (!PROVENANCE_KINDS[p.kind]) e.push(`provenance.kind: ${p.kind}`);
    if (p.confidence && !CONFIDENCE[p.confidence]) e.push(`provenance.confidence: ${p.confidence}`);
  }
  if (en.roadmap) {
    if (!ROADMAP_LANES[en.roadmap.lane]) e.push(`roadmap.lane: ${en.roadmap.lane}`);
  }
  for (const r of en.references || []) {
    if (!r.url || !/^https?:\/\//.test(r.url)) e.push(`references.url: ${r.url}`);
  }
  if (!(en.provenance || []).length) w.push('нет сведений о происхождении (provenance)');
  return { errors: e, warnings: w };
}
