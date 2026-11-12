// Текстовые утилиты без AI: нормализация, хеш, токены, похожесть, построчный diff и трёхстороннее слияние.
import { createHash, randomBytes } from 'node:crypto';

export function normalizeText(s) {
  return String(s ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const B32 = 'abcdefghjkmnpqrstvwxyz0123456789';
export function randomId(prefix, len = 8) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += B32[b[i] % 32];
  return `${prefix}-${s}`;
}

const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
export function slugify(s) {
  const t = String(s ?? '').toLowerCase().split('').map((c) => (c in TR ? TR[c] : c)).join('');
  return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'untitled';
}

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от ' +
  'меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был до вас нибудь опять уж вам ведь там потом себя ' +
  'ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж ' +
  'тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее были куда зачем всех можно ' +
  'при над об это эта эти также либо через после между который которая которые которых нужно the a an of to in is are and or for on with as at by be it this that from')
  .split(/\s+/));

/** Грубый стеммер: достаточно, чтобы "улей/улья/ульи" и "рамка/рамки" сближались. */
export function stem(w) {
  if (/^[a-z]/.test(w)) return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
  if (w.length <= 4) return w;
  const r = w.replace(/(иями|ями|ами|ого|его|ому|ему|ыми|ими|ией|ия|ие|ий|ый|ой|ая|яя|ое|ее|ые|ам|ям|ах|ях|ов|ев|ей|ом|ем|ую|юю|ть|ет|ют|ут|ит|ят|ал|ил|а|я|ы|и|о|е|у|ю|ь)$/, '');
  return r.length >= 3 ? r : w;
}

export function tokenize(s) {
  const out = [];
  for (const m of String(s ?? '').toLowerCase().replace(/ё/g, 'е').matchAll(/[\p{L}\p{N}#]+/gu)) {
    const w = m[0];
    if (w.length < 2 || STOP.has(w) || !/[\p{L}\p{N}]/u.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function termFreq(tokens, weight = 1, tf = new Map()) {
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + weight);
  return tf;
}

/** Корпус TF-IDF: docs = [{ id, tf: Map }]. Возвращает функцию оценки запроса. */
export function buildCorpus(docs) {
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1;
  const idf = (t) => Math.log(1 + (N + 1) / ((df.get(t) || 0) + 0.5));
  const vec = (tf) => {
    const v = new Map();
    let norm = 0;
    for (const [t, f] of tf) { const x = (1 + Math.log(f)) * idf(t); v.set(t, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const dv = docs.map((d) => ({ id: d.id, ...vec(d.tf) }));
  return {
    query(tf, limit = 8) {
      const q = vec(tf);
      const res = [];
      for (const d of dv) {
        let dot = 0;
        const shared = [];
        for (const [t, x] of q.v) { const y = d.v.get(t); if (y) { dot += x * y; shared.push([t, x * y]); } }
        if (!dot) continue;
        shared.sort((a, b) => b[1] - a[1]);
        res.push({ id: d.id, score: dot / (q.norm * d.norm), terms: shared.slice(0, 6).map((s) => s[0]) });
      }
      return res.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}

/** Доля общих словесных 3-шинглов: устойчивый признак "это новая версия того же текста". */
export function shingleSimilarity(a, b) {
  const sh = (s) => {
    const t = tokenize(s);
    const set = new Set();
    for (let i = 0; i + 2 < t.length; i++) set.add(t[i] + ' ' + t[i + 1] + ' ' + t[i + 2]);
    if (!set.size) for (const x of t) set.add(x);
    return set;
  };
  const A = sh(a), B = sh(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Пары совпавших индексов (LCS) между массивами строк. */
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 6_000_000) return []; // слишком большой вход: считаем всё изменённым, но не падаем
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Построчный diff: [{ op: ' ' | '-' | '+', text }]. */
export function diffLines(aText, bText) {
  const a = aText === '' ? [] : String(aText).split('\n');
  const b = bText === '' ? [] : String(bText).split('\n');
  const out = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length]]) {
    while (i < pi) out.push({ op: '-', text: a[i++] });
    while (j < pj) out.push({ op: '+', text: b[j++] });
    if (pi < a.length) { out.push({ op: ' ', text: a[pi] }); i = pi + 1; j = pj + 1; }
  }
  return out;
}

export function diffStats(d) {
  return { added: d.filter((x) => x.op === '+').length, removed: d.filter((x) => x.op === '-').length };
}

/**
 * Трёхстороннее слияние по строкам.
 * base: то, из чего обе версии выросли. ours: текущая запись (с правками владельца).
 * theirs: новая версия источника. Правки владельца никогда не перезаписываются молча:
 * при пересечении изменений остаётся ours, а расхождение попадает в conflicts.
 */
export function merge3(baseText, oursText, theirsText) {
  const base = baseText.split('\n'), ours = oursText.split('\n'), theirs = theirsText.split('\n');
  const mo = new Map(lcsPairs(base, ours));
  const mt = new Map(lcsPairs(base, theirs));
  const result = [];
  const conflicts = [];
  let b = 0, o = 0, t = 0;
  const flush = (bEnd, oEnd, tEnd) => {
    const bc = base.slice(b, bEnd), oc = ours.slice(o, oEnd), tc = theirs.slice(t, tEnd);
    const same = (x, y) => x.length === y.length && x.every((l, k) => l === y[k]);
    if (same(oc, bc)) result.push(...tc);
    else if (same(tc, bc) || same(oc, tc)) result.push(...oc);
    else {
      result.push(...oc);
      conflicts.push({ line: result.length - oc.length + 1, base: bc.join('\n'), ours: oc.join('\n'), theirs: tc.join('\n') });
    }
    b = bEnd; o = oEnd; t = tEnd;
  };
  for (let k = 0; k <= base.length; k++) {
    const end = k === base.length;
    if (end || (mo.has(k) && mt.has(k))) {
      const oi = end ? ours.length : mo.get(k), ti = end ? theirs.length : mt.get(k);
      if (oi < o || ti < t) continue;
      flush(k, oi, ti);
      if (!end) { result.push(base[k]); b = k + 1; o = oi + 1; t = ti + 1; }
    }
  }
  return { text: result.join('\n'), conflicts };
}
