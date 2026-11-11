// GitHub: календарь активности и сверка ссылок на код. Токен берётся из окружения
// (GITHUB_TOKEN / GH_TOKEN) или у установленного gh. В файлы и вывод он никогда не пишется.
import { execFileSync } from 'node:child_process';

let cached;
export function githubToken() {
  if (cached !== undefined) return cached;
  cached = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!cached) {
    try { cached = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { cached = null; }
  }
  return cached;
}

async function gh(pathOrUrl, { method = 'GET', body } = {}) {
  const token = githubToken();
  const res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com/${pathOrUrl}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'knowledge-hub', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} для ${pathOrUrl.split('?')[0]}`);
  return res.json();
}

/** Реальный календарь вкладов. Без токена GraphQL недоступен. Тогда честная ошибка, а не выдуманные данные. */
export async function fetchActivity(login) {
  if (!githubToken()) throw new Error('Нет токена GitHub (GITHUB_TOKEN или gh auth login): календарь активности получить нельзя.');
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const r = await gh('graphql', { method: 'POST', body: { query, variables: { login } } });
  if (r.errors?.length) throw new Error(`GitHub GraphQL: ${r.errors[0].message}`);
  const cal = r.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`Пользователь ${login} не найден.`);
  return {
    login, fetched_at: new Date().toISOString(), total: cal.totalContributions,
    source: 'GitHub GraphQL contributionCalendar',
    days: cal.weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount }))),
  };
}

/**
 * Обновляет у записей сведения о PR/Issue/коммитах (состояние, заголовок, дата слияния).
 * Состояния самой записи не трогает: расхождение "PR влит, а в записи код ещё в PR" возвращается
 * списком mismatches, решение остаётся за владельцем.
 */
export async function syncCodeRefs(store, { log = () => {} } = {}) {
  const result = { checked: 0, updated: [], mismatches: [], failed: [] };
  for (const en of [...store.entities.values()]) {
    let changed = false;
    const refs = [];
    for (const c of en.code_refs) {
      const next = { ...c };
      try {
        if (c.kind === 'pr') {
          const pr = await gh(`repos/${c.repo}/pulls/${c.ref}`);
          Object.assign(next, { title: pr.title, state: pr.merged_at ? 'merged' : pr.state, merged_at: pr.merged_at || undefined, changed_at: pr.merged_at || pr.updated_at });
        } else if (c.kind === 'issue') {
          const is = await gh(`repos/${c.repo}/issues/${c.ref}`);
          Object.assign(next, { title: is.title, state: is.state, changed_at: is.closed_at || is.updated_at });
        } else if (c.kind === 'commit') {
          const cm = await gh(`repos/${c.repo}/commits/${c.ref}`);
          Object.assign(next, { title: cm.commit.message.split('\n')[0], changed_at: cm.commit.committer.date });
        } else { refs.push(c); continue; }
        result.checked++;
        next.checked_at = new Date().toISOString().slice(0, 10);
        const same = ['title', 'state', 'merged_at', 'changed_at'].every((k) => next[k] === c[k]);
        if (!same) changed = true; else next.checked_at = c.checked_at || next.checked_at;
        if (next.state === 'merged' && ['pr', 'local', 'none', 'unknown'].includes(en.states.implementation)) {
          result.mismatches.push({ entity: en.id, title: en.title, message: `${c.repo}#${c.ref} влит ${String(next.merged_at).slice(0, 10)}, а состояние кода в записи: "${en.states.implementation}".` });
        }
      } catch (e) {
        result.failed.push({ entity: en.id, ref: `${c.repo} ${c.kind} ${c.ref}`, error: e.message });
        log(`  не удалось: ${c.repo} ${c.kind} ${c.ref}: ${e.message}`);
      }
      refs.push(JSON.parse(JSON.stringify(next)));
    }
    if (changed) {
      store.saveEntity({ ...en, code_refs: refs }, { event: 'github-sync' });
      result.updated.push(en.id);
    }
  }
  if (result.updated.length) store.commit(`Сверка с GitHub: обновлено записей: ${result.updated.length}`);
  return result;
}
