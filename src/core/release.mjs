// Выпуск: экспорт → сборка → проверка приватности. Сначала всё делается во временном каталоге;
// в content/ и dist/ результат попадает, только если проверка не нашла утечек.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPublicSnapshot, writeSnapshot } from './exporter.mjs';
import { checkPrivacy } from './privacy.mjs';
import { buildSite } from '../site/build.mjs';

export function siteConfig(repoRoot) {
  const f = path.join(repoRoot, 'hub.config.json');
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return { base: process.env.SITE_BASE || c.base || '/', login: c.login || '', ...c };
}

export function release(store, repoRoot, { base, previewBase } = {}) {
  const contentDir = path.join(repoRoot, 'content');
  const distDir = path.join(repoRoot, 'dist');
  const tmp = path.join(repoRoot, '.cache', 'release');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'content'), { recursive: true });
  for (const keep of ['site.json', 'activity.json', 'feedback.json']) {
    if (fs.existsSync(path.join(contentDir, keep))) fs.copyFileSync(path.join(contentDir, keep), path.join(tmp, 'content', keep));
  }
  const snap = buildPublicSnapshot(store);
  writeSnapshot(store, snap, path.join(tmp, 'content'));
  const cfg = siteConfig(repoRoot);
  buildSite({ contentDir: path.join(tmp, 'content'), outDir: path.join(tmp, 'dist'), base: base || cfg.base });
  const privacy = checkPrivacy(store, [path.join(tmp, 'content'), path.join(tmp, 'dist')]);
  if (!privacy.ok) {
    store.logEvent({ event: 'release-blocked', violations: privacy.violations.length });
    return { ok: false, privacy, changes: null, build: null };
  }
  const changes = writeSnapshot(store, snap, contentDir);
  const build = buildSite({ contentDir, outDir: distDir, base: base || cfg.base });
  let preview = null;
  if (previewBase) preview = buildSite({ contentDir, outDir: path.join(repoRoot, '.cache', 'preview'), base: previewBase });
  fs.rmSync(tmp, { recursive: true, force: true });
  store.logEvent({ event: 'release', entities: snap.entities.length, added: changes.added.length, changed: changes.changed.length, removed: changes.removed.length });
  return { ok: true, privacy, changes, build, preview, entities: snap.entities.length, projects: snap.projects.length, git: gitStatus(repoRoot) };
}

/** Что изменилось в публичном репозитории после выпуска. Нужно, чтобы владелец видел, что уйдёт в commit. */
export function gitStatus(repoRoot) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'content'], { cwd: repoRoot, encoding: 'utf8' });
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    return { branch, changed: out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })) };
  } catch { return null; }
}
