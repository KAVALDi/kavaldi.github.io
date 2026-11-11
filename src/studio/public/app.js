// Интерфейс студии. Без сборки и фреймворков. Весь импортированный текст вставляется как текст (не HTML).
'use strict';
const $app = document.getElementById('app');
let S = null; // состояние с сервера

// --- утилиты ---
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'open' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-hub': '1' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: 'Сервер вернул непонятный ответ.' }));
  if (!res.ok) { const e = new Error(data.error || `Ошибка ${res.status}`); e.code = data.code; e.details = data.details; throw e; }
  return data;
}
let toastTimer;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 9000 : 3500);
}
const fail = (e) => toast(e.message, true);
// Подтверждение внутри страницы (вместо системного confirm): видно, что именно произойдёт.
function ask(title, text, okLabel) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'ask' }, h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { dlg.close(); dlg.remove(); resolve(true); } }, okLabel),
        h('button', { onclick: () => { dlg.close(); dlg.remove(); resolve(false); } }, 'Отмена')));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
const opt = (value, label, sel) => h('option', { value, selected: sel === value }, label);
const select = (map, sel, attrs = {}, labelOf = (v) => v) => h('select', attrs, Object.entries(map).map(([k, v]) => opt(k, labelOf(v), sel)));
// Поле внутри label: подпись связана с полем для программ чтения с экрана и клика по подписи.
const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'cap' }, label), control);
const typeLabel = (t) => S.schema.types[t]?.label || t;
const projTitle = (id) => S.projects.find((p) => p.id === id)?.title || id || '-';
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: iso.length > 10 ? 'short' : undefined }) : '');
const stateTags = (states) => Object.entries(S.schema.states).filter(([d]) => states[d] && states[d] !== 'unknown')
  .map(([d, def]) => h('span', { class: 'tag' }, `${def.label}: ${def.values[states[d]]}`));

function diffView(diff) {
  const box = h('div', { class: 'diff' });
  if (!diff.some((l) => l.op !== ' ')) { box.append(h('div', { class: 'gap' }, 'Текст не меняется')); return box; }
  const keep = new Set();
  diff.forEach((l, i) => { if (l.op !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
  let gap = false;
  diff.forEach((l, i) => {
    if (!keep.has(i)) { if (!gap) box.append(h('div', { class: 'gap' }, '⋯')); gap = true; return; }
    gap = false;
    box.append(h('div', { class: l.op === '+' ? 'a' : l.op === '-' ? 'd' : '' }, (l.op === ' ' ? '  ' : l.op + ' ') + l.text));
  });
  return box;
}

// Редактор списка однотипных строк (связи, ссылки на код, источники).
function rowEditor(rows, cols, colsCss) {
  const data = rows.map((r) => ({ ...r }));
  const box = h('div', { class: 'rows', style: `--cols:${colsCss}` });
  const draw = () => {
    box.textContent = '';
    data.forEach((r, i) => box.append(h('div', { class: 'r' },
      cols.map((c) => c.render(r, (v) => { r[c.key] = v; })),
      h('button', { type: 'button', class: 'danger', title: 'Убрать', onclick: () => { data.splice(i, 1); draw(); } }, '×'))));
    box.append(h('button', { type: 'button', onclick: () => { data.push({}); draw(); } }, '+ Добавить'));
  };
  draw();
  box.value = () => data.filter((r) => cols.every((c) => !c.required || String(r[c.key] ?? '').trim()));
  return box;
}
const textCol = (key, placeholder, required = true) => ({ key, required, render: (r, set) => h('input', { type: 'text', placeholder, value: r[key] ?? '', oninput: (e) => set(e.target.value.trim()) }) });
const selCol = (key, map, labelOf) => ({ key, required: true, render: (r, set) => { if (!r[key]) r[key] = Object.keys(map)[0]; return select(map, r[key], { onchange: (e) => set(e.target.value) }, labelOf); } });
const entityCol = (key, selfId) => ({ key, required: true, render: (r, set) => h('select', { onchange: (e) => set(e.target.value) }, opt('', 'Выберите запись', r[key] || ''),
  S.entities.filter((e) => e.id !== selfId).map((e) => opt(e.id, `${e.title} · ${typeLabel(e.type)} · ${projTitle(e.project)}`, r[key]))) });
const linksEditor = (links, selfId) => rowEditor(links || [], [selCol('rel', S.schema.rels, (v) => v.label), entityCol('to', selfId)], '11rem 1fr');

function statesEditor(states) {
  const sels = {};
  const el = h('div', { class: 'row' }, Object.entries(S.schema.states).map(([dim, def]) => field(def.label, (sels[dim] = select(def.values, states?.[dim] || 'unknown')))));
  el.value = () => Object.fromEntries(Object.entries(sels).map(([d, s]) => [d, s.value]));
  return el;
}

// --- навигация ---
async function refresh() {
  S = await api('GET', '/api/state');
  document.getElementById('n-drafts').textContent = S.drafts.length || '';
  const errs = S.problems.filter((p) => p.level === 'error').length;
  document.getElementById('problems').textContent = errs ? `Ошибок в хранилище: ${errs}` : '';
}
async function route() {
  const [, view = 'inbox', id] = location.hash.split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === (view === 'draft' ? 'inbox' : view === 'entity' ? 'entities' : view)));
  try {
    await refresh();
    $app.textContent = '';
    await ({ inbox: viewInbox, draft: viewDraft, entities: viewEntities, entity: viewEntity, release: viewRelease }[view] || viewInbox)(id);
    window.scrollTo(0, 0);
  } catch (e) { $app.textContent = ''; $app.append(h('div', { class: 'panel err' }, e.message), h('p', {}, h('a', { href: '#/inbox' }, 'К импорту'))); }
}
window.addEventListener('hashchange', route);

// --- импорт и очередь ---
function viewInbox() {
  const text = h('textarea', { class: 'tall', style: 'min-height:14rem', placeholder: 'Вставьте сюда обсуждение, заметку или Markdown…' });
  const title = h('input', { type: 'text', placeholder: 'Необязательно: название материала' });
  const project = h('select', {}, opt('', 'Определить автоматически', ''), S.projects.map((p) => opt(p.id, p.title, '')));
  const file = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/plain,text/markdown', hidden: true });
  let origin = 'вставка в студии', fileName = '';
  const readFile = (f) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return toast('Файл больше 2 МБ. Разделите его на части.', true);
    const r = new FileReader();
    r.onload = () => { text.value = r.result; fileName = f.name; origin = `файл ${f.name}`; toast(`Файл "${f.name}" загружен в поле. Нажмите "Разобрать".`); };
    r.onerror = () => toast('Не удалось прочитать файл.', true);
    r.readAsText(f);
  };
  file.addEventListener('change', () => readFile(file.files[0]));
  const drop = h('div', { class: 'drop' }, 'Перетащите сюда файл .md или .txt, или ', h('button', { type: 'button', class: 'link', onclick: () => file.click() }, 'выберите файл'), file);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
  const go = h('button', { class: 'primary', onclick: async () => {
    if (!text.value.trim()) return toast('Сначала вставьте текст или выберите файл.', true);
    go.disabled = true;
    try { const d = await api('POST', '/api/import', { text: text.value, title: title.value, fileName, project: project.value, origin }); location.hash = `#/draft/${d.id}`; }
    catch (e) { fail(e); go.disabled = false; }
  } }, 'Разобрать');
  $app.append(h('h1', {}, 'Импорт материала'),
    h('div', { class: 'panel' },
      h('p', { class: 'muted' }, 'Материал сначала попадает на разбор. В базу он войдёт только после вашего одобрения, а на сайт, только после отдельного разрешения на публикацию.'),
      text, drop, h('div', { class: 'row' }, field('Название', title), field('Проект', project)),
      h('div', { class: 'actions' }, go, h('span', { class: 'muted small' }, 'Сопоставление выполняется правилами на этом компьютере. AI не подключён.'))));
  $app.append(h('h2', {}, 'Очередь разбора'));
  if (!S.drafts.length) $app.append(h('p', { class: 'muted' }, 'Очередь пуста.'));
  else $app.append(h('div', { class: 'panel tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Материал', 'Проект', 'Предложение', 'Добавлен', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, S.drafts.map((d) => h('tr', {}, h('td', {}, h('a', { href: `#/draft/${d.id}` }, d.title)), h('td', {}, projTitle(d.project)),
      h('td', {}, ACTIONS[d.action]?.[0] || d.action, d.status === 'deferred' ? h('span', { class: 'tag' }, 'отложено') : null), h('td', {}, fmt(d.created)), h('td', {}, h('a', { href: `#/draft/${d.id}` }, 'Разобрать'))))))));
  if (S.events.length) $app.append(h('details', {}, h('summary', {}, 'Журнал последних действий'), h('div', { class: 'panel tablewrap' }, h('table', {}, h('tbody', {},
    S.events.map((e) => h('tr', {}, h('td', { class: 'muted' }, fmt(e.at)), h('td', {}, e.event), h('td', {}, e.entity ? h('a', { href: `#/entity/${e.entity}` }, e.entity) : (e.title || '')), h('td', { class: 'muted' }, e.note || ''))))))));
}

const ACTIONS = {
  create: ['Создать новую запись', 'Материал станет отдельной записью базы'],
  update: ['Обновить существующую', 'Дополнить или изменить текст выбранной записи'],
  link: ['Только связать', 'Приложить материал как источник, текст записи не менять'],
  defer: ['Отложить', 'Оставить в очереди и вернуться позже'],
  skip: ['Пропустить', 'Ничего не создавать (например, это повтор)'],
};

// --- разбор одного материала ---
async function viewDraft(id) {
  const d = await api('GET', `/api/drafts/${id}`);
  const p = d.proposal;
  const again = async (patch) => { try { await api('POST', `/api/drafts/${id}/retarget`, patch); route(); } catch (e) { fail(e); } };
  const needsTarget = d.action === 'update' || d.action === 'link';
  const writes = d.action === 'create' || d.action === 'update';

  $app.append(h('p', { class: 'small' }, h('a', { href: '#/inbox' }, '← Очередь разбора')), h('h1', {}, d.source.title),
    h('p', { class: 'muted' }, `${d.source.origin} · ${Math.ceil(d.source.size / 1024)} КБ · добавлен ${fmt(d.created)} · ${d.analysis.note}`));
  if (d.duplicateOf) $app.append(h('div', { class: 'warn' }, h('strong', {}, 'Повторный импорт. '), d.reason));
  else if (d.priorVersion) $app.append(h('div', { class: 'warn' }, h('strong', {}, 'Похоже на новую версию. '), `Совпадение с источником "${d.priorVersion.title}" (${fmt(d.priorVersion.imported_at)}), ${Math.round(d.priorVersion.similarity * 100)}%.`));

  // 1. проект
  $app.append(h('div', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '1'), 'Проект'),
    h('div', { class: 'row' }, h('select', { onchange: (e) => again({ project: e.target.value }) }, d.project.id ? null : opt('', 'Выберите проект', ''), S.projects.map((x) => opt(x.id, x.title, d.project.id))),
      h('div', { class: d.project.confidence === 'high' ? 'note' : 'warn' }, d.project.reason))));

  // 2. совпадения
  $app.append(h('div', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '2'), 'Что уже есть по теме'),
    d.matches.length ? d.matches.map((m) => h('div', { class: 'match' }, h('span', { class: 'score', title: 'Похожесть от 0 до 1' }, m.score.toFixed(2)),
      h('a', { href: `#/entity/${m.id}`, target: '_blank' }, m.title), h('span', { class: 'tag' }, typeLabel(m.type)), h('span', { class: 'muted small' }, projTitle(m.project)),
      h('span', { class: 'muted small' }, `общие слова: ${m.terms.join(', ')}`),
      h('button', { type: 'button', onclick: () => again({ action: 'update', target: m.id }) }, 'Обновить её'),
      h('button', { type: 'button', onclick: () => again({ action: 'link', target: m.id }) }, 'Связать')))
      : h('p', { class: 'muted' }, 'Похожих записей не найдено.')));

  // 3. действие
  const targetSel = h('select', { onchange: (e) => again({ target: e.target.value }) }, opt('', 'Выберите запись', d.target || ''),
    S.entities.map((e) => opt(e.id, `${e.title} · ${typeLabel(e.type)} · ${projTitle(e.project)}`, d.target)));
  $app.append(h('div', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '3'), 'Что сделать'), h('p', { class: 'note' }, d.reason),
    h('div', { class: 'choices' }, Object.entries(ACTIONS).map(([k, [label, hint]]) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'action', value: k, checked: d.action === k, onchange: () => again({ action: k }) }), h('span', {}, label, h('small', {}, hint))))),
    needsTarget ? field('Запись', targetSel) : null));

  // 4. черновик
  const f = {};
  const kind = select(S.schema.provenance, 'user-idea');
  const confidence = select(S.schema.confidence, 'unconfirmed');
  const note = h('input', { type: 'text', placeholder: 'Необязательно: откуда материал, кто участвовал' });
  if (writes) {
    f.type = select(S.schema.types, p.type, { disabled: d.action === 'update' }, (v) => v.label);
    f.title = h('input', { type: 'text', value: p.title });
    f.summary = h('textarea', { style: 'min-height:4rem;font-family:inherit' }); f.summary.value = p.summary || '';
    f.body = h('textarea', { class: 'tall' }); f.body.value = p.body;
    f.states = statesEditor(p.states);
    f.links = linksEditor(p.links, d.target);
    const diffBox = h('div', {});
    if (d.action === 'update' && p.diff) diffBox.append(diffView(p.diff));
    const rediff = h('button', { type: 'button', onclick: async () => { try { const r = await api('POST', '/api/diff', { a: d.targetEntity.body, b: f.body.value }); diffBox.textContent = ''; diffBox.append(diffView(r.diff)); toast(`Изменения: +${r.stats.added} −${r.stats.removed}`); } catch (e) { fail(e); } } }, 'Пересчитать изменения');
    $app.append(h('div', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '4'), d.action === 'update' ? 'Изменения записи' : 'Черновик записи'),
      d.action === 'update' && p.mergeMode === 'three-way' ? h('p', { class: 'note' }, 'Трёхстороннее слияние: ваши правки записи сохранены, изменения из новой версии источника добавлены там, где вы текст не трогали.') : null,
      d.action === 'update' && p.mergeMode === 'append' ? h('p', { class: 'note' }, 'Новый материал добавлен в конец записи отдельным разделом. Противоречия со старым текстом автоматически не проверялись (AI не подключён), просмотрите сами.') : null,
      (p.conflicts || []).length ? h('div', { class: 'warn' }, h('strong', {}, `Расхождения: ${p.conflicts.length}. `), 'В этих местах вы меняли запись, а новая версия источника говорит другое. В тексте оставлен ваш вариант.',
        p.conflicts.map((c) => h('div', { class: 'row', style: 'margin-top:.5rem' }, field('В записи сейчас', h('pre', { class: 'src' }, c.ours || '(пусто)')), field('В новой версии источника', h('pre', { class: 'src' }, c.theirs || '(удалено)'))))) : null,
      d.action === 'update' ? h('div', {}, h('h3', {}, 'Что изменится в тексте'), diffBox, rediff) : null,
      h('div', { class: 'row' }, field('Тип', f.type), field('Название', f.title)), field('Краткое описание', f.summary),
      field('Текст (Markdown). Разделы с "_не заполнено_" и раздел "Материал источника" на сайт не попадают', f.body),
      h('h3', {}, 'Состояния (независимые)'), f.states, h('h3', {}, 'Связи'), f.links));
  }
  if (d.action !== 'skip' && d.action !== 'defer') {
    $app.append(h('div', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, writes ? '5' : '4'), 'Происхождение'),
      h('div', { class: 'row' }, field('Чем является этот материал', kind), field('Степень подтверждения', confidence)), field('Примечание', note)));
  }
  $app.append(h('details', {}, h('summary', {}, 'Исходный текст материала'), h('pre', { class: 'src' }, d.source.text)));

  const label = { create: 'Одобрить и создать запись', update: 'Одобрить изменения', link: 'Связать с записью', defer: 'Отложить', skip: 'Пропустить материал' }[d.action];
  const ok = h('button', { class: 'primary', onclick: async () => {
    ok.disabled = true;
    try {
      const entity = writes ? { type: f.type.value, title: f.title.value, summary: f.summary.value, body: f.body.value, states: f.states.value(), links: f.links.value() } : undefined;
      const r = await api('POST', `/api/drafts/${id}/approve`, { action: d.action, target: d.target, project: d.project.id, entity, kind: kind.value, confidence: confidence.value, note: note.value });
      toast({ create: 'Запись создана. Она приватная, пока вы отдельно не разрешите публикацию.', update: 'Запись обновлена, прежняя версия сохранена в истории.', link: 'Материал приложен к записи.', defer: 'Отложено.', skip: 'Материал пропущен, новых записей нет.' }[r.action]);
      location.hash = r.entity ? `#/entity/${r.entity.id}` : '#/inbox';
    } catch (e) { fail(e); ok.disabled = false; }
  } }, label);
  $app.append(h('div', { class: 'actions' }, ok,
    h('button', { class: 'danger', onclick: async () => { if (!(await ask('Удалить черновик разбора?', 'Сам материал в базу не попадёт.', 'Удалить'))) return; try { await api('DELETE', `/api/drafts/${id}`); location.hash = '#/inbox'; } catch (e) { fail(e); } } }, 'Удалить черновик'),
    h('span', { class: 'muted small' }, 'Одобрение не публикует запись.')));
}

// --- список записей ---
async function viewEntities() {
  const q = h('input', { type: 'search', placeholder: 'Поиск по базе' });
  const proj = h('select', {}, opt('', 'Все проекты', ''), S.projects.map((p) => opt(p.id, p.title, '')));
  const type = h('select', {}, opt('', 'Все типы', ''), Object.entries(S.schema.types).map(([k, v]) => opt(k, v.label, '')));
  const vis = h('select', {}, opt('', 'Любая видимость', ''), opt('public', 'Разрешено публиковать', ''), opt('private', 'Только для меня', ''));
  const body = h('tbody', {});
  const draw = async () => {
    let list = S.entities;
    if (q.value.trim()) { try { list = await api('GET', `/api/search?q=${encodeURIComponent(q.value)}`); } catch (e) { return fail(e); } }
    list = list.filter((e) => (!proj.value || e.project === proj.value) && (!type.value || e.type === type.value) && (!vis.value || e.visibility === vis.value));
    body.textContent = '';
    body.append(...list.map((e) => h('tr', {}, h('td', {}, h('a', { href: `#/entity/${e.id}` }, e.title), h('div', { class: 'muted small' }, e.summary.slice(0, 110))),
      h('td', {}, typeLabel(e.type)), h('td', {}, projTitle(e.project)), h('td', {}, stateTags(e.states), e.stale ? h('span', { class: 'tag stale' }, 'сверить с кодом') : null),
      h('td', {}, h('span', { class: `tag ${e.visibility === 'public' ? 'pub' : 'priv'}` }, e.visibility === 'public' ? 'публично' : 'приватно')), h('td', { class: 'muted' }, e.updated))));
    if (!list.length) body.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Ничего не найдено.')));
  };
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 200); });
  for (const s of [proj, type, vis]) s.addEventListener('change', draw);
  $app.append(h('h1', {}, 'Записи'), h('div', { class: 'panel' }, h('div', { class: 'row' }, q, proj, type, vis),
    h('div', { class: 'actions' }, h('button', { onclick: () => { location.hash = '#/entity/new'; } }, '+ Новая запись вручную'),
      h('button', { onclick: async (e) => { e.target.disabled = true; try { const r = await api('POST', '/api/sync'); toast(`GitHub: проверено ссылок ${r.checked}, обновлено записей ${r.updated.length}, ошибок ${r.failed.length}.`, r.failed.length > 0); route(); } catch (x) { fail(x); e.target.disabled = false; } } }, 'Сверить ссылки на код с GitHub'))),
    h('div', { class: 'panel tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Запись', 'Тип', 'Проект', 'Состояния', 'Видимость', 'Изменена'].map((x) => h('th', {}, x)))), body)));
  if (S.problems.length) $app.append(h('details', {}, h('summary', {}, `Замечания к хранилищу: ${S.problems.length}`), h('div', { class: 'panel' }, S.problems.map((p) => h('p', { class: p.level === 'error' ? 'err' : 'muted' }, `${p.file}: ${p.messages.join('. ')}`)))));
  await draw();
}

// --- редактор записи ---
async function viewEntity(id) {
  const isNew = id === 'new';
  const data = isNew ? { entity: { type: 'idea', project: S.projects[0]?.id, title: '', summary: '', body: '', states: {}, links: [], code_refs: [], references: [], visibility: 'private' }, history: [], provenance: [], stale: [], backlinks: [], preview: null } : await api('GET', `/api/entities/${id}`);
  const e = data.entity;
  const f = {
    type: select(S.schema.types, e.type, {}, (v) => v.label),
    project: h('select', {}, S.projects.map((p) => opt(p.id, p.title, e.project))),
    title: h('input', { type: 'text', value: e.title }),
    slug: h('input', { type: 'text', value: e.slug || '', placeholder: 'создаётся из названия' }),
    summary: h('textarea', { style: 'min-height:4rem;font-family:inherit' }),
    body: h('textarea', { class: 'tall' }),
    states: statesEditor(e.states),
    links: linksEditor(e.links, e.id),
    code_refs: rowEditor(e.code_refs || [], [textCol('repo', 'владелец/репозиторий'), selCol('kind', Object.fromEntries(S.schema.codeKinds.map((k) => [k, k]))), textCol('ref', 'номер PR, SHA или путь')], '1.4fr 7rem 1fr'),
    references: rowEditor(e.references || [], [textCol('title', 'Название', false), textCol('url', 'https://…')], '1fr 1.4fr'),
    lane: h('select', {}, opt('', 'Не показывать на дорожной карте', e.roadmap?.lane || ''), Object.entries(S.schema.lanes).map(([k, v]) => opt(k, v, e.roadmap?.lane))),
    order: h('input', { type: 'number', value: e.roadmap?.order ?? 100 }),
    ingame_url: h('input', { type: 'text', value: e.ingame_url || '', placeholder: 'https://… ссылка на представление "как в игре"' }),
    docs_reviewed: h('input', { type: 'date', value: e.docs_reviewed || '' }),
  };
  f.summary.value = e.summary || ''; f.body.value = e.body || '';
  const collect = () => ({
    type: f.type.value, project: f.project.value, title: f.title.value, slug: f.slug.value || undefined, summary: f.summary.value, body: f.body.value, states: f.states.value(),
    links: f.links.value(), references: f.references.value(), ingame_url: f.ingame_url.value, docs_reviewed: f.docs_reviewed.value,
    roadmap: f.lane.value ? { lane: f.lane.value, order: Number(f.order.value) || 100 } : null,
    // сохраняем сведения, полученные сверкой с GitHub, если ссылка не менялась
    code_refs: f.code_refs.value().map((c) => ({ ...(e.code_refs || []).find((o) => o.repo === c.repo && o.kind === c.kind && String(o.ref) === String(c.ref)), ...c })),
  });
  const save = h('button', { class: 'primary', onclick: async () => {
    save.disabled = true;
    try {
      const r = isNew ? await api('POST', '/api/entities', { fields: collect() }) : await api('PUT', `/api/entities/${id}`, { fields: collect(), baseEtag: e.etag });
      toast(isNew ? 'Запись создана.' : 'Сохранено. Прежняя версия сохранена в истории.');
      if (isNew) location.hash = `#/entity/${r.id}`; else route();
    } catch (x) { fail(x); save.disabled = false; }
  } }, isNew ? 'Создать запись' : 'Сохранить');

  const main = h('div', {}, h('div', { class: 'panel' },
    h('div', { class: 'row' }, field('Название', f.title), field('Тип', f.type), field('Проект', f.project)), field('Краткое описание', f.summary),
    field('Текст (Markdown). %%так%% помечается приватный комментарий. Раздел "Материал источника" остаётся внутренним', f.body),
    h('h3', {}, 'Состояния (независимые)'), f.states,
    data.stale.length ? h('div', { class: 'warn' }, h('strong', {}, 'Возможно, устарело. '), `После сверки ${e.docs_reviewed} изменился связанный код: `, data.stale.map((s) => `${s.repo} ${s.kind} ${s.ref} (${s.date})`).join('. '), '. Проверьте текст и обновите дату сверки.') : null,
    h('div', { class: 'row' }, field('Дорожная карта', f.lane), field('Порядок в колонке', f.order), field('Документация сверена с кодом', f.docs_reviewed)),
    h('h3', {}, 'Связи с другими записями'), f.links,
    h('h3', {}, 'Код: PR, коммиты, файлы, тесты'), f.code_refs,
    h('h3', {}, 'Публичные источники (ссылки)'), f.references,
    field('Представление "как в игре"', f.ingame_url), isNew ? null : field('Адрес страницы (slug). Прежние адреса продолжают работать', f.slug),
    h('div', { class: 'actions' }, save, isNew ? null : h('span', { class: 'muted small' }, `${e.id} · ревизия ${e.revision} · ${e.file}`))));

  const side = h('div', {});
  if (!isNew) {
    const pv = data.preview || {};
    const pub = e.visibility === 'public';
    const setVis = async (v) => { try { await api('POST', `/api/entities/${id}/visibility`, { visibility: v, baseEtag: e.etag }); toast(v === 'public' ? 'Публикация разрешена. На сайт запись попадёт при следующем выпуске.' : 'Публикация отозвана. С сайта запись исчезнет при следующем выпуске.'); route(); } catch (x) { fail(x); } };
    side.append(h('div', { class: 'panel' }, h('h2', {}, 'Публикация'),
      h('p', {}, h('span', { class: `tag ${pub ? 'pub' : 'priv'}` }, pub ? 'разрешено публиковать' : 'только для меня')),
      pv.error ? h('p', { class: 'err' }, pv.error) : null,
      pv.projectPublic === false ? h('p', { class: 'warn' }, 'Проект целиком приватный: запись не попадёт на сайт, даже если разрешить публикацию.') : null,
      pv.entity ? h('details', {}, h('summary', {}, 'Что именно увидят посетители'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Название'), h('dd', {}, pv.entity.title), h('dt', {}, 'Описание'), h('dd', {}, pv.entity.summary || '-'),
          h('dt', {}, 'Связей'), h('dd', {}, `${pv.entity.links.length} (скрыто ${pv.withheld.links})`), h('dt', {}, 'Ссылок на код'), h('dd', {}, `${pv.entity.code_refs.length} (скрыто ${pv.withheld.code_refs})`)),
        h('pre', { class: 'src' }, pv.entity.body || '(текста нет)'),
        h('p', { class: 'muted small' }, `Не публикуется: сведения о происхождении (${pv.withheld.provenance}), внутренние строки текста (${pv.withheld.internalLines}), связи с приватными записями, код из непубличных репозиториев.`)) : null,
      h('div', { class: 'actions' }, pub
        ? h('button', { class: 'danger', onclick: () => setVis('private') }, 'Отозвать публикацию')
        : h('button', { onclick: async () => { if (await ask(`Разрешить публикацию записи "${e.title}"?`, 'После следующего выпуска она появится в открытом репозитории и на сайте. Что именно увидят посетители, показано в этом блоке.', 'Разрешить публикацию')) setVis('public'); } }, 'Разрешить публикацию…'))));

    side.append(h('div', { class: 'panel' }, h('h2', {}, 'Происхождение'),
      data.provenance.length ? data.provenance.map((p) => h('p', { class: 'small' }, h('strong', {}, S.schema.provenance[p.kind] || p.kind), ` · ${S.schema.confidence[p.confidence] || 'неизвестно'} · ${p.date || 'дата неизвестна'}`,
        p.source ? h('span', {}, ' · ', h('button', { class: 'link', onclick: async () => { try { const s = await api('GET', `/api/sources/${p.source}`); srcBox.textContent = ''; srcBox.append(h('p', { class: 'muted small' }, `${s.title} · ${s.origin} · ${fmt(s.imported_at)}`), h('pre', { class: 'src' }, s.text || '(текст не сохранён)')); } catch (x) { fail(x); } } }, p.sourceTitle || p.source)) : null,
        p.note ? h('span', { class: 'muted' }, `: ${p.note}`) : null)) : h('p', { class: 'muted' }, 'Источник не указан.'),
      (data.backlinks.length ? h('div', {}, h('h3', {}, 'На эту запись ссылаются'), data.backlinks.map((b) => h('p', { class: 'small' }, h('a', { href: `#/entity/${b.from}` }, b.title), ` · ${S.schema.rels[b.rel]?.label || b.rel}`))) : null)));
    const srcBox = h('div', {});
    side.append(srcBox);

    const histBox = h('div', {});
    side.append(h('div', { class: 'panel' }, h('h2', {}, 'История'),
      data.history.length ? data.history.slice().reverse().map((x) => h('p', { class: 'small' }, `Ревизия ${x.revision} · ${x.updated || ''} `,
        h('button', { class: 'link', onclick: async () => { try { const r = await api('GET', `/api/entities/${id}/history/${x.revision}`); histBox.textContent = ''; histBox.append(h('p', { class: 'muted small' }, `Изменения от ревизии ${r.revision} к текущей: +${r.stats.added} −${r.stats.removed}`), diffView(r.diff)); } catch (y) { fail(y); } } }, 'что изменилось с тех пор')))
        : h('p', { class: 'muted' }, 'Это первая ревизия.'), histBox));
  }
  $app.append(h('p', { class: 'small' }, h('a', { href: '#/entities' }, '← Записи')), h('h1', {}, isNew ? 'Новая запись' : e.title), isNew ? main : h('div', { class: 'split' }, main, side));
}

// --- выпуск ---
async function viewRelease() {
  const info = await api('GET', '/api/release');
  const out = h('div', {});
  const frame = h('div', {});
  const showPreview = () => { frame.textContent = ''; frame.append(h('p', {}, h('a', { href: '/preview/', target: '_blank' }, 'Открыть предпросмотр в новой вкладке')), h('iframe', { class: 'preview', src: '/preview/', title: 'Предпросмотр сайта' })); };
  const run = h('button', { class: 'primary', onclick: async () => {
    run.disabled = true; out.textContent = 'Выполняется экспорт, сборка и проверка…';
    try {
      const r = await api('POST', '/api/release');
      out.textContent = '';
      if (!r.ok) {
        out.append(h('div', { class: 'panel' }, h('p', { class: 'err' }, h('strong', {}, 'Выпуск остановлен. '), `Проверка приватности нашла нарушений: ${r.privacy.violations.length}. Публичные файлы не изменены.`),
          r.privacy.violations.slice(0, 30).map((v) => h('p', { class: 'small' }, `${v.file}: ${v.what}${v.sample ? `, "${v.sample}"` : ''}`))));
      } else {
        const c = r.changes;
        out.append(h('div', { class: 'panel' }, h('p', {}, h('strong', {}, 'Сайт собран. '), `Записей: ${r.entities}, страниц: ${r.build.pages}.`),
          h('p', {}, `Проверка приватности: файлов ${r.privacy.scanned}, контрольных фрагментов ${r.privacy.canaries}, нарушений нет.`),
          h('p', {}, `Изменения публичного снимка: добавлено ${c.added.length}, изменено ${c.changed.length}, удалено ${c.removed.length}.`),
          [...c.added.map((x) => `+ ${x}`), ...c.changed.map((x) => `~ ${x}`), ...c.removed.map((x) => `− ${x}`)].map((x) => h('div', { class: 'small muted' }, x)),
          r.git ? h('p', { class: 'note' }, `Чтобы сайт обновился в интернете, изменения каталога content/ нужно закоммитить и отправить в GitHub (ветка сейчас: ${r.git.branch}. Несохранённых файлов: ${r.git.changed.length}). Команды, в docs/PUBLISHING.md.`) : null));
        showPreview();
      }
    } catch (e) { out.textContent = ''; fail(e); }
    run.disabled = false;
  } }, 'Собрать сайт и проверить');
  $app.append(h('h1', {}, 'Выпуск сайта'), h('div', { class: 'panel' },
    h('p', {}, 'Выпуск делает три вещи: выгружает разрешённые к публикации записи в каталог content/, собирает сайт и проверяет, что в публичные файлы не попало ничего приватного. Если проверка находит утечку, публичные файлы остаются прежними.'),
    h('p', { class: 'muted' }, `К публикации разрешено записей: ${S.entities.filter((e) => e.visibility === 'public').length} из ${S.entities.length}. В интернет ничего не отправляется: отправка в GitHub, отдельный шаг.`),
    h('div', { class: 'actions' }, run)), out, frame);
  if (info.hasPreview) showPreview();
}

route();
