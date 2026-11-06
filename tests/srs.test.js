import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, diffDays, newProblem, applyReview, parseNumbers, parseBackup, mergeProblems, reviveProblem,
} from '../js/srs.js';

const base = { book: '青チャート', page: '52', number: '3', subject: '数学', unit: '二次関数' };

test('日付計算（月またぎ・うるう年）', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2026-11-06', '2026-12-06'), 30);
  assert.equal(diffDays('2026-11-06', '2026-11-04'), -2);
});

test('登録の翌日が1回目', () => {
  const p = newProblem(base, '2026-11-06');
  assert.equal(p.stage, 0);
  assert.equal(p.dueDate, '2026-11-07');
});

test('全部できた → 1,3,7,14,30日の間隔で5回目に卒業', () => {
  let p = newProblem(base, '2026-11-06');
  const expected = [3, 7, 14, 30];
  let day = p.dueDate;
  for (const gap of expected) {
    p = applyReview(p, 'ok', day);
    assert.equal(p.graduated, false);
    assert.equal(diffDays(day, p.dueDate), gap);
    day = p.dueDate;
  }
  p = applyReview(p, 'ok', day);
  assert.equal(p.graduated, true);
  assert.equal(p.graduatedAt, day);
  assert.equal(p.dueDate, null);
  assert.equal(p.history.length, 5);
});

test('あやしい → 同じ間隔をもう一度', () => {
  let p = newProblem(base, '2026-11-06');
  p = applyReview(p, 'ok', '2026-11-07'); // stage1, 3日後
  p = applyReview(p, 'unsure', '2026-11-10');
  assert.equal(p.stage, 1);
  assert.equal(p.dueDate, '2026-11-13');
});

test('できなかった → 1日後に戻る', () => {
  let p = newProblem(base, '2026-11-06');
  p = applyReview(p, 'ok', '2026-11-07');
  p = applyReview(p, 'ok', '2026-11-10');
  p = applyReview(p, 'ng', '2026-11-17');
  assert.equal(p.stage, 0);
  assert.equal(p.dueDate, '2026-11-18');
});

test('遅れて復習しても実際の復習日から数える', () => {
  let p = newProblem(base, '2026-11-06');
  p = applyReview(p, 'ok', '2026-11-12');
  assert.equal(p.dueDate, '2026-11-15');
});

test('元のオブジェクトは変更しない', () => {
  const p = newProblem(base, '2026-11-06');
  applyReview(p, 'ok', '2026-11-07');
  assert.equal(p.history.length, 0);
  assert.equal(p.stage, 0);
});

test('卒業から復習に戻す', () => {
  const p = reviveProblem({ ...newProblem(base, '2026-11-06'), graduated: true, graduatedAt: '2026-12-01', dueDate: null, stage: 4 }, '2026-12-10');
  assert.equal(p.graduated, false);
  assert.equal(p.stage, 0);
  assert.equal(p.dueDate, '2026-12-11');
});

test('問題番号の分解', () => {
  assert.deepEqual(parseNumbers('3, 5, 7-9'), ['3', '5', '7', '8', '9']);
  assert.deepEqual(parseNumbers('３、５〜６'), ['3', '5', '6']);
  assert.deepEqual(parseNumbers('例題3'), ['例題3']);
  assert.deepEqual(parseNumbers('2(1), 2(2)'), ['2(1)', '2(2)']);
  assert.deepEqual(parseNumbers('9-7, 8'), ['7', '8', '9']);
  assert.deepEqual(parseNumbers('  '), []);
  assert.throws(() => parseNumbers('1-500'));
});

test('バックアップの読み込みと統合', () => {
  const a = { ...newProblem(base, '2026-11-06', 1000), updatedAt: 1000 };
  const newer = { ...a, unit: '変更後', updatedAt: 2000 };
  const text = JSON.stringify({ app: 'mondaikiroku', problems: [newer, { bad: true }] });
  const incoming = parseBackup(text);
  assert.equal(incoming.length, 1);
  const merged = mergeProblems([a], incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].unit, '変更後');
  assert.throws(() => parseBackup('not json'));
  assert.throws(() => parseBackup('{"foo":1}'));
});
