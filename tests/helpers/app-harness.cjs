const fs = require('node:fs');
const vm = require('node:vm');

function app({ audioError = null } = {}) {
  const elements = new Map();
  const storage = new Map();
  const listeners = new Map();
  let focused = null;
  const spoken = [];
  const recordings = [];
  const synthesized = [];
  const get = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
        classList: {
          add: (...names) => names.forEach(n => classes.add(n)),
          remove: (...names) => names.forEach(n => classes.delete(n)),
          contains: n => classes.has(n), toggle() {},
        },
        setAttribute() {}, removeAttribute() {}, setCustomValidity() {}, reportValidity() {}, addEventListener() {}, focus() { focused = selector; this.onfocus?.(); },
        querySelector: () => null, querySelectorAll: () => [],
        insertAdjacentHTML(position, html) { this.innerHTML += html; },
        showModal() { this.open = true; }, close() { this.open = false; },
      });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => [], addEventListener(type, listener) { listeners.set(type, listener); } },
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
    localStorage: { setItem(k, v) { storage.set(k, v); }, getItem(k) { return storage.get(k) ?? null; } }, confirm: () => true, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../../web/app.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
  const run = code => vm.runInContext(code, context);
  get("#learnedReviewCount").value = "20";
  get("#wbReviewCount").value = "20";
  get("#favReviewCount").value = "20";
  run(`
    WORDS = [
      { word: 'apple', meaning: 'n. 苹果', phonetic: '/apple/' },
      { word: 'pear', meaning: 'n. 梨', phonetic: '/pear/' }
    ];
    BYWORD = new Map(WORDS.map(w => [w.word, w]));
    SETTINGS = { autoAddWrong: true, dailyGoal: 20 };
    STATS = { total: { seen: 0, right: 0, wrong: 0 }, daily: {} };
    Object.assign(q, { words: WORDS.slice(), pool: WORDS.slice(), mode: 'en2zh',
      choiceMode: 'en2zh', stage: 0, retryRound: 0, retryWords: [], attempts: 0 });
    QUIZ_ACTIVE = true;
    renderQuestion();
  `);
  return { run, get, spoken, recordings, synthesized, focused: () => focused, storage, listeners };
}

module.exports = { app };
