const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers/app-harness.cjs');

function fixClock(run) {
  run(`
    var RealDate = Date;
    var clockTime = new RealDate(2026, 9, 22, 12).getTime();
    Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clockTime])); }
      static now() { return clockTime; }
    };
    window.scrollTo = () => {};
  `);
}

function completeSession({ run, get }, wrongWord = null) {
  run(`startQuiz('en2zh', 'all', WORDS.length, WORDS); beginTest()`);
  let madeMistake = false;
  while (run('q.mode') === 'en2zh') {
    const makeMistake = !madeMistake && run('q.pool[q.idx].word') === wrongWord;
    run(`answer(q.options.findIndex(w => w.word ${makeMistake ? '!==' : '==='} q.pool[q.idx].word)); advance()`);
    madeMistake ||= makeMistake;
  }
  while (run('QUIZ_ACTIVE')) {
    for (let i = 0; i < run('q.pool.length'); i++) {
      get(`#writtenInput${i}`).value = run(`q.pool[${i}].word`);
    }
    run('submitWrittenBatch(); advance()');
  }
  assert.equal(run('q.completionRecorded'), true);
}

function keyboard(run, key, extra = {}) {
  const target = { tagName: 'DIV', closest: () => null, matches: () => false };
  const event = { key, target, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  run('handleQuizKeydown')(event);
  return event;
}

test('choice shortcuts ignore system shortcuts, composition, repeats and handled events', () => {
  const { run, get } = app();
  get('#view-study').classList.add('active');
  get('#studyQuiz').classList.remove('hidden');
  for (const flag of ['metaKey', 'ctrlKey', 'altKey', 'isComposing', 'repeat', 'defaultPrevented']) {
    const event = keyboard(run, 'a', { [flag]: true });
    assert.equal(run('q.answered'), false, `${flag} must not answer the question`);
    assert.equal(run('q.attempts'), 0);
    assert.equal(event.prevented, false, 'browser and editor shortcuts remain available');
  }
  keyboard(run, 'A', { shiftKey: true });
  assert.equal(run('q.answered'), true, 'ordinary uppercase option shortcuts still work');
  assert.equal(run('q.attempts'), 1);
});

test('Enter and Space keep native actions on controls while plain page shortcuts advance', () => {
  const { run, get } = app();
  get('#view-study').classList.add('active');
  get('#studyQuiz').classList.remove('hidden');
  run('answer(q.options.findIndex(w => w.word === q.pool[q.idx].word))');
  get('#quizNext').click = () => run('advance()');
  const oldIndex = run('q.idx');
  for (const tagName of ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT']) {
    const target = { tagName, closest() { return this; }, matches: () => true };
    for (const key of ['Enter', ' ']) {
      const event = keyboard(run, key, { target });
      assert.equal(run('q.idx'), oldIndex, `${tagName} ${JSON.stringify(key)} must not advance`);
      assert.equal(event.prevented, false, 'allow the control to perform its native action');
    }
  }
  const editable = { tagName: 'DIV', isContentEditable: true, closest() { return this; }, matches: () => true };
  assert.equal(keyboard(run, 'Enter', { target: editable }).prevented, false);
  assert.equal(run('q.idx'), oldIndex);
  keyboard(run, 'Enter');
  assert.equal(run('q.idx'), oldIndex + 1, 'page-level Enter advances exactly one question');
  assert.equal(run('q.answered'), false);
  assert.equal(run('q.attempts'), 1);
});

test('deleting a custom word in the active group ends the old quiz before retry can recreate it', () => {
  const { run, get } = app();
  run(`CUSTOM = WORDS.slice(); q.mode = 'spell'; q.stage = 2; renderQuestion()`);
  get('#writtenInput0').value = 'apple';
  get('#writtenInput1').value = 'wrong';
  run(`submitWrittenBatch(); deleteCustomWord('apple')`);
  assert.equal(run('QUIZ_ACTIVE'), false);
  assert.equal(get('#studyQuiz').classList.contains('hidden'), true);
  assert.equal(get('#studySetup').classList.contains('hidden'), false);
  assert.equal(run('BYWORD.has("apple")'), false);
  assert.equal(run('WSTATS.apple'), undefined);
  const seen = run('STATS.total.seen');
  assert.doesNotThrow(() => run('advance(); submitWrittenBatch()'));
  assert.equal(run('STATS.total.seen'), seen);
  assert.equal(run('WSTATS.apple'), undefined, 'stale quiz callbacks cannot restore the deleted record');
  assert.equal(run('todayStats().completedWords.length'), 0);
  run('clearTimeout(toastTimer)');
});

test('renaming a custom word in the active group preserves history and invalidates the old test', () => {
  const { run, get } = app();
  run(`CUSTOM = WORDS.slice(); recordAnswer('apple', true); editCustomWord('apple')`);
  get('#editWord').value = 'apricot';
  get('#editPhonetic').value = '/apricot/';
  get('#editMeaning').value = 'n. 杏';
  run('saveCustomWordEdit({ preventDefault() {} })');
  assert.equal(run('QUIZ_ACTIVE'), false);
  assert.equal(get('#studyQuiz').classList.contains('hidden'), true);
  assert.equal(run('BYWORD.has("apple")'), false);
  assert.equal(run('BYWORD.has("apricot")'), true);
  assert.equal(run('WSTATS.apricot.seen'), 1);
  assert.equal(run('WSTATS.apple'), undefined);
  assert.equal(run('todayStats().completedWords.length'), 0);
  run('clearTimeout(toastTimer)');
});

test('correct answers in an unfinished session do not advance an existing review date', () => {
  const { run } = app();
  fixClock(run);
  run(`WSTATS.apple = { seen: 6, right: 6, wrong: 0, streak: 2, interval: 3,
    completedAt: clockTime - DAY_MS, nextReviewAt: clockTime - 1000, lastReviewDay: '2026-10-21' }`);
  const due = run('WSTATS.apple.nextReviewAt');
  run(`recordAnswer('apple', true); recordAnswer('apple', true); backToSetup()`);
  assert.equal(run('WSTATS.apple.seen'), 8);
  assert.equal(run('WSTATS.apple.right'), 8);
  assert.equal(run('WSTATS.apple.streak'), 2);
  assert.equal(run('WSTATS.apple.interval'), 3);
  assert.equal(run('WSTATS.apple.nextReviewAt'), due);
  assert.equal(run('WSTATS.apple.lastReviewDay'), '2026-10-21');
});

test('an incorrect answer schedules a short review immediately, even if the test is abandoned', () => {
  const { run } = app();
  fixClock(run);
  run(`recordAnswer('apple', false)`);
  assert.equal(run('WSTATS.apple.nextReviewAt - clockTime'), 10 * 60 * 1000);
  const due = run('WSTATS.apple.nextReviewAt');
  run(`clockTime += 60 * 1000; recordAnswer('apple', true); backToSetup()`);
  assert.equal(run('WSTATS.apple.wrong'), 1);
  assert.equal(run('WSTATS.apple.right'), 1);
  assert.equal(run('WSTATS.apple.nextReviewAt'), due);
  assert.equal(run('todayStats().completedWords.length'), 0);
});

test('review spacing advances once per completed day and survives normalization', () => {
  const state = app();
  const { run } = state;
  fixClock(run);
  completeSession(state);
  assert.equal(run('WSTATS.apple.streak'), 1);
  assert.equal(run('WSTATS.apple.interval'), 1);
  assert.equal(run('WSTATS.apple.nextReviewAt - clockTime'), 24 * 60 * 60 * 1000);
  assert.equal(run('WSTATS.apple.lastReviewDay'), '2026-10-22');
  const firstDue = run('WSTATS.apple.nextReviewAt');
  run('clockTime += 5 * 60 * 1000; WSTATS = normalizeWordStats(JSON.parse(JSON.stringify(WSTATS)))');
  assert.equal(run('WSTATS.apple.lastReviewDay'), '2026-10-22');
  completeSession(state);
  assert.equal(run('WSTATS.apple.streak'), 1);
  assert.equal(run('WSTATS.apple.interval'), 1);
  assert.equal(run('WSTATS.apple.nextReviewAt'), firstDue, 'same-day repetition must not postpone the scheduled review');
  run('clockTime += DAY_MS');
  completeSession(state);
  assert.equal(run('WSTATS.apple.streak'), 2);
  assert.equal(run('WSTATS.apple.interval'), 3);
  assert.equal(run('WSTATS.apple.nextReviewAt - clockTime'), 3 * 24 * 60 * 60 * 1000);
  assert.equal(run('WSTATS.apple.lastReviewDay'), '2026-10-23');
});

test('a mistake keeps its short review even after successful retries and later rounds', () => {
  const state = app();
  const { run } = state;
  fixClock(run);
  completeSession(state, 'apple');
  assert.equal(run('WSTATS.apple.wrong'), 1);
  assert.equal(run('WSTATS.apple.streak'), 0);
  assert.equal(run('WSTATS.apple.interval'), 0);
  assert.equal(run('WSTATS.apple.nextReviewAt - clockTime'), 10 * 60 * 1000);
  assert.equal(run('WSTATS.pear.interval'), 1, 'the other correctly answered word has its own review interval');
  assert.equal(run('todayStats().completedWords.length'), 2);
  const due = run('WSTATS.apple.nextReviewAt');
  run('clockTime += 60 * 1000');
  completeSession(state);
  assert.equal(run('WSTATS.apple.nextReviewAt'), due, 'an immediate repeat cannot erase the short review');
});

test('media errors after playback starts fall back once to the current word', async () => {
  const { run, get, recordings, synthesized } = app();
  await run('speakWord("apple")');
  const audio = recordings.at(-1);
  const lateError = audio.onerror;
  assert.equal(typeof lateError, 'function');
  audio.error = { code: 3, message: 'MEDIA_ERR_DECODE' };
  lateError();
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].text, 'apple');
  assert.equal(audio.paused, true);
  assert.equal(audio.onerror, null, 'fallback removes the failed media listener');
  assert.match(get('#toast').textContent, /切换为系统英文语音/);
  lateError();
  assert.equal(synthesized.length, 1, 'a queued duplicate error cannot speak the word twice');
  run('clearTimeout(toastTimer)');
});

test('stopping or replacing audio ignores late errors from the previous word', async () => {
  const { run, get, recordings, synthesized } = app();
  await run('speakWord("apple")');
  const previous = recordings.at(-1);
  const lateError = previous.onerror;
  run('stopSpeech()');
  assert.equal(previous.onerror, null);
  lateError();
  assert.equal(synthesized.length, 0);
  assert.equal(get('#toast').textContent, '');
  await run('speakWord("pear")');
  lateError();
  assert.equal(synthesized.length, 0, 'the old error cannot interrupt a newer word');
  assert.equal(recordings.at(-1).paused, undefined);
  run('stopSpeech()');
});
