#!/usr/bin/env node
// hub: командная строка Developer Knowledge Hub. Всё, что умеет студия, доступно и отсюда.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, StoreError, resolveStorePath } from './core/store.mjs';
import { analyze, approve, setVisibility } from './core/importer.mjs';
import { exportPublic } from './core/exporter.mjs';
import { checkPrivacy } from './core/privacy.mjs';
import { release, siteConfig } from './core/release.mjs';
import { buildSite } from './site/build.mjs';
import { fetchActivity, syncCodeRefs, fetchFeedback, syncDiscussions } from './core/github.mjs';
import { readSnapshot } from './core/exporter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const args = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); }
  else args.push(a);
}
const storePath = () => resolveStorePath(ROOT, flags.store);
const open = () => new Store(storePath()).load();
const content = path.join(ROOT, 'content');
const dist = path.join(ROOT, 'dist');
const say = (s = '') => console.log(s);

const HELP = `hub: Developer Knowledge Hub

  Хранилище приватное. Путь: --store, HUB_STORE или hub.local.json, по умолчанию ../knowledge
    init                       создать пустое хранилище
    validate                   проверить структуру записей
    backup [каталог]           полная копия хранилища с отметкой времени

  Импорт и разбор
    import <файл|каталог>      проанализировать материал(ы) и положить предложения в очередь
           [--project id] [--title "…"]
    drafts                     показать очередь разбора
    approve <draft-id>         принять предложение [--action create|update|link|skip|defer]
           [--target id] [--type idea] [--kind user-idea]
    allow <id> / revoke <id>   разрешить или отозвать публикацию записи (отдельно от одобрения)

  Публикация
    release                    экспорт → сборка → проверка приватности (основная команда)
    export | build | check     те же шаги по отдельности
    serve [--port 4320]        посмотреть собранный dist/ локально
    activity                   получить календарь активности GitHub в content/activity.json
    sync                       сверить ссылки на PR/Issue/коммиты с GitHub
    feedback                   получить оценки и число комментариев из GitHub Discussions
    discuss [--create]         показать (или создать) обсуждения для опубликованных идей и механик

  Студия
    studio [--port 4319]       локальный интерфейс: импорт, черновики, редактор, выпуск
`;

function printViolations(p) {
  for (const v of p.violations.slice(0, 40)) say(`  ✗ ${v.file}: ${v.what}${v.sample ? `, "${v.sample}"` : ''}`);
  if (p.violations.length > 40) say(`  … и ещё ${p.violations.length - 40}`);
}

const commands = {
  help: () => say(HELP),
  init() { const s = Store.init(storePath()); say(`Хранилище готово: ${s.root}`); },
  validate() {
    const s = open();
    for (const p of s.problems) say(`${p.level === 'error' ? '✗' : '!'} ${p.file}${p.id ? ` (${p.id})` : ''}: ${p.messages.join('. ')}`);
    say(`Проектов: ${s.projects.size}, записей: ${s.entities.size}, ошибок: ${s.errors.length}, предупреждений: ${s.problems.length - s.errors.length}`);
    if (s.errors.length) process.exitCode = 1;
  },
  backup() {
    const s = open();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dest = path.resolve(args[0] || path.join(s.root, '..', 'knowledge-backups'), `knowledge-${stamp}`);
    if (dest.startsWith(s.root + path.sep)) throw new StoreError('Каталог копии не может лежать внутри хранилища.');
    fs.cpSync(s.root, dest, { recursive: true });
    say(`Копия создана: ${dest}\nВосстановление: скопируйте этот каталог на место хранилища.`);
  },
  import() {
    const s = open();
    if (!args[0]) throw new StoreError('Укажите файл или каталог: hub import <путь>');
    const target = path.resolve(args[0]);
    const files = fs.statSync(target).isDirectory()
      ? fs.readdirSync(target, { recursive: true }).map((f) => path.join(target, String(f))).filter((f) => /\.(md|markdown|txt)$/i.test(f) && !f.split(path.sep).some((x) => x.startsWith('.')) && fs.statSync(f).isFile())
      : [target];
    for (const f of files) {
      try {
        const d = analyze(s, { text: fs.readFileSync(f, 'utf8'), origin: `файл ${path.basename(f)}`, title: flags.title, fileName: path.basename(f), project: flags.project });
        say(`${d.id}  "${d.source.title}"\n  проект: ${d.project.id || '-'} (${d.project.confidence})  действие: ${d.action}${d.target ? ` → ${d.target}` : ''}\n  ${d.reason}`);
        for (const m of d.matches.slice(0, 3)) say(`    ~ ${m.score}  ${m.id}  ${m.title}`);
      } catch (e) { say(`✗ ${path.basename(f)}: ${e.message}`); process.exitCode = 1; }
    }
    say(`\nПредложения ждут в очереди. Разберите их в студии (npm run studio) или командой "hub approve".`);
  },
  drafts() { for (const d of open().drafts()) say(`${d.id}  ${d.status.padEnd(8)} ${d.action.padEnd(6)} ${d.project.id || '-'}  "${d.source.title}"`); },
  approve() {
    const s = open();
    const d = s.draft(args[0] || '');
    if (!d) throw new StoreError('Черновик не найден. Список: hub drafts');
    const entity = flags.type ? { ...d.proposal, type: flags.type } : undefined;
    const r = approve(s, d.id, { action: flags.action, target: flags.target, project: flags.project, kind: flags.kind, entity });
    say(r.entity ? `${r.action}: ${r.entity.id} "${r.entity.title}" (ревизия ${r.entity.revision}, ${r.entity.visibility})` : `${r.action}: готово`);
  },
  allow() { const e = setVisibility(open(), args[0], 'public'); say(`Публикация разрешена: ${e.id} "${e.title}". В сборку попадёт после "hub release".`); },
  revoke() { const e = setVisibility(open(), args[0], 'private'); say(`Публикация отозвана: ${e.id} "${e.title}". Из content/ исчезнет после "hub release".`); },
  export() {
    const { snapshot, changes } = exportPublic(open(), content);
    say(`Экспортировано: проектов ${snapshot.projects.length}, записей ${snapshot.entities.length} (+${changes.added.length} ~${changes.changed.length} −${changes.removed.length})`);
  },
  build() {
    const r = buildSite({ contentDir: content, outDir: dist, base: flags.base || siteConfig(ROOT).base });
    say(`Сайт собран: ${r.pages} страниц, записей ${r.entities}, проектов ${r.projects}${r.hasActivity ? '' : ' (без данных активности GitHub)'} → dist/`);
  },
  check() {
    const p = checkPrivacy(open(), [content, dist]);
    say(`Проверка приватности: файлов ${p.scanned}, канареек ${p.canaries}, нарушений ${p.violations.length}`);
    if (!p.ok) { printViolations(p); process.exitCode = 1; }
  },
  release() {
    const r = release(open(), ROOT, { base: flags.base });
    if (!r.ok) { say(`ВЫПУСК ОСТАНОВЛЕН: проверка приватности нашла ${r.privacy.violations.length} нарушений. content/ и dist/ не изменены.`); printViolations(r.privacy); process.exitCode = 1; return; }
    say(`Выпуск готов: записей ${r.entities}, страниц ${r.build.pages}. Изменения в content/: +${r.changes.added.length} ~${r.changes.changed.length} −${r.changes.removed.length}`);
    say(`Проверка приватности: файлов ${r.privacy.scanned}, канареек ${r.privacy.canaries}, нарушений 0`);
    say('Дальше: посмотрите "npm run serve", затем закоммитьте content/ в публичный репозиторий.');
  },
  async activity() {
    const login = flags.login || siteConfig(ROOT).login;
    if (!login) throw new StoreError('Не задан login в hub.config.json.');
    const a = await fetchActivity(login);
    fs.mkdirSync(content, { recursive: true });
    fs.writeFileSync(path.join(content, 'activity.json'), JSON.stringify(a) + '\n');
    say(`Активность ${login}: ${a.total} за год, дней ${a.days.length} → content/activity.json`);
  },
  async feedback() {
    const cfg = siteConfig(ROOT).feedback;
    if (!cfg?.repo) throw new StoreError('В hub.config.json не задан feedback.repo.');
    const f = await fetchFeedback(cfg.repo);
    fs.writeFileSync(path.join(content, 'feedback.json'), JSON.stringify(f) + '\n');
    say(`Оценки: связанных с записями обсуждений ${Object.keys(f.items).length} → content/feedback.json`);
  },
  async discuss() {
    const cfg = siteConfig(ROOT);
    if (!cfg.feedback?.repo || !cfg.siteUrl) throw new StoreError('В hub.config.json нужны feedback.repo и siteUrl.');
    const types = cfg.feedback.types || ['idea', 'mechanic'];
    const entities = readSnapshot(content).entities.filter((e) => types.includes(e.type));
    const r = await syncDiscussions({ repo: cfg.feedback.repo, category: cfg.feedback.category || 'Ideas', entities, siteUrl: cfg.siteUrl, create: flags.create === true });
    say(`Обсуждений уже есть: ${r.existing}. Не хватает: ${r.missing.length}`);
    for (const m of r.missing) say(`  ${flags.create === true ? '+' : '·'} ${m.id}  ${m.title}`);
    if (flags.create !== true && r.missing.length) say('Это только план. Создать обсуждения (публично, от вашего имени): hub discuss --create');
    for (const c of r.created) say(`  создано: ${c.url}`);
  },
  async sync() {
    const r = await syncCodeRefs(open(), { log: say });
    say(`Сверено ссылок: ${r.checked}. Обновлено записей: ${r.updated.length}. Ошибок: ${r.failed.length}`);
    for (const m of r.mismatches) say(`  ! ${m.title}: ${m.message}`);
  },
  serve() {
    const port = Number(flags.port) || 4320;
    const base = (flags.base || siteConfig(ROOT).base).replace(/\/?$/, '/');
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!p.startsWith(base)) { res.writeHead(302, { location: base }); return res.end(); }
      let f = path.normalize(path.join(dist, p.slice(base.length)));
      if (!f.startsWith(dist)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': mime['.html'] }); return res.end(fs.existsSync(path.join(dist, '404.html')) ? fs.readFileSync(path.join(dist, '404.html')) : 'Не найдено'); }
      res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(f));
    }).listen(port, '127.0.0.1', () => say(`Сайт: http://127.0.0.1:${port}${base}`));
  },
  async studio() {
    const { createStudio } = await import('./studio/server.mjs');
    const sp = storePath();
    if (!fs.existsSync(path.join(sp, 'store.yaml'))) throw new StoreError(`Хранилище не найдено: ${sp}. Создайте его: npm run hub -- init`, 'no_store');
    const st = createStudio({ storePath: sp, repoRoot: ROOT, port: Number(flags.port) || 4319 });
    const port = await st.listen();
    say(`Студия: http://127.0.0.1:${port}/\nХранилище: ${sp}\nОстановить: Ctrl+C`);
  },
};

try {
  if (!cmd || !commands[cmd]) { say(HELP); if (cmd) process.exitCode = 1; }
  else await commands[cmd]();
} catch (e) {
  if (e instanceof StoreError) { console.error(`Ошибка: ${e.message}`); if (Array.isArray(e.details)) for (const d of e.details.slice(0, 20)) console.error(`  ${d.file || ''} ${(d.messages || [d]).join?.('; ') ?? d}`); }
  else console.error(`Ошибка: ${e.message}`);
  process.exitCode = 1;
}
