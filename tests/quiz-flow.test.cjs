const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers/app-harness.cjs');

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
  assert.equal(spoken.length, 1, 'only the focused dictation word plays automatically');
  assert.equal(get('#quizMeaning').textContent, '');
  assert.equal(get('#quizFeedback').innerHTML, '');
  assert.ok(!get('#quizOptions').innerHTML.includes('苹果'));
  assert.ok(!get('#quizOptions').innerHTML.includes('writtenHint'));
  assert.ok(get('#quizOptions').innerHTML.includes('writtenInput1'));
  await get('#writtenPlay1').onclick();
  assert.equal(spoken.at(-1), run('q.pool[1].word'));
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
  assert.ok(get('#writtenFeedback0').innerHTML.includes(run('q.pool[0].meaning')));
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
  fill(); run('submitWrittenBatch()');
  assert.equal(run('buildPool("learned").length'), 2);
  assert.equal(run('todayStats().completedWords.length'), 2);
  run('advance()');
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
      apple: { completedAt: 100, seen: 3, right: 2, wrong: 1, lastAt: 100, nextReviewAt: 1 },
      pear: { completedAt: 200, seen: 1, right: 1, wrong: 0, lastAt: 200, nextReviewAt: Date.now() + DAY_MS },
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
    WSTATS = Object.fromEntries(WORDS.map((w, i) => [w.word, { completedAt: 100, seen: 1, right: 1, wrong: 0, nextReviewAt: i + 1 }]));
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

test('exiting after one answer does not mark a word learned', () => {
  const { run, get } = app();
  assert.equal(run('buildPool("learned").length'), 0);
  run('renderLearned()');
  assert.equal(get('#learnedEmptyTitle').textContent, '还没有已学单词');
  run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
  run('backToSetup()');
  assert.equal(run('buildPool("learned").length'), 0);
  assert.equal(run('buildPool("new").length'), 2);
  assert.equal(run('todayStats().completedWords.length'), 0);
  assert.equal(run('STATS.total.seen'), 1);
});

test('both review modules honor preset, custom and all counts and reject invalid input', () => {
  for (const prefix of ['learned', 'wb']) {
    const { run, get } = app();
    run(`
      WORDS = Array.from({ length: 35 }, (_, i) => ({ word: 'word' + i, meaning: '词', phonetic: '' }));
      WSTATS = Object.fromEntries(WORDS.map(w => [w.word, { completedAt: 100, seen: 1, right: 1, wrong: 0 }]));
      BYWORD = new Map(WORDS.map(w => [w.word, w]));
      WB = WORDS.map(w => ({ word: w.word, wrong: 1 }));
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

test('completion counts unique words only after the full session passes', () => {
  const { run, get } = app();
  run('recordAnswer("Apple", true); recordAnswer("apple", false); recordAnswer("apple", true)');
  assert.equal(run('todayStats().completedWords.length'), 0);
  assert.equal(run('STATS.total.seen'), 3);
  run('recordAnswer("pear", true); q.stage = 2; q.answered = true; recordSessionCompletion()');
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  run('recordSessionCompletion(); q.completionRecorded = false; recordSessionCompletion()');
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  run('STATS = normalizeStats(JSON.parse(JSON.stringify(STATS))); WSTATS = normalizeWordStats(WSTATS); updateGoal()');
  assert.equal(get('#goalBadge').textContent, '今日 2/20 词');
  assert.equal(run('buildPool("learned").length'), 2);
  run('recordAnswer("apple", false); backToSetup()');
  assert.equal(run('buildPool("learned").length'), 2);
});

test('legacy answers are retained without inventing completion records', () => {
  const { run, get } = app();
  run(`
    STATS.daily[todayStr()] = { seen: 100, right: 90, wrong: 10, words: ["apple", "pear"] };
    WSTATS = {
      apple: { seen: 30, lastAt: Date.now() },
      pear: { seen: 20, lastAt: Date.now() },
      old: { seen: 50, lastAt: Date.now() - 2 * DAY_MS }
    };
    updateGoal();
  `);
  assert.equal(get('#goalBadge').textContent, '今日 0/20 词');
  assert.equal(run('buildPool("learned").length'), 0);
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
    q.words = [WORDS[0]]; q.stage = 2; q.answered = true; recordSessionCompletion();
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
  assert.equal(run('STATS.daily[oldDay].completedWords.length'), 1);
  run('recordAnswer("apple", true); q.completionRecorded = false; recordSessionCompletion(); refreshDailyDisplay()');
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
  assert.equal(run('STATS.total.seen'), 2);
});

test('Tab moves directly between batch inputs, with automatic dictation audio and safe submit focus', () => {
  for (const mode of ['dictation', 'spell']) {
    const { run, get, spoken, recordings, focused } = app();
    run(`q.mode = '${mode}'; q.stage = ${mode === 'dictation' ? 1 : 2}; renderQuestion()`);
    assert.equal(focused(), '#writtenInput0');
    assert.equal(get('#quizOptions').innerHTML.includes('id="writtenPlay0"'), mode === 'dictation');
    assert.equal(spoken.length, mode === 'dictation' ? 1 : 0);
    if (mode === 'dictation') assert.equal(spoken[0], 'apple');
    const tab = (selector, shiftKey = false) => {
      let prevented = false;
      get(selector).onkeydown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
      return prevented;
    };
    assert.equal(tab('#writtenInput0'), true);
    assert.equal(focused(), '#writtenInput1');
    if (mode === 'dictation') {
      assert.equal(spoken.at(-1), 'pear');
      assert.equal(recordings[0].paused, true, 'previous audio is stopped');
    }
    assert.equal(tab('#writtenInput1', true), true);
    assert.equal(focused(), '#writtenInput0');
    if (mode === 'dictation') assert.equal(spoken.at(-1), 'apple');
    assert.equal(tab('#writtenInput0', true), false, 'first input allows normal backward navigation');
    tab('#writtenInput0');
    tab('#writtenInput1');
    assert.equal(focused(), '#writtenSubmit');
    assert.equal(run('q.answered'), false);
    assert.equal(run('q.attempts'), 0);
    tab('#writtenSubmit', true);
    assert.equal(focused(), '#writtenInput1');
    if (mode === 'spell') assert.equal(spoken.length, 0, 'all spelling focus changes remain silent');
    const count = spoken.length;
    run('q.answered = true');
    get('#writtenInput0').focus();
    assert.equal(spoken.length, count, 'graded inputs do not trigger audio');
  }
});

test('graded written answers include pronunciation, meaning and all recorded parts of speech', async () => {
  for (const mode of ['dictation', 'spell']) {
    const { run, get, spoken } = app();
    run(`q.pool = [{ word: 'test', phonetic: '/test/', meaning: 'n. 测试 v. 检验' }]; q.words = q.pool.slice(); q.mode = '${mode}'; renderQuestion()`);
    get('#writtenInput0').value = mode === 'spell' ? 'test' : 'wrong';
    run('submitWrittenBatch()');
    const feedback = get('#writtenFeedback0').innerHTML;
    assert.match(feedback, /正确答案/);
    assert.match(feedback, /\/test\//);
    assert.match(feedback, /n\. 名词 \/ v\. 动词/);
    assert.match(feedback, /释义：n\. 测试 v\. 检验/);
    await get('#writtenAnswerPlay0').onclick();
    assert.equal(spoken.at(-1), 'test');
  }
  const { run } = app();
  assert.equal(run('answerPartsOfSpeech("自定义释义")'), '词库未标注');
  assert.equal(run('answerPartsOfSpeech("n. 义项一 n. 义项二")'), 'n. 名词');
});

test('exiting after choice, dictation or an incomplete spelling round never marks completion', () => {
  for (const exitStage of [0, 1, 2]) {
    const { run, get } = app();
    const choose = () => run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
    choose(); run('advance()'); choose();
    if (exitStage >= 1) {
      run('advance()');
      for (let i = 0; i < 2; i++) get(`#writtenInput${i}`).value = run(`q.pool[${i}].word`);
      run('submitWrittenBatch()');
    }
    if (exitStage === 2) {
      run('advance()');
      get('#writtenInput0').value = run('q.pool[0].word');
      get('#writtenInput1').value = 'wrong';
      run('submitWrittenBatch()');
      assert.equal(run('WB.length'), 1);
    }
    run('backToSetup()');
    assert.equal(run('buildPool("learned").length'), 0);
    assert.equal(run('buildPool("new").length'), 2);
    assert.equal(run('todayStats().completedWords.length'), 0);
    assert.equal(run('STATS.total.seen'), (exitStage + 1) * 2);
  }
});

test('favorites support multiple categories, custom categories, editing and cancellation', () => {
  const { run, get } = app();
  run('openFavorite("apple")');
  assert.equal(get('#favoriteDialog').open, true);
  assert.equal(run('FAVORITES.length'), 0, 'opening the picker does not save');
  run('closeFavorite()');
  assert.equal(run('FAVORITES.length'), 0);
  run(`
    openFavorite('apple');
    document.querySelectorAll = selector => selector === '#favoriteCategories input:checked'
      ? [{ value: '易记混' }, { value: '拼写易错' }] : [];
  `);
  get('#favoriteCustom').value = '考试重点，易记混';
  run('saveFavorite({ preventDefault() {} }); clearTimeout(toastTimer)');
  assert.equal(run('FAVORITES.length'), 1);
  assert.equal(run('FAVORITES[0].categories.join(",")'), '易记混,拼写易错,考试重点');
  assert.equal(get('#favoriteDialog').open, false);
  run('FAVORITES[0].wrong = 4; openFavorite("apple")');
  assert.match(get('#favoriteCategories').innerHTML, /value="易记混" checked/);
  assert.match(get('#favoriteCategories').innerHTML, /value="考试重点" checked/);
  run('document.querySelectorAll = () => []');
  get('#favoriteCustom').value = '听音易错';
  run('saveFavorite({ preventDefault() {} }); clearTimeout(toastTimer)');
  assert.equal(run('FAVORITES.length'), 1);
  assert.equal(run('FAVORITES[0].wrong'), 4);
  assert.equal(run('FAVORITES[0].categories.join(",")'), '听音易错');
  run('FAVORITES = normalizeWordbook(JSON.parse(JSON.stringify(FAVORITES)))');
  assert.equal(run('FAVORITES[0].categories[0]'), '听音易错');
});

test('category filters and review use only matching favorites', () => {
  const { run, get } = app();
  run(`
    FAVORITES = normalizeWordbook([
      { word: 'apple', categories: ['易记混', '拼写易错'], status: 'learning' },
      { word: 'pear', categories: ['拼写易错'], status: 'mastered' }
    ]);
    var started;
    startQuiz = (...args) => { started = args; };
  `);
  get('#favFilter').value = 'all';
  get('#favCategory').value = 'cat:易记混';
  assert.equal(run('filteredWordbook("fav").length'), 1);
  run('reviewWordbook("fav")');
  assert.equal(run('started[2]'), 1);
  assert.equal(run('started[3][0].word'), 'apple');
  get('#favCategory').value = 'cat:拼写易错';
  assert.equal(run('filteredWordbook("fav").length'), 2);
  get('#favFilter').value = 'mastered';
  assert.equal(run('filteredWordbook("fav")[0].word'), 'pear');
  get('#favSearch').value = '苹果';
  assert.equal(run('filteredWordbook("fav").length'), 0);
  run('FAVORITES = normalizeWordbook([{ word: "apple" }])');
  get('#favFilter').value = 'all';
  get('#favSearch').value = '';
  get('#favCategory').value = 'uncategorized';
  assert.equal(run('filteredWordbook("fav")[0].word'), 'apple');
  assert.equal(run('FAVORITES[0].categories.length'), 0);
});

test('mistakes and favorites are independent when adding, reviewing and removing words', () => {
  const { run, get } = app();
  run('recordQuizAnswer(WORDS[0], false)');
  assert.equal(run('WB.length'), 1);
  assert.equal(run('FAVORITES.length'), 0);
  run('openFavorite("pear")');
  get('#favoriteCustom').value = '易记混';
  run('saveFavorite({ preventDefault() {} }); clearTimeout(toastTimer)');
  assert.equal(run('WB.length'), 1);
  assert.equal(run('buildPool("favorites")[0].word'), 'pear');
  assert.equal(run('buildPool("wordbook")[0].word'), 'apple');
  run('recordQuizAnswer(WORDS[1], false)');
  assert.equal(run('WB.length'), 2);
  assert.equal(run('FAVORITES.length'), 1);
  run('removeFromWordbook("pear")');
  assert.equal(run('FAVORITES.length'), 1);
  run('removeFromWordbook("pear", "fav")');
  assert.equal(run('WB.length'), 2);
  assert.equal(run('FAVORITES.length'), 0);
});

test('backup migration splits old mixed entries and preserves separate collections on round-trip', () => {
  const { run } = app();
  run(`
    var backup = { version: 5, custom: [], wordbook: [
      { word: 'apple', wrong: 2 },
      { word: 'pear', categories: ['易记混'], wrong: 3 },
      { word: 'banana', wrong: 0 }
    ], wordstats: {}, stats: {}, settings: {} };
    var migrated = validateBackup(backup);
  `);
  assert.equal(run('migrated.wordbook.map(w => w.word).join(",")'), 'apple,pear');
  assert.equal(run('migrated.favorites.map(w => w.word).join(",")'), 'pear,banana');
  assert.equal(run('migrated.favorites[0].categories[0]'), '易记混');
  run('var restored = validateBackup({ ...migrated, version: 6 })');
  assert.equal(run('restored.favorites.length'), 2);
  assert.equal(run('restored.wordbook.length'), 2);
  assert.throws(() => run('validateBackup({ ...backup, version: 6 })'), /invalid favorites/);
});

test('restore historical learning once without counting new incomplete sessions or today progress', () => {
  const { run, get } = app();
  run(`
    WSTATS = restoreHistoricalLearning(normalizeWordStats({
      apple: { seen: 3, right: 2, wrong: 1, lastAt: Date.now() },
      pear: { seen: 3, right: 3, completedAt: 123 }
    }), 6);
    renderLearned(); updateGoal();
  `);
  assert.equal(run('buildPool("learned").length'), 2);
  assert.equal(run('WSTATS.apple.completedAt'), 0);
  assert.match(get('#learnedList').innerHTML, /历史学习记录 · 完成状态未确认/);
  assert.match(get('#learnedList').innerHTML, /已完成三轮测试/);
  assert.equal(get('#goalBadge').textContent, '今日 0/20 词');
  run(`
    WSTATS.pending = { seen: 1, wrong: 1 };
    WSTATS = restoreHistoricalLearning(normalizeWordStats(JSON.parse(JSON.stringify(WSTATS))), 7);
  `);
  assert.equal(run('WSTATS.apple.historicalLearning'), true);
  assert.equal(run('isLearnedRecord(WSTATS.pending)'), false);
  run(`
    q.words = [WORDS[0]]; q.stage = 2; q.answered = true; q.retryWords = [];
    recordSessionCompletion(); renderLearned();
  `);
  assert.equal(run('WSTATS.apple.historicalLearning'), false);
  assert.ok(run('WSTATS.apple.completedAt') > 0);
  assert.ok(!get('#learnedList').innerHTML.includes('完成状态未确认'));
  assert.equal(get('#goalBadge').textContent, '今日 1/20 词');
});

test('all learned entries render beyond 100 while filters still apply', () => {
  const { run, get } = app();
  run(`
    WORDS = Array.from({ length: 205 }, (_, i) => ({ word: 'word' + i, meaning: '释义', phonetic: '' }));
    WSTATS = Object.fromEntries(WORDS.map(w => [w.word, { seen: 3, right: 3, wrong: 0, completedAt: 1 }]));
    renderLearned();
  `);
  assert.equal((get('#learnedList').innerHTML.match(/data-learned-review=/g) || []).length, 205);
  assert.match(get('#learnedList').innerHTML, /word204/);
  assert.equal(get('#learnedCount').textContent, '共 205 个 · 当前 205 个');
  get('#learnedSearch').value = 'word204';
  run('renderLearned()');
  assert.equal((get('#learnedList').innerHTML.match(/data-learned-review=/g) || []).length, 1);
});

test('one wrong answer is kept even when collection was disabled or later marked mastered', () => {
  const { run, get } = app();
  run(`
    SETTINGS.autoAddWrong = false;
    recordQuizAnswer(WORDS[0], false);
    recordQuizAnswer(WORDS[0], true);
    recordQuizAnswer(WORDS[0], true);
    setWbStatus('apple', 'mastered');
    renderWordbook();
  `);
  assert.equal(run('WB.length'), 1);
  assert.equal(run('WB[0].wrong'), 1);
  assert.equal(run('WB[0].right'), 2);
  assert.equal(run('filteredWordbook().length'), 1);
  assert.ok(!get('#wbList').innerHTML.includes('data-wb-rm='));
  run('removeFromWordbook("apple"); reconcileMistakeBook()');
  assert.equal(run('WB.length'), 1);
  assert.equal(run('WB[0].status'), 'mastered');
  assert.equal(run('FAVORITES.length'), 0);
});

test('missing historical mistakes are restored from cumulative wrong counts without duplicates', () => {
  const { run } = app();
  run(`
    WSTATS = normalizeWordStats({ apple: { seen: 9, right: 8, wrong: 1, lastAt: 200 } });
    WB = normalizeWordbook([{ word: 'pear', wrong: 2, status: 'mastered' }]);
    reconcileMistakeBook(); reconcileMistakeBook();
  `);
  assert.equal(run('WB.length'), 2);
  assert.equal(run('WB.find(w => w.word === "apple").wrong'), 1);
  assert.equal(run('WB.find(w => w.word === "apple").right'), 8);
  assert.equal(run('WB.find(w => w.word === "pear").status'), 'mastered');
  assert.equal(run('buildPool("wordbook").length'), 2);
});

test('older backups restore uncertain history but current backups retain unfinished status', () => {
  const { run } = app();
  run(`
    var backup = { version: 6, custom: [], wordbook: [], favorites: [],
      wordstats: { apple: { seen: 1, wrong: 1 } }, stats: {}, settings: { autoAddWrong: false } };
    var older = validateBackup(backup);
    var current = validateBackup({ ...backup, version: 7 });
  `);
  assert.equal(run('older.wordstats.apple.historicalLearning'), true);
  assert.equal(run('older.settings.autoAddWrong'), true);
  assert.equal(run('current.wordstats.apple.historicalLearning'), false);
});
