const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers/app-harness.cjs');

test('custom quiz counts require a positive safe integer rather than rounding silently', () => {
  const { run, get } = app();
  get('#quizCount').value = 'custom';
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
    get('#quizCountCustom').value = value;
    assert.equal(run('resolveQuizCount()'), null, value);
  }
  get('#quizCountCustom').value = '3';
  assert.equal(run('resolveQuizCount()'), 3);
  get('#quizCount').value = '20';
  assert.equal(run('resolveQuizCount()'), 20);
});

test('invalid daily goals keep the saved goal and valid goals survive a reload', t => {
  const { run, get, storage } = app();
  t.after(() => run('clearTimeout(toastTimer)'));
  run('persist()');
  const saved = storage.get('cet6_settings');
  for (const value of ['', '0', '4', '501', '20.5', 'Infinity']) {
    get('#setGoal').value = value;
    run('saveDailyGoal()');
    assert.equal(run('SETTINGS.dailyGoal'), 20, value);
    assert.equal(storage.get('cet6_settings'), saved);
    assert.match(get('#toast').textContent, /整数/);
  }
  get('#setGoal').value = '37';
  run('saveDailyGoal(); SETTINGS = normalizeSettings(load(LS.settings, null)); updateGoal()');
  assert.equal(run('SETTINGS.dailyGoal'), 37);
  assert.equal(get('#goalBadge').textContent, '今日 0/37 词');
});
