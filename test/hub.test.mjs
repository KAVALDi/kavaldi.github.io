// Автотесты ядра на ТЕСТОВОМ хранилище (examples/store, вымышленные данные).
// Запуск: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '../src/core/store.mjs';
import { analyze, approve, retarget, setVisibility, buildDraftBody } from '../src/core/importer.mjs';
import { exportPublic, sanitizeBody, buildPublicSnapshot } from '../src/core/exporter.mjs';
import { checkPrivacy } from '../src/core/privacy.mjs';
import { buildSite } from '../src/site/build.mjs';
import { merge3, diffLines, shingleSimilarity } from '../src/core/text.mjs';
import { createStudio } from '../src/studio/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const note = (n) => fs.readFileSync(path.join(ROOT, 'examples', 'notes', n), 'utf8');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  const storeDir = path.join(dir, 'store');
  fs.cpSync(path.join(ROOT, 'examples', 'store'), storeDir, { recursive: true });
  const store = Store.init(storeDir, { git: false });
  return { dir, store, content: path.join(dir, 'content'), dist: path.join(dir, 'dist') };
}
const allText = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('тестовое хранилище проходит проверку структуры', () => {
  const { store } = fresh();
  assert.equal(store.errors.length, 0, JSON.stringify(store.errors));
  assert.equal(store.entities.size, 3);
});

test('слияние: правки владельца сохраняются, пересечение даёт конфликт', () => {
  const base = 'a\nb\nc\nd';
  assert.equal(merge3(base, 'a\nB!\nc\nd', 'a\nb\nc\nD2').text, 'a\nB!\nc\nD2');
  const m = merge3(base, 'a\nмоё\nc\nd', 'a\nчужое\nc\nd');
  assert.equal(m.text, 'a\nмоё\nc\nd');
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].theirs, 'чужое');
  assert.equal(merge3(base, base, 'a\nb\nc\nd\ne').text, 'a\nb\nc\nd\ne');
  assert.deepEqual(diffLines('a\nb', 'a\nc').map((d) => d.op), [' ', '-', '+']);
});

test('sanitizeBody убирает приватные комментарии, внутренние и пустые разделы', () => {
  const out = sanitizeBody('## Суть\n\nТекст %%секрет%% дальше\n\n## Гипотезы\n\n_не заполнено_\n\n## Материал источника\n\nсырой чат\n\n### Вложенный\n\nтоже сырой\n\n## Следующий шаг\n\nСделать');
  assert.match(out, /Текст\s+дальше/);
  assert.doesNotMatch(out, /секрет|Гипотезы|сырой|Вложенный/);
  assert.match(out, /Следующий шаг/);
});

test('импорт: проект, совпадения, черновик, одобрение без публикации', () => {
  const { store } = fresh();
  const d = analyze(store, { text: note('siren-v1.md'), origin: 'тест' });
  assert.equal(d.project.id, 'demo');
  assert.equal(d.matches[0].id, 'idea-demo0002', 'находит существующую идею про сирену');
  assert.equal(d.action, 'update');
  assert.equal(d.analysis.engine, 'rules');
  assert.match(d.proposal.body, /Дополнение из импорта/);
  // владелец решает иначе: отдельная запись
  const d2 = retarget(store, d.id, { action: 'create' });
  assert.match(d2.proposal.body, /## Гипотезы\n\nВозможно, сирена/);
  assert.match(d2.proposal.body, /## Открытые вопросы\n\nНужно ли смотрителю держать рычаг сирены всё время\?/);
  const { entity } = approve(store, d.id, { action: 'create', entity: { ...d2.proposal, type: 'idea' } });
  assert.equal(entity.visibility, 'private', 'одобрение не делает запись публичной');
  assert.equal(entity.revision, 1);
  assert.equal(entity.provenance[0].source, `src-${d.source.hash.slice(0, 12)}`);
  assert.equal(store.drafts().length, 0);
  assert.equal(store.sources().length, 1);
  assert.equal(new Store(store.root).load().entities.size, 4, 'запись читается с диска');
});

test('идемпотентность: повторный импорт не создаёт вторую запись', () => {
  const { store } = fresh();
  const d = analyze(store, { text: note('siren-v1.md') });
  const { entity } = approve(store, d.id, { action: 'create', entity: { ...retarget(store, d.id, { action: 'create' }).proposal } });
  const again = analyze(store, { text: note('siren-v1.md').replace(/\n/g, '\r\n') + '\n\n' });
  assert.equal(again.action, 'skip');
  assert.equal(again.duplicateOf.derived[0], entity.id);
  assert.throws(() => approve(store, again.id, { action: 'create', entity: again.proposal }), (e) => e instanceof StoreError && e.code === 'duplicate');
  approve(store, again.id, { action: 'skip' });
  assert.equal(store.entities.size, 4);
  assert.equal(store.sources().length, 1);
  assert.equal(store.source(again.duplicateOf.id).reimports.length, 1);
});

test('новая версия материала: обновление через слияние, правки владельца не теряются', () => {
  const { store } = fresh();
  const d = analyze(store, { text: note('siren-v1.md') });
  const created = approve(store, d.id, { action: 'create', entity: retarget(store, d.id, { action: 'create' }).proposal }).entity;
  // владелец правит запись руками: заполняет "Суть" и меняет строку про слышимость
  const edited = created.body.replace('## Суть\n\n_не заполнено_', '## Суть\n\nСирена заменяет свет в тумане.').replace('на двадцать клеток', 'на двадцать пять клеток');
  store.saveEntity({ ...created, body: edited });
  const v2 = analyze(store, { text: note('siren-v2.md') });
  assert.ok(v2.priorVersion && v2.priorVersion.similarity > 0.3);
  assert.equal(v2.action, 'update');
  assert.equal(v2.target, created.id);
  assert.equal(v2.proposal.mergeMode, 'three-way');
  assert.match(v2.proposal.body, /Сирена заменяет свет в тумане\./, 'ручная правка сохранена');
  assert.match(v2.proposal.body, /Проверить слышимость сирены/, 'новый раздел из второй версии добавлен');
  assert.match(v2.proposal.body, /двадцать пять клеток/, 'при конфликте остаётся вариант владельца');
  assert.equal(v2.proposal.conflicts.length, 1);
  assert.match(v2.proposal.body, /## Расхождения с источником .*\(внутреннее\)[\s\S]*тридцать клеток/, 'расхождение сохраняется в записи');
  assert.doesNotMatch(sanitizeBody(v2.proposal.body), /Расхождения|тридцать/, 'но на сайт не попадает');
  assert.match(v2.proposal.conflicts[0].theirs, /тридцать клеток/);
  assert.ok(v2.proposal.diff.some((l) => l.op === '+'));
  const updated = approve(store, v2.id, { action: 'update', entity: v2.proposal }).entity;
  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 3);
  assert.equal(updated.provenance.length, 2);
  assert.equal(store.history(created.id).length, 2, 'прежние ревизии сохранены');
  assert.equal(store.sources().length, 2);
  assert.equal(store.entities.size, 4, 'вторая версия не породила новую запись');
});

test('защита от молчаливой перезаписи: правка вне студии обнаруживается', () => {
  const { store } = fresh();
  const e = store.entities.get('idea-demo0002');
  const etag = e.etag;
  fs.appendFileSync(e.file, '\nСтрока, дописанная в Obsidian.\n');
  assert.throws(() => store.saveEntity({ ...e, title: 'Другое' }, { baseEtag: etag }), (x) => x.code === 'revision_conflict');
});

test('переименование сохраняет id и оставляет старый адрес', () => {
  const { store, content, dist } = fresh();
  const e = store.saveEntity({ ...store.entities.get('art-demo0003'), title: 'Устройство маяка', slug: 'ustroystvo-mayaka' });
  assert.equal(e.id, 'art-demo0003');
  assert.deepEqual(e.aliases, ['lighthouse']);
  exportPublic(store, content);
  buildSite({ contentDir: content, outDir: dist });
  assert.match(fs.readFileSync(path.join(dist, 'projects/demo/wiki/lighthouse/index.html'), 'utf8'), /url=\/projects\/demo\/wiki\/ustroystvo-mayaka\//);
  assert.ok(fs.existsSync(path.join(dist, 'e/art-demo0003/index.html')));
});

test('граница приватности: приватное физически отсутствует в content/ и dist/', () => {
  const { store, content, dist } = fresh();
  const d = analyze(store, { text: note('siren-v1.md') });
  approve(store, d.id, { action: 'create', entity: retarget(store, d.id, { action: 'create' }).proposal });
  exportPublic(store, content);
  const r = buildSite({ contentDir: content, outDir: dist, base: '/' });
  assert.ok(r.pages > 5);
  const text = allText(content) + allText(dist);
  for (const secret of ['Сирена смотрителя', 'idea-demo0002', 'нельзя публиковать', 'баланс тумана', 'Внутренняя заметка проекта', 'private-tools', 'балансировки', 'Закрытый тестовый', 'рычаг сирены', 'provenance', 'Тестовые данные.']) {
    assert.ok(!text.includes(secret), `утечка: "${secret}"`);
  }
  assert.ok(text.includes('Туман над маяком'));
  assert.ok(text.includes('идею про сирену'), 'текст ссылки на приватную запись остаётся, а сама ссылка нет');
  const p = checkPrivacy(store, [content, dist]);
  assert.equal(p.ok, true, JSON.stringify(p.violations.slice(0, 3)));
  assert.ok(p.canaries > 5);
  // проверка действительно ловит утечку, а не просто молчит
  fs.appendFileSync(path.join(dist, 'search-index.json'), '<b>Смотритель включает сирену,</b> чтобы корабли обходили скалы в густом тумане без света фонаря.');
  const leak = checkPrivacy(store, [content, dist]);
  assert.equal(leak.ok, false);
  assert.match(leak.violations[0].what, /приватная запись idea-demo0002/);
});

test('публикация это отдельное действие, отзыв удаляет запись из снимка', () => {
  const { store, content } = fresh();
  exportPublic(store, content);
  assert.ok(!fs.existsSync(path.join(content, 'entities/idea-demo0002.json')));
  setVisibility(store, 'idea-demo0002', 'public');
  exportPublic(store, content);
  const pub = JSON.parse(fs.readFileSync(path.join(content, 'entities/idea-demo0002.json'), 'utf8'));
  assert.equal(pub.provenance, undefined, 'происхождение не публикуется');
  assert.equal(pub.visibility, undefined);
  const mech = JSON.parse(fs.readFileSync(path.join(content, 'entities/mech-demo0001.json'), 'utf8'));
  assert.equal(mech.links.length, 1, 'после публикации идеи связь становится видимой');
  assert.match(mech.body, /\(hub:idea-demo0002\)/);
  setVisibility(store, 'idea-demo0002', 'private');
  const { changes } = exportPublic(store, content);
  assert.deepEqual(changes.removed, ['entities/idea-demo0002.json']);
  assert.equal(store.events().filter((e) => e.event.startsWith('publish-')).length, 2);
});

test('запись приватного проекта не публикуется даже с visibility public', () => {
  const { store } = fresh();
  store.saveEntity({ type: 'idea', project: 'secret', title: 'Обвал в шахте', body: 'Текст про обвал.', visibility: 'public', provenance: [{ kind: 'user-idea' }] });
  assert.ok(!buildPublicSnapshot(store).entities.some((e) => e.project === 'secret'));
});

test('устаревание: изменение кода после сверки помечает статью', () => {
  const { store, content, dist } = fresh();
  const snap = buildPublicSnapshot(store);
  const art = snap.entities.find((e) => e.id === 'art-demo0003');
  assert.equal(art.stale.length, 1);
  assert.equal(art.stale[0].ref, '7');
  exportPublic(store, content);
  buildSite({ contentDir: content, outDir: dist });
  assert.match(fs.readFileSync(path.join(dist, 'projects/demo/wiki/lighthouse/index.html'), 'utf8'), /Страница может быть устаревшей/);
  store.saveEntity({ ...store.entities.get('art-demo0003'), docs_reviewed: '2026-11-06' });
  assert.equal(buildPublicSnapshot(store).entities.find((e) => e.id === 'art-demo0003').stale.length, 0);
});

test('сборка: адреса учитывают базовый путь, дорожная карта строится из записей', () => {
  const { store, content, dist } = fresh();
  exportPublic(store, content);
  buildSite({ contentDir: content, outDir: dist, base: '/sub/' });
  const home = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(home, /href="\/sub\/assets\/site\.css"/);
  assert.match(home, /Данные об активности на GitHub ещё не получены/, 'без данных показывается честное сообщение, а не выдуманный календарь');
  assert.match(fs.readFileSync(path.join(dist, 'projects/demo/roadmap/index.html'), 'utf8'), /Туман над маяком/);
  for (const f of fs.readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dist, f), 'utf8');
    for (const m of html.matchAll(/href="(\/sub\/[^"#?]*)/g)) {
      const rel = m[1].slice('/sub/'.length);
      const target = path.join(dist, rel.endsWith('/') || rel === '' ? rel + 'index.html' : rel);
      assert.ok(fs.existsSync(target), `битая ссылка ${m[1]} на странице ${f}`);
    }
  }
});

test('недоверенный материал: разметка источника не исполняется на сайте', () => {
  const { store, content, dist } = fresh();
  const d = analyze(store, { text: '# Фонарь и масло маяка\n\n## Суть\n\nФонарь маяка <script>alert(1)</script> тратит масло.\n\n[ссылка](javascript:alert(2))', project: 'demo' });
  const e = approve(store, d.id, { action: 'create', entity: retarget(store, d.id, { action: 'create' }).proposal }).entity;
  setVisibility(store, e.id, 'public');
  exportPublic(store, content);
  buildSite({ contentDir: content, outDir: dist });
  const html = fs.readFileSync(path.join(dist, `projects/demo/kb/${e.slug}/index.html`), 'utf8');
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.throws(() => analyze(store, { text: '   ' }), (x) => x.code === 'empty');
});

test('студия: импорт по HTTP, защита от чужих сайтов', async () => {
  const { store, dir } = fresh();
  const st = createStudio({ storePath: store.root, repoRoot: dir, port: 0 });
  const port = await st.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.entities.length, 3);
    const noHeader = await fetch(`${url}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(noHeader.status, 403);
    const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub': '1' }, body: JSON.stringify(b) });
    const d = await (await post('/api/import', { text: note('siren-v1.md') })).json();
    assert.equal(d.project.id, 'demo');
    const r = await (await post(`/api/drafts/${d.id}/approve`, { action: 'link', target: 'idea-demo0002' })).json();
    assert.equal(r.entity.id, 'idea-demo0002');
    const ent = await (await fetch(`${url}/api/entities/idea-demo0002`)).json();
    assert.equal(ent.provenance.length, 2);
    assert.equal(ent.preview.entity.title, 'Сирена смотрителя');
    assert.equal((await fetch(`${url}/api/entities/nope-000000`)).status, 404);
    assert.equal((await fetch(`${url}/app.js`)).status, 200);
    assert.equal((await fetch(`${url}/..%2f..%2fpackage.json`)).status, 403, 'выход за пределы каталога запрещён');
  } finally { await st.close(); }
});

test('шинглы различают версию и посторонний текст', () => {
  assert.ok(shingleSimilarity(note('siren-v1.md'), note('siren-v2.md')) > 0.5);
  assert.ok(shingleSimilarity(note('siren-v1.md'), 'Совершенно другой текст про шахты, руду и вагонетки под землёй.') < 0.05);
  assert.equal(buildDraftBody('текст'), buildDraftBody('текст'), 'черновик детерминирован');
});
