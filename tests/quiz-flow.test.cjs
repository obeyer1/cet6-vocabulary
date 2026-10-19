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

test('choice → dictation with repeated wrong-word retries → spelling → summary', () => {
  const { run, get, spoken } = app();
  const choose = () => run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
  const write = (correct) => {
    get('#spellInput').value = correct ? run('q.pool[q.idx].word.toUpperCase()') : 'wrong';
    run('submitSpell()');
  };
  choose(); run('advance()'); choose();
  assert.equal(get('#quizNext').textContent, '进入听写测试 →');
  run('advance()');
  assert.equal(run('q.mode'), 'dictation');
  assert.equal(run('q.pool.length'), 2);
  assert.equal(get('#quizWord').textContent, '听读音，写单词');
  assert.equal(get('#quizPhonetic').textContent, '');
  assert.equal(get('#quizMeaning').textContent, '');
  assert.equal(get('#quizFeedback').innerHTML, '');
  assert.ok(!get('#quizOptions').innerHTML.includes('spellHint'));
  assert.equal(spoken.at(-1), run('q.pool[0].word'));
  get('#quizSpeak').onclick();
  assert.equal(spoken.length, 2);
  write(false);
  assert.ok(get('#quizFeedback').innerHTML.includes('你输入的是「wrong」'));
  assert.ok(!get('#quizFeedback').innerHTML.includes(run('q.pool[q.idx].meaning')));
  run('submitSpell()');
  assert.equal(run('q.attempts'), 3, 'double submission is ignored');
  run('advance()');
  assert.equal(get('#quizFeedback').innerHTML, '');
  write(true);
  assert.ok(!get('#quizFeedback').innerHTML.includes(run('q.pool[q.idx].meaning')));
  assert.equal(get('#quizNext').textContent, '继续补测错词 →');
  run('advance()');
  assert.equal(run('q.pool.length'), 1);
  assert.equal(run('q.mode'), 'dictation');
  write(false); run('advance()');
  assert.equal(run('q.retryRound'), 2);
  write(true);
  assert.equal(get('#quizNext').textContent, '进入拼写测试 →');
  run('advance()');
  assert.equal(run('q.mode'), 'spell');
  assert.equal(run('q.pool.length'), 2);
  assert.equal(run('q.retryRound'), 0);
  assert.equal(get('#quizWord').textContent, run('q.pool[0].meaning'));
  assert.ok(get('#quizOptions').innerHTML.includes('spellHint'));
  write(true); run('advance()'); write(true); run('advance()');
  assert.equal(run('QUIZ_ACTIVE'), false);
  assert.match(get('#summaryTitle').textContent, /三轮全部通过/);
  assert.equal(run('STATS.total.seen'), 8);
  assert.equal(run('STATS.total.wrong'), 2);
  assert.equal(run('WB.length'), 1);
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
