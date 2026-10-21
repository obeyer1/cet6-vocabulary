const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function app({ audioError = null } = {}) {
  const elements = new Map();
  const spoken = [];
  const recordings = [];
  const synthesized = [];
  const get = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        textContent: '', innerHTML: '', value: '', style: {},
        classList: {
          add: (...names) => names.forEach(n => classes.add(n)),
          remove: (...names) => names.forEach(n => classes.delete(n)),
          contains: n => classes.has(n), toggle() {},
        },
        setAttribute() {}, removeAttribute() {}, focus() {},
        querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => [] },
    Audio: function() {
      recordings.push(this);
      this.pause = () => { this.paused = true; };
      this.removeAttribute = () => {};
      this.load = () => {};
      this.play = () => {
        spoken.push(new URL(this.src).searchParams.get('audio'));
        return audioError ? Promise.reject(audioError) : Promise.resolve();
      };
    },
    window: { speechSynthesis: {
      cancel() {}, speak: u => synthesized.push(u),
      getVoices: () => [
        { name: 'Chinese', lang: 'zh-CN' },
        { name: 'Samantha (Enhanced)', lang: 'en-US' },
      ],
    } },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    localStorage: { setItem() {} }, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8').replace(/init\(\);\s*$/, ''), context);
  const run = code => vm.runInContext(code, context);
  get("#learnedReviewCount").value = "20";
  get("#wbReviewCount").value = "20";
  run(`
    WORDS = [
      { word: 'apple', meaning: 'n. 苹果', phonetic: '/apple/' },
      { word: 'pear', meaning: 'n. 梨', phonetic: '/pear/' }
    ];
    SETTINGS = { autoAddWrong: true, dailyGoal: 20 };
    STATS = { total: { seen: 0, right: 0, wrong: 0 }, daily: {} };
    Object.assign(q, { words: WORDS.slice(), pool: WORDS.slice(), mode: 'en2zh',
      choiceMode: 'en2zh', stage: 0, retryRound: 0, retryWords: [], attempts: 0 });
    QUIZ_ACTIVE = true;
    renderQuestion();
  `);
  return { run, get, spoken, recordings, synthesized };
}

test('whole-batch dictation and spelling grade once and retry only mistakes', async () => {
  const { run, get, spoken } = app();
  const choose = () => run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
  const fill = (wrongIndex = -1) => {
    for (let i = 0; i < run('q.pool.length'); i++) {
      get(`#writtenInput${i}`).value = i === wrongIndex ? 'wrong' : run(`q.pool[${i}].word.toUpperCase()`);
    }
  };
  choose(); run('advance()'); choose(); run('advance()');
  assert.equal(run('q.mode'), 'dictation');
  assert.equal(run('q.pool.length'), 2);
  assert.equal(spoken.length, 0, 'no overlapping automatic playback');
  assert.equal(get('#quizMeaning').textContent, '');
  assert.equal(get('#quizFeedback').innerHTML, '');
  assert.ok(!get('#quizOptions').innerHTML.includes('苹果'));
  assert.ok(!get('#quizOptions').innerHTML.includes('writtenHint'));
  assert.ok(get('#quizOptions').innerHTML.includes('writtenInput1'));
  await get('#writtenPlay1').onclick();
  assert.equal(spoken[0], run('q.pool[1].word'));
  get('#writtenInput0').value = 'APPLE';
  get('#writtenInput1').value = '';
  run('submitWrittenBatch()');
  assert.equal(run('q.attempts'), 2, 'missing answers do not record any grades');
  assert.equal(run('q.answered'), false);
  run('clearTimeout(toastTimer)');
  fill(0);
  run('updateWrittenProgress()');
  assert.equal(get('#quizProgressText').textContent, '已填写 2 / 2 题');
  assert.equal(run('q.attempts'), 2, 'typing does not grade');
  run('submitWrittenBatch()');
  assert.equal(run('q.attempts'), 4);
  assert.equal(get('#writtenInput0').disabled, true);
  assert.match(get('#writtenFeedback0').innerHTML, /错误/);
  assert.match(get('#writtenFeedback1').innerHTML, /正确/);
  assert.ok(!get('#writtenFeedback0').innerHTML.includes(run('q.pool[0].meaning')));
  run('submitWrittenBatch()');
  assert.equal(run('q.attempts'), 4, 'double submit ignored');
  run('advance()');
  assert.equal(run('q.pool.length'), 1);
  assert.equal(run('q.mode'), 'dictation');
  fill(0); run('submitWrittenBatch(); advance()');
  assert.equal(run('q.retryRound'), 2);
  fill(); run('submitWrittenBatch(); advance()');
  assert.equal(run('q.mode'), 'spell');
  assert.equal(run('q.pool.length'), 2);
  assert.ok(get('#quizOptions').innerHTML.includes('苹果'));
  assert.ok(get('#quizOptions').innerHTML.includes('writtenHint1'));
  fill(1); run('submitWrittenBatch(); advance()');
  assert.equal(run('q.mode'), 'spell');
  assert.equal(run('q.pool.length'), 1);
  fill(); run('submitWrittenBatch(); advance()');
  assert.equal(run('QUIZ_ACTIVE'), false);
  assert.match(get('#summaryTitle').textContent, /三轮全部通过/);
  assert.equal(run('STATS.total.seen'), 9);
  assert.equal(run('STATS.total.wrong'), 3);
});

test('dictionary audio encodes words and stops playback on exit', async () => {
  const { run, recordings, synthesized } = app();
  await run('speakWord("ice cream")');
  assert.equal(recordings[0].src, 'https://dict.youdao.com/dictvoice?audio=ice%20cream&type=2');
  assert.equal(synthesized.length, 0);
  run('backToSetup()');
  assert.equal(recordings[0].paused, true);
});

test('failed audio falls back to an enhanced English voice with a notice', async () => {
  const { run, get, synthesized } = app({ audioError: new Error('offline') });
  await run('speakWord("apple")');
  assert.equal(synthesized[0].text, 'apple');
  assert.equal(synthesized[0].voice.name, 'Samantha (Enhanced)');
  assert.match(get('#toast').textContent, /切换为系统英文语音/);
  run('clearTimeout(toastTimer)');
});

test('cancelled audio cannot start fallback for an old question', async () => {
  const { run, synthesized } = app({ audioError: new Error('offline') });
  const pending = run('speakWord("apple")');
  run('stopSpeech()');
  await pending;
  assert.equal(synthesized.length, 0);
});

test('autoplay restriction asks for a click instead of starting fallback', async () => {
  const error = new Error('click required');
  error.name = 'NotAllowedError';
  const { run, get, synthesized } = app({ audioError: error });
  await run('speakWord("apple")');
  assert.equal(synthesized.length, 0);
  assert.match(get('#toast').textContent, /点击/);
  run('clearTimeout(toastTimer)');
});

test('learned words exclude unseen entries and support search, due and wrong filters', () => {
  const { run, get } = app();
  run(`
    WORDS.push({ word: 'new', meaning: 'adj. 新的', phonetic: '' });
    WSTATS = {
      apple: { seen: 3, right: 2, wrong: 1, lastAt: 100, nextReviewAt: 1 },
      pear: { seen: 1, right: 1, wrong: 0, lastAt: 200, nextReviewAt: Date.now() + DAY_MS },
      new: { seen: 0 },
      deleted: { seen: 5 }
    };
  `);
  const words = () => run('learnedWords().map(w => w.word).join(",")');
  get('#learnedSort').value = 'review';
  assert.equal(words(), 'apple,pear');
  get('#learnedSort').value = 'recent';
  assert.equal(words(), 'pear,apple');
  get('#learnedFilter').value = 'due';
  assert.equal(words(), 'apple');
  get('#learnedFilter').value = 'wrong';
  assert.equal(words(), 'apple');
  get('#learnedFilter').value = 'all';
  get('#learnedSearch').value = '梨';
  assert.equal(words(), 'pear');
  get('#learnedSearch').value = ' APP ';
  assert.equal(words(), 'apple');
  get('#learnedSearch').value = 'unknown';
  run('renderLearned()');
  assert.equal(get('#learnedReview').disabled, true);
  assert.equal(get('#learnedEmptyTitle').textContent, '没有符合条件的单词');
  get('#learnedSearch').value = '';
  run('renderLearned()');
  assert.equal(get('#learnedCount').textContent, '共 2 个 · 当前 2 个');
  assert.equal(get('#learnedReview').disabled, false);
});

test('batch review uses the first 20 filtered words in review order', () => {
  const { run, get } = app();
  run(`
    WORDS = Array.from({ length: 25 }, (_, i) => ({ word: 'word' + i, meaning: '词', phonetic: '' }));
    WSTATS = Object.fromEntries(WORDS.map((w, i) => [w.word, { seen: 1, right: 1, wrong: 0, nextReviewAt: i + 1 }]));
    var started;
    startQuiz = (...args) => { started = args; };
  `);
  get('#learnedSort').value = 'review';
  run('reviewLearned()');
  assert.equal(run('started[0]'), 'en2zh');
  assert.equal(run('started[2]'), 20);
  assert.equal(run('started[3][0].word'), 'word0');
  assert.equal(run('started[3][19].word'), 'word19');
  get('#learnedSearch').value = 'word24';
  run('reviewLearned()');
  assert.equal(run('started[2]'), 1);
  assert.equal(run('started[3][0].word'), 'word24');
});

test('first answer adds a word to learned collection without separate storage', () => {
  const { run, get } = app();
  assert.equal(run('buildPool("learned").length'), 0);
  run('renderLearned()');
  assert.equal(get('#learnedEmptyTitle').textContent, '还没有已学单词');
  run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
  assert.equal(run('buildPool("learned")[0].word'), 'apple');
  assert.equal(run('buildPool("learned").length'), 1);
});

test('both review modules honor preset, custom and all counts and reject invalid input', () => {
  for (const prefix of ['learned', 'wb']) {
    const { run, get } = app();
    run(`
      WORDS = Array.from({ length: 35 }, (_, i) => ({ word: 'word' + i, meaning: '词', phonetic: '' }));
      WSTATS = Object.fromEntries(WORDS.map(w => [w.word, { seen: 1, right: 1, wrong: 0 }]));
      WB = WORDS.map(w => ({ word: w.word }));
      var started = null;
      startQuiz = (...args) => { started = args; };
    `);
    const review = () => run(prefix === 'learned' ? 'reviewLearned()' : 'reviewWordbook()');
    for (const [selection, custom, expected] of [
      ['10', '', 10], ['30', '', 30], ['50', '', 35],
      ['custom', '7', 7], ['custom', '100', 35], ['all', '', 35],
    ]) {
      get(`#${prefix}ReviewCount`).value = selection;
      get(`#${prefix}ReviewCountCustom`).value = custom;
      review();
      assert.equal(run('started[2]'), expected);
      if (prefix === 'learned') assert.equal(run('started[3].length'), expected);
    }
    get(`#${prefix}ReviewCount`).value = 'custom';
    for (const invalid of ['', '0', '-1', '1.5', 'Infinity', 'no']) {
      get(`#${prefix}ReviewCountCustom`).value = invalid;
      run('started = null');
      review();
      assert.equal(run('started'), null);
      assert.match(get('#toast').textContent, /整数/);
      run('clearTimeout(toastTimer)');
    }
  }
});

test('return restores the actual entry page, scroll position and review controls', () => {
  for (const origin of ['study', 'learned', 'wordbook']) {
    const { run, get } = app();
    get('.tab.active').dataset = { view: origin };
    get('#learnedSearch').value = 'apple';
    get('#learnedReviewCount').value = 'custom';
    get('#learnedReviewCountCustom').value = '7';
    run(`
      var visibleView, scrollPosition;
      window.scrollY = 320;
      window.scrollTo = options => { scrollPosition = options.top; };
      showView = name => { visibleView = name; };
      startQuiz('en2zh', 'all', 1, WORDS.slice(0, 1));
    `);
    assert.equal(run('q.returnContext.view'), origin);
    assert.equal(run('visibleView'), 'study');
    run('returnToSource()');
    assert.equal(run('visibleView'), origin);
    assert.equal(run('scrollPosition'), 320);
    assert.equal(run('QUIZ_ACTIVE'), false);
    assert.equal(get('#learnedSearch').value, 'apple');
    assert.equal(get('#learnedReviewCountCustom').value, '7');
    assert.equal(get('#studyPreview').classList.contains('hidden'), true);
  }
});

test('retrying mistakes retains the original return destination', () => {
  const { run, get } = app();
  get('.tab.active').dataset = { view: 'learned' };
  run(`
    window.scrollY = 150;
    window.scrollTo = () => {};
    showView = () => {};
    startQuiz('en2zh', 'learned', 1, WORDS.slice(0, 1));
    q.wrongList = WORDS.slice(0, 1);
    q.attempts = 1;
    finishQuiz();
  `);
  get('.tab.active').dataset.view = 'study';
  get('#summaryRetry').onclick();
  assert.equal(run('q.returnContext.view'), 'learned');
  assert.equal(run('q.returnContext.scrollY'), 150);
  assert.equal(get('#previewBack').textContent, '← 返回已学单词调整');
});

test('daily word progress deduplicates repeated rounds while answer totals stay accurate', () => {
  const { run, get } = app();
  run('recordAnswer("Apple", true); recordAnswer("apple", false); recordAnswer("apple", true)');
  assert.equal(run('todayStats().words.length'), 1);
  assert.equal(run('todayStats().seen'), 3);
  assert.equal(run('STATS.total.seen'), 3);
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  run('recordAnswer("pear", true)');
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  run('STATS = normalizeStats(JSON.parse(JSON.stringify(STATS))); updateGoal()');
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
});

test('legacy daily answers migrate to unique words from today only', () => {
  const { run, get } = app();
  run(`
    STATS.daily[todayStr()] = { seen: 100, right: 90, wrong: 10 };
    WSTATS = {
      apple: { seen: 30, lastAt: Date.now() },
      pear: { seen: 20, lastAt: Date.now() },
      old: { seen: 50, lastAt: Date.now() - 2 * DAY_MS }
    };
    updateGoal();
  `);
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  assert.equal(run('todayStats().seen'), 100);
});

test('daily refresh resets after midnight and keeps previous days intact', () => {
  const { run, get } = app();
  run(`
    var RealDate = Date;
    var clockTime = new RealDate(2026, 9, 21, 23, 59, 59).getTime();
    Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clockTime])); }
      static now() { return clockTime; }
    };
    recordAnswer('apple', true);
    var oldDay = todayStr();
    var scheduledCallback, scheduledDelay;
    setTimeout = (callback, delay) => { scheduledCallback = callback; scheduledDelay = delay; return 1; };
    clearTimeout = () => {};
    scheduleDailyRefresh();
  `);
  assert.equal(run('scheduledDelay'), 1100);
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  run('clockTime += 2000; scheduledCallback()');
  assert.equal(get('#goalBadge').textContent, '今日 0/20 词');
  assert.equal(run('STATS.daily[oldDay].words.length'), 1);
  run('recordAnswer("apple", true); refreshDailyDisplay()');
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  assert.equal(run('STATS.total.seen'), 2);
});
