import * as db from './db.js';
import {
  INTERVALS, todayStr, addDays, diffDays, fmtDate, normalizeText, newProblem, applyReview,
  reviveProblem, parseNumbers, problemKey, parseBackup, mergeProblems,
} from './srs.js';

const APP_VERSION = '1.0.0';
const VIEWS = { home: '今日の復習', add: '問題を登録', list: '問題一覧', stats: '統計', settings: '設定' };
const RESULT_LABEL = { ok: '○ できた', unsure: '△ あやしい', ng: '× できなかった' };
const NO_UNIT = '（単元なし）';

const state = {
  problems: [],
  meta: {},
  view: 'home',
  list: { status: 'active', subject: '', book: '', sort: 'due' },
  statsSubject: '',
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const collator = new Intl.Collator('ja', { numeric: true });
const byLocation = (a, b) =>
  collator.compare(a.book, b.book) || collator.compare(a.page, b.page) || collator.compare(a.number, b.number);
const ngCount = (p) => p.history.filter((h) => h.result === 'ng').length;

function replaceInState(p) {
  const i = state.problems.findIndex((x) => x.id === p.id);
  if (i >= 0) state.problems[i] = p;
  else state.problems.push(p);
}

/** 新しく使った順に値を重複なく並べる */
function recentValues(key, filter = () => true) {
  const sorted = [...state.problems].filter(filter).sort((a, b) => b.createdTs - a.createdTs);
  const seen = new Set();
  const out = [];
  for (const p of sorted) {
    const v = p[key];
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function dueProblems(today = todayStr()) {
  return state.problems
    .filter((p) => !p.graduated && p.dueDate <= today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : byLocation(a, b)));
}

function stageDots(p) {
  const done = p.graduated ? INTERVALS.length : p.stage;
  return `<span class="dots" title="段階 ${done}/${INTERVALS.length}">${INTERVALS.map(
    (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`,
  ).join('')}</span>`;
}

function dueLabel(p, today = todayStr()) {
  if (p.graduated) return `<span class="due grad">🎓 卒業 ${fmtDate(p.graduatedAt)}</span>`;
  const d = diffDays(today, p.dueDate);
  if (d < 0) return `<span class="due late">${-d}日遅れ</span>`;
  if (d === 0) return `<span class="due today">今日</span>`;
  if (d === 1) return `<span class="due">明日</span>`;
  return `<span class="due">${d}日後 <small>${fmtDate(p.dueDate)}</small></span>`;
}

const titleHtml = (p) =>
  `<span class="book">${esc(p.book)}</span> <span class="loc">p.${esc(p.page)} <b>#${esc(p.number)}</b></span>`;
const subHtml = (p) =>
  `<span class="tag">${esc(p.subject)}</span><span class="unit">${esc(p.unit || '')}</span>`;

// ---------- toast ----------
let toastTimer;
function toast(msg, { action, duration = 3000 } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  if (action) {
    t.querySelector('button').onclick = () => { hideToast(); action.fn(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : duration);
}
function hideToast() {
  const t = $('#toast');
  t.classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 200);
}

// ---------- modal ----------
const modal = $('#modal');
function openModal(html) {
  modal.innerHTML = `<div class="sheet">${html}</div>`;
  if (!modal.open) modal.showModal();
}
function closeModal() {
  if (modal.open) modal.close();
}
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal(); // 背景タップで閉じる
});

/** ボタン選択式の確認ダイアログ。押されたボタンの value を返す（キャンセルは null） */
function choose(message, buttons) {
  return new Promise((resolve) => {
    openModal(`
      <p class="confirm-msg">${message}</p>
      <div class="btn-col">
        ${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || ''}" data-choice="${i}">${esc(b.label)}</button>`).join('')}
        <button type="button" class="btn ghost" data-choice="-1">キャンセル</button>
      </div>`);
    const onClick = (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn) return;
      cleanup();
      const i = Number(btn.dataset.choice);
      resolve(i < 0 ? null : buttons[i].value);
    };
    const onClose = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      modal.removeEventListener('click', onClick);
      modal.removeEventListener('close', onClose);
      closeModal();
    };
    modal.addEventListener('click', onClick);
    modal.addEventListener('close', onClose);
  });
}

// ---------- routing ----------
function showView(name) {
  if (!VIEWS[name]) name = 'home';
  state.view = name;
  for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = v !== name;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#title').textContent = VIEWS[name];
  renderCurrent();
  window.scrollTo(0, 0);
}

function renderCurrent() {
  ({ home: renderHome, add: renderAdd, list: renderList, stats: renderStats, settings: renderSettings })[state.view]();
  updateBadge();
}

function updateBadge() {
  const n = dueProblems().length;
  const b = $('#badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : n;
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ---------- home ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (state.view === 'home') renderHome();
});

function bannersHtml(today) {
  let html = '';
  if (!isStandalone() && !state.meta.installDismissed && (isIOS || installPrompt)) {
    html += `<div class="banner">
      <div><b>ホーム画面に追加しよう</b><br>
      ${isIOS
        ? 'Safari の共有ボタン <span class="share-ico">⬆︎</span> →「ホーム画面に追加」でアプリとして使えます。ホーム画面から使うと、データが消えにくくなります。'
        : 'アプリとして起動でき、オフラインでも使えます。'}</div>
      <div class="banner-actions">
        ${installPrompt ? '<button class="btn primary sm" data-action="install">追加する</button>' : ''}
        <button class="btn ghost sm" data-action="dismiss-install">閉じる</button>
      </div></div>`;
  }
  if (state.problems.length) {
    const last = state.meta.lastBackup;
    const snooze = state.meta.backupSnooze;
    const oldest = state.problems.reduce((m, p) => (p.createdAt < m ? p.createdAt : m), today);
    const days = last ? diffDays(last, today) : diffDays(oldest, today);
    if (days >= 14 && !(snooze && snooze > today)) {
      html += `<div class="banner warn">
        <div><b>バックアップしませんか？</b><br>${last ? `最後のバックアップから${days}日経っています。` : 'まだ一度もバックアップしていません。'}
        データはこの端末の中だけに保存されています。</div>
        <div class="banner-actions">
          <a class="btn primary sm" href="#settings">バックアップへ</a>
          <button class="btn ghost sm" data-action="snooze-backup">あとで</button>
        </div></div>`;
    }
  }
  return html;
}

function cardHtml(p, today) {
  const late = diffDays(p.dueDate, today);
  return `<article class="card" data-id="${esc(p.id)}">
    <button type="button" class="card-main" data-action="detail" data-id="${esc(p.id)}">
      <div class="card-title">${titleHtml(p)}</div>
      <div class="card-sub">${subHtml(p)}
        <span class="meta">${stageDots(p)} ${p.history.length + 1}回目${late > 0 ? ` <span class="late">${late}日遅れ</span>` : ''}</span>
      </div>
    </button>
    <div class="rate">
      <button type="button" class="r-ok" data-action="rate" data-result="ok" data-id="${esc(p.id)}"><b>○</b>できた</button>
      <button type="button" class="r-unsure" data-action="rate" data-result="unsure" data-id="${esc(p.id)}"><b>△</b>あやしい</button>
      <button type="button" class="r-ng" data-action="rate" data-result="ng" data-id="${esc(p.id)}"><b>×</b>できなかった</button>
    </div>
  </article>`;
}

function renderHome() {
  const today = todayStr();
  const due = dueProblems(today);
  const overdue = due.filter((p) => p.dueDate < today);
  const todays = due.filter((p) => p.dueDate === today);
  let html = bannersHtml(today);

  html += `<div class="summary">
    <div class="count"><span>${due.length}</span>件</div>
    <div class="summary-sub">${fmtDate(today)} の復習${overdue.length ? `<span class="pill danger">期限切れ ${overdue.length}</span>` : ''}</div>
  </div>`;

  if (!due.length) {
    if (!state.problems.length) {
      html += `<div class="empty">
        <p class="empty-big">📒</p>
        <p>まだ問題が登録されていません。<br>間違えた問題を登録すると、<br>翌日から復習リストに並びます。</p>
        <a class="btn primary" href="#add">最初の問題を登録する</a></div>`;
    } else {
      const tomorrow = addDays(today, 1);
      const n = state.problems.filter((p) => !p.graduated && p.dueDate === tomorrow).length;
      html += `<div class="empty">
        <p class="empty-big">🎉</p>
        <p><b>今日の復習は完了！</b></p>
        <p class="muted">明日の復習：${n}件</p></div>`;
    }
  } else {
    if (overdue.length) html += `<h2 class="group danger">期限切れ</h2>` + overdue.map((p) => cardHtml(p, today)).join('');
    if (todays.length) html += `<h2 class="group">今日</h2>` + todays.map((p) => cardHtml(p, today)).join('');
  }
  $('#view-home').innerHTML = html;
}

const rating = new Set();
async function rate(id, result, btn) {
  if (rating.has(id)) return;
  const p = state.problems.find((x) => x.id === id);
  if (!p) return;
  rating.add(id);
  try {
    const today = todayStr();
    const np = applyReview(p, result, today);
    await db.putProblem(np);
    replaceInState(np);
    const card = btn?.closest('.card');
    if (card) {
      card.classList.add('leaving', `leaving-${result}`);
      await wait(230);
    }
    closeModal();
    renderCurrent();
    const msg = np.graduated
      ? '🎓 卒業！復習リストから外れました'
      : `${RESULT_LABEL[result]} → 次回 ${fmtDate(np.dueDate)}（${diffDays(today, np.dueDate)}日後）`;
    toast(msg, {
      action: {
        label: '元に戻す',
        fn: async () => {
          await db.putProblem(p);
          replaceInState(p);
          renderCurrent();
        },
      },
    });
  } finally {
    rating.delete(id);
  }
}

// ---------- detail / edit ----------
function openDetail(id) {
  const p = state.problems.find((x) => x.id === id);
  if (!p) return;
  const today = todayStr();
  const isDue = !p.graduated && p.dueDate <= today;
  const hist = p.history.length
    ? `<ol class="history">${[...p.history].reverse().map((h) => `
        <li><span>${fmtDate(h.date)}</span><span class="res res-${h.result}">${RESULT_LABEL[h.result]}</span>
        <small>${INTERVALS[h.stage]}日間隔</small></li>`).join('')}</ol>`
    : '<p class="muted">まだ復習していません</p>';

  openModal(`
    <div class="sheet-head">
      <h2>${titleHtml(p)}</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="閉じる">✕</button>
    </div>
    <dl class="info">
      <dt>科目・単元</dt><dd>${subHtml(p)}</dd>
      <dt>登録日</dt><dd>${fmtDate(p.createdAt)}</dd>
      <dt>${p.graduated ? '卒業' : '次回復習'}</dt><dd>${dueLabel(p, today)}</dd>
      <dt>進み具合</dt><dd>${stageDots(p)} ${p.graduated ? '' : `<small class="muted">次は${INTERVALS[p.stage]}日間隔</small>`}</dd>
    </dl>
    ${isDue ? `<div class="rate in-modal">
      <button type="button" class="r-ok" data-action="rate" data-result="ok" data-id="${esc(p.id)}"><b>○</b>できた</button>
      <button type="button" class="r-unsure" data-action="rate" data-result="unsure" data-id="${esc(p.id)}"><b>△</b>あやしい</button>
      <button type="button" class="r-ng" data-action="rate" data-result="ng" data-id="${esc(p.id)}"><b>×</b>できなかった</button>
    </div>` : ''}
    <h3>復習の記録</h3>
    ${hist}
    <div class="btn-row">
      <button type="button" class="btn" data-action="edit" data-id="${esc(p.id)}">編集</button>
      ${p.graduated ? `<button type="button" class="btn" data-action="revive" data-id="${esc(p.id)}">復習に戻す</button>` : ''}
      <button type="button" class="btn danger-outline" data-action="delete" data-id="${esc(p.id)}">削除</button>
    </div>`);
}

function datalist(id, values) {
  return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
}

function openEdit(id) {
  const p = state.problems.find((x) => x.id === id);
  if (!p) return;
  openModal(`
    <div class="sheet-head">
      <h2>問題を編集</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="閉じる">✕</button>
    </div>
    <form id="edit-form" class="stack" data-id="${esc(p.id)}" autocomplete="off">
      <div class="field"><label>問題集</label><input name="book" value="${esc(p.book)}" list="dl-book" required></div>
      <div class="row">
        <div class="field page-field"><label>ページ</label><input name="page" value="${esc(p.page)}" required></div>
        <div class="field grow"><label>問題番号</label><input name="number" value="${esc(p.number)}" required></div>
      </div>
      <div class="field"><label>科目</label><input name="subject" value="${esc(p.subject)}" list="dl-subject" required></div>
      <div class="field"><label>単元</label><input name="unit" value="${esc(p.unit)}" list="dl-unit"></div>
      ${p.graduated ? '' : `<div class="field"><label>次回復習日</label><input type="date" name="dueDate" value="${esc(p.dueDate)}" required></div>`}
      ${datalist('dl-book', recentValues('book'))}
      ${datalist('dl-subject', recentValues('subject'))}
      ${datalist('dl-unit', recentValues('unit', (x) => x.subject === p.subject))}
      <div class="btn-row">
        <button type="button" class="btn ghost" data-action="detail" data-id="${esc(p.id)}">戻る</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
}

async function saveEdit(form) {
  const p = state.problems.find((x) => x.id === form.dataset.id);
  if (!p) return;
  const f = new FormData(form);
  const v = (k) => normalizeText(f.get(k));
  const np = { ...p, book: v('book'), page: v('page'), number: v('number'), subject: v('subject'), unit: v('unit'), updatedAt: Date.now() };
  if (!np.book || !np.page || !np.number || !np.subject) {
    toast('問題集・ページ・番号・科目は必須です');
    return;
  }
  if (!p.graduated && f.get('dueDate')) np.dueDate = f.get('dueDate');
  await db.putProblem(np);
  replaceInState(np);
  renderCurrent();
  openDetail(np.id);
  toast('保存しました');
}

async function deleteOne(id) {
  const p = state.problems.find((x) => x.id === id);
  if (!p) return;
  const ok = await choose(`<b>${esc(p.book)} p.${esc(p.page)} #${esc(p.number)}</b> を削除しますか？<br><small>復習の記録も消えます。</small>`,
    [{ label: '削除する', value: true, cls: 'danger' }]);
  if (!ok) return;
  await db.deleteProblem(id);
  state.problems = state.problems.filter((x) => x.id !== id);
  renderCurrent();
  toast('削除しました', {
    action: { label: '元に戻す', fn: async () => { await db.putProblem(p); replaceInState(p); renderCurrent(); } },
  });
}

async function revive(id) {
  const p = state.problems.find((x) => x.id === id);
  if (!p) return;
  const np = reviveProblem(p, todayStr());
  await db.putProblem(np);
  replaceInState(np);
  renderCurrent();
  openDetail(id);
  toast(`復習に戻しました（次回 ${fmtDate(np.dueDate)}）`);
}

// ---------- add ----------
const form = $('#add-form');
const fBook = $('#f-book');
const fSubject = $('#f-subject');
const fUnit = $('#f-unit');
const fPage = $('#f-page');
const fNumber = $('#f-number');

function chipsHtml(values, current, field) {
  const q = normalizeText(current).toLowerCase();
  // 入力途中なら部分一致で絞る（完全一致している時は全部出す）
  let list = values;
  if (q && !values.some((v) => v.toLowerCase() === q)) list = values.filter((v) => v.toLowerCase().includes(q));
  return list.slice(0, 20).map((v) =>
    `<button type="button" class="chip${v === normalizeText(current) ? ' on' : ''}" data-fill="${field}" data-value="${esc(v)}">${esc(v)}</button>`,
  ).join('');
}

function renderSuggestions() {
  $('#sug-book').innerHTML = chipsHtml(recentValues('book'), fBook.value, 'book');
  $('#sug-subject').innerHTML = chipsHtml(recentValues('subject'), fSubject.value, 'subject');
  const subj = normalizeText(fSubject.value);
  $('#sug-unit').innerHTML = subj ? chipsHtml(recentValues('unit', (p) => p.subject === subj), fUnit.value, 'unit') : '';
}

function updatePreview() {
  const el = $('#num-preview');
  el.classList.remove('error');
  try {
    const nums = parseNumbers(fNumber.value);
    if (nums.length > 1) {
      const shown = nums.length > 12 ? nums.slice(0, 12).join(', ') + ' …' : nums.join(', ');
      el.textContent = `→ ${shown} の ${nums.length}件をまとめて登録`;
    } else {
      el.textContent = '';
    }
  } catch (e) {
    el.textContent = e.message;
    el.classList.add('error');
  }
}

function renderRecentAdded() {
  const today = todayStr();
  const list = state.problems.filter((p) => p.createdAt === today).sort((a, b) => b.createdTs - a.createdTs);
  $('#recent-added').innerHTML = list.length
    ? `<h2 class="group">今日登録した問題（${list.length}）</h2>
       <ul class="plist compact">${list.slice(0, 30).map((p) => `
        <li><button type="button" class="pitem" data-action="detail" data-id="${esc(p.id)}">
          <div class="card-title">${titleHtml(p)}</div>
          <div class="card-sub">${subHtml(p)}</div>
        </button></li>`).join('')}</ul>`
    : '';
}

function renderAdd() {
  renderSuggestions();
  updatePreview();
  renderRecentAdded();
}

form.addEventListener('input', (e) => {
  if (e.target === fNumber) updatePreview();
  else if (e.target === fSubject) { renderSuggestions(); }
  else renderSuggestions();
});

form.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-fill]');
  if (chip) {
    const field = chip.dataset.fill;
    const value = chip.dataset.value;
    if (field === 'book') {
      fBook.value = value;
      // 問題集を選んだら、その問題集で最後に使った科目を自動で入れる
      const last = recentValues('subject', (p) => p.book === value)[0];
      if (last && normalizeText(fSubject.value) !== last) { fSubject.value = last; fUnit.value = ''; }
    } else if (field === 'subject') {
      if (normalizeText(fSubject.value) !== value) fUnit.value = '';
      fSubject.value = value;
    } else {
      fUnit.value = value;
    }
    renderSuggestions();
    return;
  }
  const key = e.target.closest('.key');
  if (key) {
    if (key.id === 'kbd-toggle') {
      const toText = fNumber.inputMode !== 'text';
      fNumber.inputMode = toText ? 'text' : 'numeric';
      key.textContent = toText ? '123' : 'あ';
      fNumber.blur();
      setTimeout(() => fNumber.focus(), 50);
    } else {
      const ins = key.dataset.ins;
      const s = fNumber.selectionStart ?? fNumber.value.length;
      const en = fNumber.selectionEnd ?? fNumber.value.length;
      fNumber.value = fNumber.value.slice(0, s) + ins + fNumber.value.slice(en);
      fNumber.focus();
      fNumber.setSelectionRange(s + ins.length, s + ins.length);
      updatePreview();
    }
  }
});

// キーボードの「次へ」で次の欄に進む
[fBook, fSubject, fUnit, fPage].forEach((el, i, arr) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      (arr[i + 1] || fNumber).focus();
    }
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const book = normalizeText(fBook.value);
  const subject = normalizeText(fSubject.value);
  const unit = normalizeText(fUnit.value);
  const page = normalizeText(fPage.value);
  const fail = (el, msg) => { toast(msg); el.focus(); el.classList.add('invalid'); setTimeout(() => el.classList.remove('invalid'), 1200); };
  if (!book) return fail(fBook, '問題集名を入力してください');
  if (!subject) return fail(fSubject, '科目を入力してください');
  if (!page) return fail(fPage, 'ページを入力してください');
  let nums;
  try { nums = parseNumbers(fNumber.value); } catch (err) { return fail(fNumber, err.message); }
  if (!nums.length) return fail(fNumber, '問題番号を入力してください');

  const today = todayStr();
  const now = Date.now();
  const active = new Set(state.problems.filter((p) => !p.graduated).map(problemKey));
  const created = [];
  const skipped = [];
  nums.forEach((number, i) => {
    const p = newProblem({ book, page, number, subject, unit }, today, now + i);
    if (active.has(problemKey(p))) skipped.push(number);
    else { active.add(problemKey(p)); created.push(p); }
  });

  if (created.length) {
    await db.putProblems(created);
    state.problems.push(...created);
  }
  fBook.value = book; fSubject.value = subject; fUnit.value = unit;
  fPage.value = '';
  fNumber.value = '';
  fPage.focus();
  db.setMeta('lastForm', { book, subject, unit });
  renderAdd();
  updateBadge();
  requestPersist();

  let msg = created.length ? `${created.length}件登録しました（初回復習は明日）` : '';
  if (skipped.length) msg += `${msg ? '／' : ''}#${skipped.join(', #')} は登録済み`;
  toast(msg, created.length ? {
    action: {
      label: '取り消し',
      fn: async () => {
        const ids = new Set(created.map((p) => p.id));
        await db.deleteProblems([...ids]);
        state.problems = state.problems.filter((p) => !ids.has(p.id));
        renderCurrent();
      },
    },
  } : {});
});

// ---------- list ----------
function renderList() {
  const today = todayStr();
  const L = state.list;
  const all = state.problems;
  const counts = {
    active: all.filter((p) => !p.graduated).length,
    graduated: all.filter((p) => p.graduated).length,
    all: all.length,
  };
  const byStatus = all.filter((p) => (L.status === 'all' ? true : L.status === 'graduated' ? p.graduated : !p.graduated));
  const subjects = recentValues('subject');
  if (L.subject && !subjects.includes(L.subject)) L.subject = '';
  const books = recentValues('book', (p) => !L.subject || p.subject === L.subject);
  if (L.book && !books.includes(L.book)) L.book = '';

  let items = byStatus.filter((p) => (!L.subject || p.subject === L.subject) && (!L.book || p.book === L.book));
  const dueKey = (p) => (p.graduated ? '9999-' + p.graduatedAt : p.dueDate);
  if (L.sort === 'due') items.sort((a, b) => (dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : byLocation(a, b)));
  else if (L.sort === 'created') items.sort((a, b) => b.createdTs - a.createdTs);
  else if (L.sort === 'location') items.sort(byLocation);
  else if (L.sort === 'ng') items.sort((a, b) => ngCount(b) - ngCount(a) || byLocation(a, b));

  const chip = (group, value, label) =>
    `<button type="button" class="chip${L[group] === value ? ' on' : ''}" data-action="list-filter" data-group="${group}" data-value="${esc(value)}">${esc(label)}</button>`;

  $('#view-list').innerHTML = `
    <div class="seg" role="tablist">
      ${[['active', '復習中'], ['graduated', '卒業'], ['all', 'すべて']].map(([v, l]) =>
        `<button type="button" class="${L.status === v ? 'on' : ''}" data-action="list-filter" data-group="status" data-value="${v}">${l} <small>${counts[v]}</small></button>`).join('')}
    </div>
    ${subjects.length > 1 ? `<div class="chips scroll">${chip('subject', '', 'すべての科目')}${subjects.map((s) => chip('subject', s, s)).join('')}</div>` : ''}
    ${books.length > 1 ? `<div class="chips scroll">${chip('book', '', 'すべての問題集')}${books.map((b) => chip('book', b, b)).join('')}</div>` : ''}
    <div class="list-head">
      <span>${items.length}件</span>
      <label class="sort">並び順
        <select data-action="list-sort">
          ${[['due', '次回復習日'], ['created', '登録が新しい順'], ['location', '問題集・ページ順'], ['ng', 'できなかった回数']].map(([v, l]) =>
            `<option value="${v}"${L.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>
    ${items.length ? `<ul class="plist">${items.map((p) => `
      <li><button type="button" class="pitem" data-action="detail" data-id="${esc(p.id)}">
        <div class="pitem-main">
          <div class="card-title">${titleHtml(p)}</div>
          <div class="card-sub">${subHtml(p)} ${ngCount(p) ? `<span class="ngc">×${ngCount(p)}</span>` : ''}</div>
        </div>
        <div class="pitem-side">${dueLabel(p, today)}${stageDots(p)}</div>
      </button></li>`).join('')}</ul>`
      : `<div class="empty"><p class="muted">${all.length ? '該当する問題はありません' : 'まだ問題が登録されていません'}</p></div>`}`;
}

// ---------- stats ----------
function renderStats() {
  const all = state.problems;
  if (!all.length) {
    $('#view-stats').innerHTML = `<div class="empty"><p class="empty-big">📊</p><p class="muted">問題を登録すると統計が表示されます</p></div>`;
    return;
  }
  const reviews = all.reduce((n, p) => n + p.history.length, 0);
  const okReviews = all.reduce((n, p) => n + p.history.filter((h) => h.result === 'ok').length, 0);

  const subj = new Map();
  for (const p of all) {
    const s = subj.get(p.subject) || { name: p.subject, total: 0, grad: 0, ng: 0, unsure: 0 };
    s.total++;
    if (p.graduated) s.grad++;
    s.ng += ngCount(p);
    s.unsure += p.history.filter((h) => h.result === 'unsure').length;
    subj.set(p.subject, s);
  }
  const subjects = [...subj.values()].sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(...subjects.map((s) => s.total));

  if (state.statsSubject && !subj.has(state.statsSubject)) state.statsSubject = '';
  const units = new Map();
  for (const p of all) {
    if (state.statsSubject && p.subject !== state.statsSubject) continue;
    const key = p.subject + '\u0000' + (p.unit || NO_UNIT);
    const u = units.get(key) || { subject: p.subject, unit: p.unit || NO_UNIT, total: 0, ng: 0, unsure: 0, active: 0 };
    u.total++;
    if (!p.graduated) u.active++;
    u.ng += ngCount(p);
    u.unsure += p.history.filter((h) => h.result === 'unsure').length;
    units.set(key, u);
  }
  const unitList = [...units.values()].sort((a, b) => b.ng - a.ng || b.unsure - a.unsure || b.total - a.total);
  const maxNg = Math.max(1, ...unitList.map((u) => u.ng));

  $('#view-stats').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${all.length}</b><span>登録</span></div>
      <div class="tile"><b>${all.filter((p) => !p.graduated).length}</b><span>復習中</span></div>
      <div class="tile"><b>${all.filter((p) => p.graduated).length}</b><span>卒業</span></div>
      <div class="tile"><b>${reviews ? Math.round((okReviews / reviews) * 100) : 0}<small>%</small></b><span>できた率</span></div>
    </div>

    <h2 class="group">科目別</h2>
    <div class="panel">
      ${subjects.map((s) => `
        <div class="bar-row">
          <div class="bar-label"><span>${esc(s.name)}</span><small>${s.total}問・卒業${s.grad}・<span class="ngc">×${s.ng}</span></small></div>
          <div class="bar"><i style="width:${(s.total / maxTotal) * 100}%"></i><i class="grad" style="width:${(s.grad / maxTotal) * 100}%"></i></div>
        </div>`).join('')}
      <p class="legend"><i class="lg-total"></i>登録数 <i class="lg-grad"></i>卒業数　×＝できなかった回数</p>
    </div>

    <h2 class="group">苦手な単元（できなかった回数順）</h2>
    ${subjects.length > 1 ? `<div class="chips scroll">
      <button type="button" class="chip${!state.statsSubject ? ' on' : ''}" data-action="stats-subject" data-value="">すべて</button>
      ${subjects.map((s) => `<button type="button" class="chip${state.statsSubject === s.name ? ' on' : ''}" data-action="stats-subject" data-value="${esc(s.name)}">${esc(s.name)}</button>`).join('')}
    </div>` : ''}
    <div class="panel">
      ${unitList.length ? unitList.slice(0, 30).map((u, i) => `
        <div class="bar-row">
          <div class="bar-label"><span><em class="rank">${i + 1}</em>${esc(u.unit)} <span class="tag">${esc(u.subject)}</span></span>
            <small><span class="ngc">×${u.ng}</span>・△${u.unsure}・${u.total}問</small></div>
          <div class="bar ng"><i style="width:${(u.ng / maxNg) * 100}%"></i></div>
        </div>`).join('') : '<p class="muted">データがありません</p>'}
      <p class="legend">×＝できなかった回数　△＝あやしい回数</p>
    </div>`;
}

// ---------- settings ----------
async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* 非対応 */ }
}

async function renderSettings() {
  const last = state.meta.lastBackup;
  const canShareFiles = (() => {
    try {
      return !!navigator.canShare?.({ files: [new File(['{}'], 'a.json', { type: 'application/json' })] });
    } catch { return false; }
  })();
  const books = recentValues('book');
  const subjects = recentValues('subject');

  $('#view-settings').innerHTML = `
    <h2 class="group">バックアップ</h2>
    <div class="panel stack">
      <p class="muted small">データはこの端末のブラウザ内だけに保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出して保存してください。</p>
      <p>最終バックアップ：<b>${last ? fmtDate(last) : 'なし'}</b>（${state.problems.length}問）</p>
      <button type="button" class="btn primary" data-action="export">JSONファイルに書き出す</button>
      ${canShareFiles ? '<button type="button" class="btn" data-action="export-share">共有で送る（ファイル・メール等）</button>' : ''}
      <button type="button" class="btn" data-action="import">JSONファイルから読み込む</button>
    </div>

    <h2 class="group">名前の変更</h2>
    <div class="panel stack">
      <p class="muted small">誤字を直したいときに。同じ名前を指定するとひとつにまとまります。</p>
      <form id="rename-form" class="stack" autocomplete="off">
        <div class="seg small" id="rename-kind">
          <button type="button" class="on" data-kind="book">問題集</button>
          <button type="button" data-kind="subject">科目</button>
          <button type="button" data-kind="unit">単元</button>
        </div>
        <select name="from" id="rename-from"></select>
        <input name="to" placeholder="新しい名前">
        <button type="submit" class="btn">変更する</button>
      </form>
    </div>

    <h2 class="group">復習のしくみ</h2>
    <div class="panel small">
      <p>登録の翌日が1回目。その後 <b>${INTERVALS.join('日 → ')}日</b> の間隔で出題します。</p>
      <ul class="rules">
        <li><b class="c-ok">○ できた</b>：次の間隔へ進む（${INTERVALS.at(-1)}日間隔で「できた」なら卒業）</li>
        <li><b class="c-unsure">△ あやしい</b>：同じ間隔をもう一度</li>
        <li><b class="c-ng">× できなかった</b>：最初（1日後）に戻る</li>
      </ul>
      <p class="muted">次回日は実際に復習した日から数えます。日付は0時で切り替わります。</p>
    </div>

    <h2 class="group">データ</h2>
    <div class="panel stack">
      <p class="small" id="persist-status"></p>
      <button type="button" class="btn danger-outline" data-action="clear-all">すべてのデータを削除</button>
    </div>
    <p class="version">問題記録 v${APP_VERSION}</p>`;

  const kindSeg = $('#rename-kind');
  const fromSel = $('#rename-from');
  let kind = 'book';
  const fillFrom = () => {
    const opts = kind === 'book' ? books.map((b) => [b, b])
      : kind === 'subject' ? subjects.map((s) => [s, s])
      : [...new Set(state.problems.filter((p) => p.unit).map((p) => p.subject + '\u0000' + p.unit))]
          .sort(collator.compare).map((k) => { const [s, u] = k.split('\u0000'); return [k, `${s} / ${u}`]; });
    fromSel.innerHTML = opts.length
      ? opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')
      : '<option value="">（まだありません）</option>';
  };
  fillFrom();
  kindSeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    kind = b.dataset.kind;
    kindSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    fillFrom();
  });
  $('#rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const from = fromSel.value;
    const to = normalizeText(e.target.to.value);
    if (!from || !to) return toast('変更前と新しい名前を指定してください');
    let match;
    if (kind === 'unit') {
      const [s, u] = from.split('\u0000');
      match = (p) => p.subject === s && p.unit === u;
    } else {
      match = (p) => p[kind] === from;
    }
    const now = Date.now();
    const changed = state.problems.filter(match).map((p) => ({ ...p, [kind]: to, updatedAt: now }));
    await db.putProblems(changed);
    changed.forEach(replaceInState);
    toast(`${changed.length}件の名前を変更しました`);
    renderSettings();
  });

  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    $('#persist-status').textContent =
      (persisted ? '✅ データ保護：有効（ブラウザが自動で消しにくい状態）' : 'ℹ️ データ保護：未設定（ホーム画面に追加して使うのがおすすめ）') +
      (est?.usage != null ? `／使用量 ${(est.usage / 1024).toFixed(0)}KB` : '');
  } catch { /* 非対応 */ }
}

function backupJson() {
  return JSON.stringify({
    app: 'mondaikiroku',
    version: 1,
    exportedAt: new Date().toISOString(),
    problems: state.problems,
  }, null, 2);
}
const backupName = () => `mondaikiroku-backup-${todayStr()}.json`;

async function markBackedUp() {
  state.meta.lastBackup = todayStr();
  await db.setMeta('lastBackup', state.meta.lastBackup);
  renderSettings();
}

async function exportDownload() {
  const blob = new Blob([backupJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  await markBackedUp();
  toast('書き出しました');
}

async function exportShare() {
  const file = new File([backupJson()], backupName(), { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: '問題記録 バックアップ' });
    await markBackedUp();
  } catch (e) {
    if (e.name !== 'AbortError') toast('共有できませんでした。「書き出す」をお試しください');
  }
}

async function importFile(file) {
  let incoming;
  try {
    incoming = parseBackup(await file.text());
  } catch (e) {
    toast(e.message);
    return;
  }
  if (!incoming.length) { toast('読み込める問題がありませんでした'); return; }
  const mode = await choose(
    `<b>${incoming.length}問</b>のデータが見つかりました。<br>現在のデータ（${state.problems.length}問）とどうしますか？`,
    [
      { label: '統合する（おすすめ）', value: 'merge', cls: 'primary' },
      { label: '上書きする（今のデータは消えます）', value: 'replace', cls: 'danger-outline' },
    ],
  );
  if (!mode) return;
  const next = mode === 'merge' ? mergeProblems(state.problems, incoming) : incoming;
  await db.replaceAllProblems(next);
  state.problems = next;
  renderCurrent();
  toast(mode === 'merge' ? `統合しました（合計${next.length}問）` : `${next.length}問を読み込みました`);
}

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await importFile(file);
});

async function clearAll() {
  const ok = await choose('すべての問題と復習の記録を削除します。<br><b>元に戻せません。</b>先にバックアップすることをおすすめします。',
    [{ label: 'すべて削除する', value: true, cls: 'danger' }]);
  if (!ok) return;
  await db.replaceAllProblems([]);
  state.problems = [];
  renderCurrent();
  toast('すべて削除しました');
}

// ---------- global click delegation ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case 'rate': return rate(id, el.dataset.result, el);
    case 'detail': return openDetail(id);
    case 'edit': return openEdit(id);
    case 'delete': return deleteOne(id);
    case 'revive': return revive(id);
    case 'close-modal': return closeModal();
    case 'list-filter':
      state.list[el.dataset.group] = el.dataset.value;
      if (el.dataset.group === 'subject') state.list.book = '';
      return renderList();
    case 'stats-subject':
      state.statsSubject = el.dataset.value;
      return renderStats();
    case 'export': return exportDownload();
    case 'export-share': return exportShare();
    case 'import': return $('#import-file').click();
    case 'clear-all': return clearAll();
    case 'install':
      if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; renderHome(); }
      return;
    case 'dismiss-install':
      state.meta.installDismissed = true;
      db.setMeta('installDismissed', true);
      return renderHome();
    case 'snooze-backup':
      state.meta.backupSnooze = addDays(todayStr(), 7);
      db.setMeta('backupSnooze', state.meta.backupSnooze);
      return renderHome();
    default:
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-action="list-sort"]')) {
    state.list.sort = e.target.value;
    renderList();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'edit-form') {
    e.preventDefault();
    saveEdit(e.target);
  }
});

// 日付が変わったら（アプリを開きっぱなしで0時を越えた等）描き直す
let lastDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayStr() !== lastDay) {
    lastDay = todayStr();
    renderCurrent();
  }
});

// ---------- boot ----------
async function boot() {
  try {
    const [problems, meta] = await Promise.all([db.getAllProblems(), db.getAllMeta()]);
    state.problems = problems || [];
    state.meta = meta || {};
  } catch (e) {
    $('#view-home').innerHTML = `<div class="empty"><p>データベースを開けませんでした。</p><p class="muted small">プライベートブラウズでは保存できない場合があります。<br>${esc(e?.message || e)}</p></div>`;
    return;
  }
  const lf = state.meta.lastForm;
  if (lf) { fBook.value = lf.book || ''; fSubject.value = lf.subject || ''; fUnit.value = lf.unit || ''; }
  showView(location.hash.slice(1) || 'home');
  if (state.problems.length) requestPersist();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
