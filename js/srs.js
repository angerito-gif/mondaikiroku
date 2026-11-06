// 復習スケジュール（忘却曲線）と日付まわりの純粋な関数

/** 復習間隔（日）。stage はこの配列の添字 */
export const INTERVALS = [1, 3, 7, 14, 30];
export const RESULTS = ['ok', 'unsure', 'ng'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = '日月火水木金土';

const pad = (n) => String(n).padStart(2, '0');

/** 端末の現地時刻で YYYY-MM-DD（日付の区切りは 0 時） */
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

/** b - a の日数 */
export function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** 11/9(月) 形式 */
export function fmtDate(str) {
  if (!str) return '';
  const d = parseDate(str);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

/** 全角英数を半角にし、前後の空白を除く */
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function newProblem({ book, page, number, subject, unit }, today, now = Date.now()) {
  return {
    id: uid(),
    book, page, number, subject, unit: unit || '',
    createdAt: today,
    createdTs: now,
    stage: 0,
    dueDate: addDays(today, INTERVALS[0]),
    graduated: false,
    graduatedAt: null,
    history: [],
    updatedAt: now,
  };
}

/**
 * 復習結果を反映した新しい問題オブジェクトを返す（元は変更しない）
 *  ok     : 次の間隔へ。最後の間隔（30日）での ok は卒業
 *  unsure : 同じ間隔をもう一度
 *  ng     : 最初（1日後）に戻す
 * 次回日は「実際に復習した日（today）」から数える
 */
export function applyReview(p, result, today, now = Date.now()) {
  if (!RESULTS.includes(result)) throw new Error('unknown result: ' + result);
  const np = {
    ...p,
    history: [...p.history, { date: today, result, stage: p.stage }],
    updatedAt: now,
  };
  if (result === 'ok') {
    if (p.stage >= INTERVALS.length - 1) {
      np.graduated = true;
      np.graduatedAt = today;
      np.dueDate = null;
    } else {
      np.stage = p.stage + 1;
      np.dueDate = addDays(today, INTERVALS[np.stage]);
    }
  } else if (result === 'unsure') {
    np.dueDate = addDays(today, INTERVALS[p.stage]);
  } else {
    np.stage = 0;
    np.dueDate = addDays(today, INTERVALS[0]);
  }
  return np;
}

/** 卒業した問題を復習に戻す */
export function reviveProblem(p, today, now = Date.now()) {
  return { ...p, graduated: false, graduatedAt: null, stage: 0, dueDate: addDays(today, INTERVALS[0]), updatedAt: now };
}

export const MAX_RANGE = 100;

/**
 * 問題番号の入力を分解する
 *  "3, 5, 7-9" → ["3","5","7","8","9"]
 *  "例題3"     → ["例題3"]
 * 区切りはカンマ（, 、 ，）。範囲は数字同士の - ~ 〜 ー −
 */
export function parseNumbers(input) {
  const s = normalizeText(input);
  if (!s) return [];
  const parts = s.split(/[,、，]+/).map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const t of parts) {
    const m = t.match(/^(\d+)\s*[-~〜ー−–]\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (b - a + 1 > MAX_RANGE) throw new Error(`範囲が大きすぎます（一度に${MAX_RANGE}問まで）`);
      for (let i = a; i <= b; i++) out.push(String(i));
    } else {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

/** 同じ問題かどうかの判定キー */
export const problemKey = (p) => [p.book, p.page, p.number].join('\u0000');

// ---- バックアップ（インポート）----

const clampStage = (v) => Math.min(Math.max(parseInt(v, 10) || 0, 0), INTERVALS.length - 1);
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);

export function sanitizeProblem(o) {
  if (!o || typeof o !== 'object' || !o.id || !o.book) return null;
  const s = (v) => (v == null ? '' : String(v));
  const createdAt = isDate(o.createdAt) ? o.createdAt : todayStr();
  const graduated = !!o.graduated;
  const history = Array.isArray(o.history)
    ? o.history
        .filter((h) => h && isDate(h.date) && RESULTS.includes(h.result))
        .map((h) => ({ date: h.date, result: h.result, stage: clampStage(h.stage) }))
    : [];
  return {
    id: s(o.id),
    book: s(o.book),
    page: s(o.page),
    number: s(o.number),
    subject: s(o.subject),
    unit: s(o.unit),
    createdAt,
    createdTs: Number(o.createdTs) || Date.parse(createdAt) || Date.now(),
    stage: clampStage(o.stage),
    dueDate: graduated ? null : isDate(o.dueDate) ? o.dueDate : addDays(createdAt, 1),
    graduated,
    graduatedAt: graduated ? (isDate(o.graduatedAt) ? o.graduatedAt : createdAt) : null,
    history,
    updatedAt: Number(o.updatedAt) || 0,
  };
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONファイルとして読み込めませんでした');
  }
  const arr = Array.isArray(data) ? data : data?.problems;
  if (!Array.isArray(arr)) throw new Error('問題記録のバックアップファイルではありません');
  return arr.map(sanitizeProblem).filter(Boolean);
}

/** id ごとに更新日時が新しい方を残して統合 */
export function mergeProblems(current, incoming) {
  const map = new Map(current.map((p) => [p.id, p]));
  for (const p of incoming) {
    const cur = map.get(p.id);
    if (!cur || (p.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(p.id, p);
  }
  return [...map.values()];
}
