const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers/app-harness.cjs');

function dataApp(t) {
  const instance = app();
  t.after(() => instance.run('clearTimeout(toastTimer); clearQuizTimer(); clearTimeout(dailyRefreshTimer)'));
  instance.run('BUILTIN = WORDS.slice()');
  return instance;
}

function addCustom(instance, word) {
  instance.get('#addWord').value = word;
  instance.get('#addPhonetic').value = '/test/';
  instance.get('#addMeaning').value = 'n. 自定义单词';
  instance.run('addCustomWord()');
}

function installFileReader(instance) {
  instance.run(`
    globalThis.FileReader = class {
      readAsText(file) { this.result = file; this.onload(); }
    };
  `);
}

test('constructor can be learned and retained in the mistake book like other custom words', t => {
  const instance = dataApp(t);
  const { run, storage } = instance;
  addCustom(instance, 'constructor');
  run('recordAnswer("constructor", false); recordAnswer("constructor", true)');

  assert.equal(run('WSTATS.constructor.seen'), 2);
  assert.equal(run('WSTATS.constructor.wrong'), 1);
  assert.equal(run('WSTATS.constructor.right'), 1);
  assert.equal(run('WB.filter(item => item.word === "constructor").length'), 1);
  assert.equal(run('WB.find(item => item.word === "constructor").wrong'), 1);
  const stored = JSON.parse(storage.get('cet6_wordstats'));
  assert.equal(Object.hasOwn(stored, 'constructor'), true);
  assert.equal(stored.constructor.seen, 2);
  run('WSTATS = normalizeWordStats(load(LS.wordstats, {})); recordAnswer("constructor", false)');
  assert.equal(run('WSTATS.constructor.wrong'), 2);
  assert.equal(run('WB.find(item => item.word === "constructor").wrong'), 2);
});

test('renaming a learned custom word migrates and deduplicates daily records', t => {
  const instance = dataApp(t);
  const { run, get, storage } = instance;
  addCustom(instance, 'appla');
  run(`
    QUIZ_ACTIVE = false;
    recordAnswer('appla', true);
    WSTATS.appla.completedAt = Date.now();
    todayStats().words = ['appla', 'applb'];
    todayStats().completedWords = ['appla', 'applb'];
    STATS.daily['2000-01-01'] = { seen: 1, right: 1, wrong: 0, words: ['appla'], completedWords: ['appla'] };
    editCustomWord('appla');
  `);
  get('#editWord').value = 'applb';
  run('saveCustomWordEdit({ preventDefault() {} })');

  assert.equal(run('WSTATS.appla'), undefined);
  assert.equal(run('WSTATS.applb.seen'), 1);
  assert.equal(run('todayStats().words.join(",")'), 'applb');
  assert.equal(run('todayStats().completedWords.join(",")'), 'applb');
  assert.equal(run('STATS.daily["2000-01-01"].words.join(",")'), 'applb');
  assert.equal(run('STATS.daily["2000-01-01"].completedWords.join(",")'), 'applb');
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  assert.deepEqual(JSON.parse(storage.get('cet6_stats')).daily['2000-01-01'].completedWords, ['applb']);

  run(`
    Object.assign(q, { words: [BYWORD.get('applb')], stage: 2, answered: true, retryWords: [], completionRecorded: false });
    recordSessionCompletion();
  `);
  assert.equal(run('todayStats().completedWords.join(",")'), 'applb', 'another review must not count a renamed word twice');
});

test('deleting a custom word clears its daily records and refreshes today progress', t => {
  const instance = dataApp(t);
  const { run, get, storage } = instance;
  addCustom(instance, 'appla');
  run(`
    QUIZ_ACTIVE = false;
    recordAnswer('appla', false);
    WSTATS.appla.completedAt = Date.now();
    FAVORITES = [{ word: 'appla', categories: ['重点复习'], right: 0, wrong: 1 }];
    todayStats().words = ['appla', 'apple'];
    todayStats().completedWords = ['appla', 'apple'];
    STATS.daily['2000-01-01'] = { seen: 1, right: 1, wrong: 0, words: ['appla'], completedWords: ['appla'] };
    updateGoal();
  `);
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  run('deleteCustomWord("appla")');

  assert.equal(run('BYWORD.has("appla")'), false);
  assert.equal(run('WSTATS.appla'), undefined);
  assert.equal(run('WB.some(item => item.word === "appla")'), false);
  assert.equal(run('FAVORITES.some(item => item.word === "appla")'), false);
  assert.equal(run('todayStats().words.join(",")'), 'apple');
  assert.equal(run('todayStats().completedWords.join(",")'), 'apple');
  assert.equal(run('STATS.daily["2000-01-01"].words.length'), 0);
  assert.equal(run('STATS.daily["2000-01-01"].completedWords.length'), 0);
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  assert.deepEqual(JSON.parse(storage.get('cet6_stats')).daily['2000-01-01'].completedWords, []);
});

test('importing a backup refreshes progress and cancels the quiz using the replaced data', async t => {
  const instance = dataApp(t);
  const { run, get, recordings, storage } = instance;
  installFileReader(instance);
  run(`
    todayStats().completedWords = ['pear'];
    updateGoal();
    Object.assign(q, { mode: 'dictation', stage: 1, answered: false });
    var backup = {
      version: DATA_VERSION, custom: [], wordbook: [], favorites: [],
      wordstats: { apple: { seen: 3, right: 3, wrong: 0, completedAt: Date.now() } },
      stats: { total: { seen: 3, right: 3, wrong: 0 }, daily: { [todayStr()]: { seen: 3, right: 3, wrong: 0, completedWords: ['apple'] } } },
      settings: { dailyGoal: 30 }
    };
  `);
  await run('speakWord("pear")');
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  run('importData({ target: { files: [JSON.stringify(backup)], value: "backup.json" } })');

  assert.equal(get('#toast').textContent, '学习数据已导入');
  assert.equal(get('#goalBadge').textContent, '今日 1/30 词');
  assert.equal(run('QUIZ_ACTIVE'), false);
  assert.equal(recordings.at(-1).paused, true);
  assert.equal(get('#studyQuiz').classList.contains('hidden'), true);
  assert.equal(get('#studyPreview').classList.contains('hidden'), true);
  assert.equal(get('#studySetup').classList.contains('hidden'), false);
  assert.equal(run('WSTATS.pear'), undefined);
  assert.equal(run('STATS.total.seen'), 3);
  assert.equal(JSON.parse(storage.get('cet6_settings')).dailyGoal, 30);
});

test('rejecting an invalid backup preserves current data and the active quiz', t => {
  const instance = dataApp(t);
  const { run, get } = instance;
  installFileReader(instance);
  run('recordAnswer("apple", false); var previousStats = JSON.stringify(STATS)');
  run('importData({ target: { files: ["{invalid"], value: "bad.json" } })');

  assert.match(get('#toast').textContent, /导入失败/);
  assert.equal(run('JSON.stringify(STATS) === previousStats'), true);
  assert.equal(run('WSTATS.apple.wrong'), 1);
  assert.equal(run('QUIZ_ACTIVE'), true);
});

test('a due same-day mistake review can recover without accelerating repeated early practice', t => {
  const { run } = dataApp(t);
  run(`
    var RealDate = Date;
    var clockTime = new RealDate(2026, 9, 22, 12).getTime();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clockTime])); }
      static now() { return clockTime; }
    };
    var finishAppleReview = (wrongList = []) => {
      for (let stage = 0; stage < 3; stage++) recordAnswer('apple', true);
      Object.assign(q, { words: [WORDS[0]], stage: 2, answered: true, retryWords: [], wrongList, completionRecorded: false });
      recordSessionCompletion();
    };
    recordAnswer('apple', false);
    finishAppleReview([WORDS[0]]);
    var mistakeReviewAt = WSTATS.apple.nextReviewAt;
  `);
  assert.equal(run('WSTATS.apple.interval'), 0);
  assert.equal(run('mistakeReviewAt - Date.now()'), 10 * 60 * 1000);

  run('clockTime += 60 * 1000; finishAppleReview()');
  assert.equal(run('WSTATS.apple.interval'), 0, 'immediate repetition must retain the short review');
  assert.equal(run('WSTATS.apple.nextReviewAt === mistakeReviewAt'), true);

  run('clockTime += 10 * 60 * 1000; finishAppleReview()');
  assert.equal(run('WSTATS.apple.interval'), 1, 'an all-correct review after the short delay starts the next interval');
  assert.equal(run('WSTATS.apple.streak'), 1);
  assert.equal(run('WSTATS.apple.nextReviewAt - Date.now()'), 24 * 60 * 60 * 1000);
  assert.equal(run('buildPool("due").some(word => word.word === "apple")'), false);

  run('var nextDayReviewAt = WSTATS.apple.nextReviewAt; clockTime += 60 * 1000; finishAppleReview()');
  assert.equal(run('WSTATS.apple.interval'), 1);
  assert.equal(run('WSTATS.apple.nextReviewAt === nextDayReviewAt'), true);
  assert.equal(run('todayStats().completedWords.length'), 1);
});

function shareStorage(instance, store) {
  instance.run(`store => {
    localStorage.setItem = (key, value) => store.set(key, value);
    localStorage.getItem = key => store.get(key) ?? null;
    localStorage.removeItem = key => store.delete(key);
    initializeStorageTracking();
  }`)(store);
}

function bindStorageEvents(instance) {
  const events = new Map();
  instance.run(`events => {
    window.addEventListener = (name, listener) => events.set(name, listener);
    window.location = { reload() { window.reloadCount = (window.reloadCount || 0) + 1; } };
  }`)(events);
  instance.get('#storageConflictDialog').addEventListener = (name, listener) => events.set(`dialog:${name}`, listener);
  instance.run('bindStorageConflictEvents()');
  return events;
}

test('a stale tab cannot overwrite another tab learning records when saving a goal', t => {
  const first = dataApp(t);
  const second = dataApp(t);
  const shared = new Map();
  shareStorage(first, shared);
  shareStorage(second, shared);
  first.run(`
    recordAnswer('apple', false);
    WSTATS.apple.completedAt = Date.now();
    todayStats().completedWords = ['apple'];
    persist();
  `);
  const latest = new Map(shared);

  second.get('#setGoal').value = '30';
  second.run('saveDailyGoal()');
  assert.deepEqual(shared, latest, 'every key must remain unchanged, including the first key in persist');
  assert.equal(second.get('#storageConflictDialog').open, true);
  assert.equal(second.run('QUIZ_ACTIVE'), false);
  assert.equal(second.run('save(LS.stats, { total: {}, daily: {} })'), false);
  assert.equal(JSON.parse(shared.get('cet6_wordstats')).apple.wrong, 1);
  assert.equal(JSON.parse(shared.get('cet6_stats')).daily[first.run('todayStr()')].completedWords[0], 'apple');

  first.run('recordAnswer("apple", true)');
  assert.equal(JSON.parse(shared.get('cet6_wordstats')).apple.seen, 2, 'the up-to-date tab may continue saving');
  assert.equal(first.get('#storageConflictDialog').open, undefined);
});

test('storage clear events stop old quizzes and require an explicit refresh', async t => {
  const instance = dataApp(t);
  const shared = new Map();
  shareStorage(instance, shared);
  instance.run('recordAnswer("apple", true); persist()');
  const events = bindStorageEvents(instance);
  await instance.run('speakWord("apple")');
  shared.clear();
  events.get('storage')({ key: null, storageArea: instance.run('localStorage') });

  assert.equal(instance.get('#storageConflictDialog').open, true);
  assert.equal(instance.run('QUIZ_ACTIVE'), false);
  assert.equal(instance.recordings.at(-1).paused, true);
  assert.equal(instance.run('save(LS.wordstats, WSTATS)'), false);
  assert.equal(shared.size, 0, 'the stale page must not restore cleared data');
  let prevented = false;
  events.get('dialog:cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(instance.run('window.reloadCount || 0'), 0);
  instance.get('#storageConflictReload').onclick();
  assert.equal(instance.run('window.reloadCount'), 1);
});

test('storage tracking ignores unrelated keys but catches external changes before reset', t => {
  const instance = dataApp(t);
  const shared = new Map();
  shareStorage(instance, shared);
  let resets = 0;
  instance.get('#resetBtn').onclick = () => { resets++; };
  const events = bindStorageEvents(instance);
  shared.set('another-app-setting', 'changed');
  events.get('storage')({ key: 'another-app-setting', storageArea: instance.run('localStorage') });
  assert.equal(instance.run('save(LS.settings, SETTINGS)'), true);
  assert.equal(instance.get('#storageConflictDialog').open, undefined);

  shared.set('cet6_stats', JSON.stringify({ total: { seen: 3, right: 3, wrong: 0 }, daily: {} }));
  const latest = new Map(shared);
  instance.get('#resetBtn').onclick();
  assert.equal(resets, 0, 'reset must also check for a missed storage event');
  assert.deepEqual(shared, latest);
  assert.equal(instance.get('#storageConflictDialog').open, true);
});

test('a storage conflict stays visible after Escape or an unexpected native dialog close', t => {
  const instance = dataApp(t);
  const shared = new Map();
  shareStorage(instance, shared);
  const events = bindStorageEvents(instance);
  let prevented = false;
  const escape = { key: 'Escape', preventDefault() { prevented = true; } };
  instance.listeners.get('keydown')(escape);
  assert.equal(prevented, false, 'normal dialogs keep their Escape behavior');

  shared.set('cet6_settings', JSON.stringify({ dailyGoal: 30 }));
  events.get('storage')({ key: 'cet6_settings', storageArea: instance.run('localStorage') });
  instance.listeners.get('keydown')(escape);
  assert.equal(prevented, true);
  const dialog = instance.get('#storageConflictDialog');
  dialog.close();
  events.get('dialog:close')();
  assert.equal(dialog.open, true, 'native close must reopen the blocking conflict notice');

  dialog.close();
  assert.equal(instance.run('save(LS.settings, SETTINGS)'), false);
  assert.equal(dialog.open, true, 'another attempted write must restore a missing notice');
  assert.equal(JSON.parse(shared.get('cet6_settings')).dailyGoal, 30);
});
