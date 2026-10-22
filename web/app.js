/* =========================================================
 * 六级背单词 App - 前端逻辑（无任何第三方依赖）
 * ========================================================= */
"use strict";

/* ---------- 存储 ---------- */
const LS = {
  custom: "cet6_custom_words",
  wordbook: "cet6_wordbook",
  favorites: "cet6_favorites",
  wordstats: "cet6_wordstats",
  stats: "cet6_stats",
  settings: "cet6_settings",
  version: "cet6_data_version",
};
const DATA_VERSION = 7;
const FAVORITE_CATEGORIES = ["易记混", "拼写易错", "听音易错", "重点复习"];
let favoriteWord = null;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];
const QUIZ_STAGES = ["选择", "听写", "拼写"];
const isWrittenMode = () => q.mode === "spell" || q.mode === "dictation";
let wordAudio = null;
let speechRequest = 0;
function stopSpeech() {
  speechRequest++;
  if (wordAudio) {
    wordAudio.onerror = null;
    wordAudio.pause();
    wordAudio.removeAttribute("src");
    wordAudio.load();
    wordAudio = null;
  }
  window.speechSynthesis?.cancel();
}

const load = (k, def) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v == null ? def : v;
  } catch (e) { return def; }
};
let storageBaseline = null;
let storageConflict = false;

function initializeStorageTracking() {
  storageBaseline = new Map(Object.values(LS).map(key => [key, localStorage.getItem(key)]));
  storageConflict = false;
}

function showStorageConflictDialog() {
  const dialog = $("#storageConflictDialog");
  if (!dialog.open) dialog.showModal();
}

function checkStorageBaseline() {
  if (storageConflict) {
    showStorageConflictDialog();
    return false;
  }
  if (!storageBaseline) return true;
  const changed = [...storageBaseline].some(([key, value]) => localStorage.getItem(key) !== value);
  if (!changed) return true;
  storageConflict = true;
  QUIZ_ACTIVE = false;
  clearQuizTimer();
  stopSpeech();
  showStorageConflictDialog();
  return false;
}

const save = (k, v) => {
  if (!checkStorageBaseline()) return false;
  const value = JSON.stringify(v);
  localStorage.setItem(k, value);
  if (storageBaseline?.has(k)) storageBaseline.set(k, value);
  return true;
};

function bindStorageConflictEvents() {
  window.addEventListener("storage", event => {
    if (event.storageArea !== localStorage) return;
    if (event.key === null || Object.values(LS).includes(event.key)) checkStorageBaseline();
  });
  $("#storageConflictDialog").addEventListener("cancel", event => event.preventDefault());
  $("#storageConflictDialog").addEventListener("close", () => {
    if (storageConflict) showStorageConflictDialog();
  });
  document.addEventListener("keydown", event => {
    if (storageConflict && event.key === "Escape") {
      event.preventDefault();
      showStorageConflictDialog();
    }
  }, true);
  $("#storageConflictForm").onsubmit = event => event.preventDefault();
  $("#storageConflictReload").onclick = () => window.location.reload();
  const reset = $("#resetBtn");
  const resetData = reset.onclick;
  reset.onclick = event => { if (checkStorageBaseline()) resetData?.(event); };
}

/* ---------- 全局状态 ---------- */
let WORDS = [];            // 全部单词（内置 + 自定义）
let BYWORD = new Map();    // word -> entry
let BUILTIN = [];          // 内置词库
let CUSTOM = [];           // 自定义单词
let FAVORITES = [];
let WB = [];               // 错题本 [{word, addedAt, status, wrong, right, lastAt}]
let WSTATS = Object.create(null); // { word: {seen, right, wrong} }
let STATS = null;          // { total: {seen,right,wrong}, daily: {date: {...}} }
let SETTINGS = null;       // { dailyGoal, autoAddWrong }

const q = { mode: null, pool: [], idx: 0, correct: 0, wrongList: [], options: [], answered: false };
let QUIZ_ACTIVE = false;
let quizTimer = null;      // 卡片模式自动跳题定时器
let toastTimer = null;
let editingWordKey = null;

function clearQuizTimer() {
  if (quizTimer) { clearTimeout(quizTimer); quizTimer = null; }
}

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateKey(new Date());
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const nonNegativeInt = (value) => Math.max(0, Math.floor(finiteNumber(value)));
const wordKey = (word) => String(word || "").trim().toLowerCase();

function notify(message, type = "info") {
  const toast = $("#toast");
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const word = String(entry.word || "").trim();
  const meaning = String(entry.meaning || "").trim();
  if (!/^[A-Za-z][A-Za-z'\- ]*$/.test(word) || !meaning) return null;
  return { word, phonetic: String(entry.phonetic || "").trim(), meaning };
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return [...new Set(categories.filter(value => typeof value === "string").map(value => value.trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
}

function favoriteButton(entry) {
  const saved = FAVORITES.some(item => item.word === wordKey(entry.word));
  return `<button type="button" class="mini-btn" data-favorite="${esc(wordKey(entry.word))}">${saved ? "★ 收藏分类" : "☆ 收藏"}</button>`;
}

function favoriteCategories() {
  return [...new Set([...FAVORITE_CATEGORIES, ...FAVORITES.flatMap(item => item.categories || [])])];
}

function openFavorite(word) {
  const entry = BYWORD.get(wordKey(word));
  if (!entry) return;
  favoriteWord = wordKey(word);
  const selected = FAVORITES.find(item => item.word === favoriteWord)?.categories || [];
  $("#favoriteTitle").textContent = `收藏 · ${entry.word}`;
  $("#favoriteCategories").innerHTML = favoriteCategories().map(category => `<label class="favorite-category"><input type="checkbox" value="${esc(category)}" ${selected.includes(category) ? "checked" : ""}>${esc(category)}</label>`).join("");
  $("#favoriteCustom").value = "";
  $("#favoriteDialog").showModal();
}

function closeFavorite() {
  favoriteWord = null;
  $("#favoriteDialog").close();
}

function saveFavorite(event) {
  event.preventDefault();
  const entry = BYWORD.get(favoriteWord);
  if (!entry) { closeFavorite(); return; }
  const selected = $$("#favoriteCategories input:checked").map(input => input.value);
  const custom = $("#favoriteCustom").value.split(/[,，、\n]/);
  if (!FAVORITES.some(item => item.word === wordKey(entry.word))) FAVORITES.push({ word: wordKey(entry.word), categories: [], status: "learning", addedAt: Date.now(), lastAt: Date.now(), right: 0, wrong: 0 });
  const item = FAVORITES.find(item => item.word === favoriteWord);
  item.categories = normalizeCategories([...selected, ...custom]);
  save(LS.favorites, FAVORITES);
  closeFavorite();
  const view = $(".tab.active")?.dataset.view;
  if (view === "wordbook") renderWordbook();
  if (view === "favorites") renderWordbook("fav");
  if (view === "glossary") renderGlossary();
  if (view === "learned") renderLearned();
  $$("[data-favorite]").filter(button => button.dataset.favorite === wordKey(entry.word)).forEach(button => { button.textContent = "★ 收藏分类"; });
  notify(`已收藏 ${entry.word}${item.categories.length ? ` · ${item.categories.join("、")}` : " · 未分类"}`);
}

function normalizeWordbook(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const word = wordKey(item.word);
    if (!word || seen.has(word)) return [];
    seen.add(word);
    return [{
      word,
      addedAt: nonNegativeInt(item.addedAt) || Date.now(),
      status: item.status === "mastered" ? "mastered" : "learning",
      categories: normalizeCategories(item.categories),
      wrong: nonNegativeInt(item.wrong),
      right: nonNegativeInt(item.right),
      lastAt: nonNegativeInt(item.lastAt) || Date.now(),
    }];
  });
}

function normalizeWordStats(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawWord, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const word = wordKey(rawWord);
    if (!word) continue;
    result[word] = {
      seen: nonNegativeInt(raw.seen),
      right: nonNegativeInt(raw.right),
      wrong: nonNegativeInt(raw.wrong),
      streak: nonNegativeInt(raw.streak),
      interval: nonNegativeInt(raw.interval),
      nextReviewAt: nonNegativeInt(raw.nextReviewAt),
      lastAt: nonNegativeInt(raw.lastAt),
      completedAt: nonNegativeInt(raw.completedAt),
      historicalLearning: raw.historicalLearning === true,
      lastReviewDay: /^\d{4}-\d{2}-\d{2}$/.test(raw.lastReviewDay || "") ? raw.lastReviewDay : "",
    };
  }
  return result;
}

function restoreHistoricalLearning(stats, version) {
  if (version >= 7) return stats;
  for (const item of Object.values(stats)) {
    if (item.seen > 0 && !item.completedAt) item.historicalLearning = true;
  }
  return stats;
}

const isLearnedRecord = (stats) => !!stats && (stats.completedAt > 0 || stats.historicalLearning === true);

function normalizeStats(value) {
  const result = { total: { seen: 0, right: 0, wrong: 0 }, daily: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const total = value.total && typeof value.total === "object" ? value.total : {};
  result.total = { seen: nonNegativeInt(total.seen), right: nonNegativeInt(total.right), wrong: nonNegativeInt(total.wrong) };
  if (value.daily && typeof value.daily === "object" && !Array.isArray(value.daily)) {
    for (const [date, raw] of Object.entries(value.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !raw || typeof raw !== "object") continue;
      result.daily[date] = { seen: nonNegativeInt(raw.seen), right: nonNegativeInt(raw.right), wrong: nonNegativeInt(raw.wrong) };
      if (Array.isArray(raw.completedWords)) result.daily[date].completedWords = [...new Set(raw.completedWords.filter((word) => typeof word === "string").map(wordKey).filter(Boolean))];
      if (Array.isArray(raw.words)) result.daily[date].words = [...new Set(raw.words.filter((word) => typeof word === "string").map(wordKey).filter(Boolean))];
    }
  }
  return result;
}

function normalizeSettings(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    dailyGoal: Math.max(5, Math.min(500, nonNegativeInt(raw.dailyGoal) || 20)),
    autoAddWrong: true,
  };
}

function rebuildWords() {
  const builtinKeys = new Set(BUILTIN.map((entry) => wordKey(entry.word)));
  const seen = new Set();
  CUSTOM = CUSTOM.flatMap((raw) => {
    const entry = normalizeEntry(raw);
    const key = entry && wordKey(entry.word);
    if (!entry || builtinKeys.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [entry];
  });
  WORDS = BUILTIN.concat(CUSTOM);
  BYWORD = new Map(WORDS.map((entry) => [wordKey(entry.word), entry]));
}

function todayStats() {
  const key = todayStr();
  if (!STATS.daily[key]) STATS.daily[key] = { seen: 0, right: 0, wrong: 0, words: [] };
  const daily = STATS.daily[key];
  // Legacy answer counts are retained, but cannot prove a full session was completed.
  if (!Array.isArray(daily.completedWords)) daily.completedWords = [];
  return daily;
}
function recordAnswer(word, ok) {
  word = wordKey(word);
  const ws = Object.hasOwn(WSTATS, word) ? WSTATS[word] : (WSTATS[word] = { seen: 0, right: 0, wrong: 0, streak: 0, interval: 0, nextReviewAt: 0, lastAt: 0 });
  ws.seen++; ok ? ws.right++ : ws.wrong++;
  ws.lastAt = Date.now();
  if (!ok) {
    ws.streak = 0;
    ws.interval = 0;
    ws.nextReviewAt = ws.lastAt + 10 * 60 * 1000;
  }
  STATS.total.seen++; ok ? STATS.total.right++ : STATS.total.wrong++;
  const t = todayStats(); t.seen++; ok ? t.right++ : t.wrong++;

  syncMistakeRecord(word);
  const favorite = FAVORITES.find(item => item.word === word);
  if (favorite) { favorite.right += ok ? 1 : 0; favorite.wrong += ok ? 0 : 1; favorite.lastAt = Date.now(); }
  save(LS.favorites, FAVORITES);
  save(LS.wordbook, WB);
  save(LS.wordstats, WSTATS);
  save(LS.stats, STATS);
  updateGoal();
}

/* ---------- 初始化 ---------- */
async function init() {
  initializeStorageTracking();
  const storedCustom = load(LS.custom, []);
  WB = normalizeWordbook(load(LS.wordbook, []));
  const storedFavorites = load(LS.favorites, null);
  FAVORITES = storedFavorites === null ? WB.filter(item => item.categories.length || !item.wrong).map(item => ({ ...item, categories: item.categories.slice() })) : normalizeWordbook(storedFavorites);
  if (storedFavorites === null) WB = WB.filter(item => item.wrong > 0);
  WSTATS = restoreHistoricalLearning(normalizeWordStats(load(LS.wordstats, {})), nonNegativeInt(load(LS.version, 0)));
  STATS = normalizeStats(load(LS.stats, null));
  SETTINGS = normalizeSettings(load(LS.settings, null));

  let builtin = [];
  try {
    const res = await fetch("/data/words.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    builtin = await res.json();
  } catch (e) {
    showFatal("无法加载词库。请通过「启动背单词.command」启动本应用（而不是直接双击 index.html）。");
    return;
  }
  BUILTIN = Array.isArray(builtin) ? builtin.map(normalizeEntry).filter(Boolean) : [];
  if (!BUILTIN.length) { showFatal("词库内容为空或格式不正确。"); return; }
  CUSTOM = Array.isArray(storedCustom) ? storedCustom : [];
  rebuildWords();
  reconcileMistakeBook();
  persist();
  bindEvents();
  renderGoal();
  setupDailyRefresh();
  showView("study");
}

function showFatal(msg) {
  document.body.innerHTML = `<div class="fatal-state"><span>!</span><h2>暂时无法启动</h2><p>${esc(msg)}</p></div>`;
}

/* ---------- 导航 ---------- */
function showView(name) {
  const previous = $(".tab.active")?.dataset.view;
  if (name !== "study") { clearQuizTimer(); stopSpeech(); }
  $$(".tab").forEach((t) => {
    const active = t.dataset.view === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-current", active ? "page" : "false");
  });
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "wordbook") renderWordbook();
  if (name === "favorites") renderWordbook("fav");
  if (name === "learned") renderLearned();
  if (name === "glossary") renderGlossary();
  if (name === "stats") renderStats();
  if (name === "settings") renderSettings();
  if (name === "study" && QUIZ_ACTIVE && q.mode === "card" && q.answered) scheduleCardAdvance();
  if (previous && previous !== name) window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- 学习 ---------- */
function buildPool(scope) {
  let pool = WORDS.slice();
  if (scope === "due") {
    const now = Date.now();
    pool = pool.filter((w) => {
      const stats = WSTATS[wordKey(w.word)];
      return stats && stats.seen > 0 && (!stats.nextReviewAt || stats.nextReviewAt <= now);
    });
    pool.sort((a, b) => {
      const sa = WSTATS[wordKey(a.word)];
      const sb = WSTATS[wordKey(b.word)];
      return (sb.wrong - sb.right) - (sa.wrong - sa.right) || sa.nextReviewAt - sb.nextReviewAt;
    });
  }
  if (scope === "learned") pool = pool.filter((w) => isLearnedRecord(WSTATS[wordKey(w.word)]));
  if (scope === "new") pool = pool.filter((w) => !WSTATS[wordKey(w.word)]?.completedAt);
  if (scope === "wrong") pool = pool.filter((w) => { const s = WSTATS[w.word.toLowerCase()]; return s && s.wrong > 0; });
  if (scope === "wordbook") reconcileMistakeBook();
  if (scope === "wordbook" || scope === "favorites") {
    const set = new Set((scope === "favorites" ? FAVORITES : WB).map((x) => x.word.toLowerCase()));
    pool = pool.filter((w) => set.has(w.word.toLowerCase()));
  }
  return pool;
}

function startQuiz(mode, scope, count, explicitPool, returnContext) {
  clearQuizTimer();
  const source = explicitPool ? explicitPool.slice() : buildPool(scope);
  const pool = scope === "due" && !explicitPool ? source : shuffle(source);
  if (pool.length === 0) {
    notify(scope === "due" ? "今天暂时没有到期单词，可以先学习一些新词～" : "当前范围没有可学习的单词，换个范围试试～", "error");
    return;
  }
  const n = Math.min(Math.floor(count), pool.length);
  if (!Number.isFinite(n) || n < 1) { notify("题目数量不正确，请重新选择。", "error"); return; }
  q.returnContext = returnContext || {
    view: $(".tab.active")?.dataset.view || "study",
    scrollY: window.scrollY || 0,
  };
  Object.assign(q, { mode, pool: pool.slice(0, n), idx: 0, correct: 0, wrongList: [], options: [], answered: false });
  Object.assign(q, { words: q.pool.slice(), choiceMode: mode === "zh2en" ? "zh2en" : "en2zh", stage: 0, retryRound: 0, retryWords: [], attempts: 0, completionRecorded: false });
  QUIZ_ACTIVE = false;
  showView("study");
  $("#studySetup").classList.add("hidden");
  $("#studySummary").classList.add("hidden");
  $("#studyQuiz").classList.add("hidden");
  $("#studyPreview").classList.remove("hidden");
  const returnLabel = q.returnContext.view === "learned" ? "已学单词" : q.returnContext.view === "wordbook" ? "错题本" : q.returnContext.view === "favorites" ? "收藏" : "学习设置";
  $("#previewBack").textContent = `← 返回${returnLabel}调整`;
  $("#quizBack").textContent = `← 返回${returnLabel}`;
  $("#summaryHome").textContent = `返回${returnLabel}`;
  $("#previewCount").textContent = `本轮 ${n} 个单词`;
  $("#previewList").innerHTML = q.pool.map((w, index) => `
    <div class="preview-word">
      <span class="preview-number">${String(index + 1).padStart(2, "0")}</span>
      <div class="item-main"><div class="item-word">${esc(w.word)}</div>
        <div class="preview-phonetic">${esc(w.phonetic || "")}</div>
        <div class="preview-meaning">${esc(w.meaning)}</div></div>
      ${favoriteButton(w)}
      <button type="button" class="mini-btn" data-preview-speak="${index}" aria-label="朗读 ${esc(w.word)}">🔊</button>
    </div>`).join("");
  $("#previewList").querySelectorAll("[data-preview-speak]").forEach((button) => {
    button.onclick = () => speakWord(q.pool[Number(button.dataset.previewSpeak)].word);
  });
  $("#previewTitle").focus();
  window.scrollTo({ top: 0 });
}

function beginTest() {
  if (QUIZ_ACTIVE || !q.pool.length || $("#studyPreview").classList.contains("hidden")) return;
  // 只打乱已预习单词的顺序，不重新抽词。
  q.pool = shuffle(q.words);
  q.mode = q.choiceMode;
  QUIZ_ACTIVE = true;
  $("#studyPreview").classList.add("hidden");
  $("#studyQuiz").classList.remove("hidden");
  renderQuestion();
  $("#quizWord").setAttribute("tabindex", "-1");
  if (q.mode !== "spell") $("#quizWord").focus();
  window.scrollTo({ top: 0 });
}

function renderQuestion() {
  stopSpeech();
  const w = q.pool[q.idx];
  q.answered = false;
  q.options = [];
  $("#quizNext").classList.add("hidden");
  $("#quizFeedback").classList.add("hidden");
  $("#quizFeedback").className = "feedback hidden";
  $("#quizFeedback").innerHTML = "";
  $("#quizMeaning").classList.add("hidden");
  $("#quizProgressText").textContent = `第 ${q.idx + 1} / ${q.pool.length} 题`;
  $("#quizStage").textContent = `${`第 ${q.stage + 1} 阶段 · ${QUIZ_STAGES[q.stage]}`}${q.retryRound ? ` · 错词补测 ${q.retryRound}` : " · 全组测试"}`;
  $("#quizProgressBar").style.width = `${((q.idx + 1) / q.pool.length) * 100}%`;
  $("#quizProgress").setAttribute("aria-valuemax", String(q.pool.length));
  $("#quizProgress").setAttribute("aria-valuenow", String(q.idx + 1));

  const card = $("#quizCard");
  card.classList.remove("revealed");
  card.onclick = null;
  card.onkeydown = null;
  card.removeAttribute("role");
  card.removeAttribute("aria-label");
  card.tabIndex = -1;
  const speak = $("#quizSpeak");
  speak.classList.add("hidden");
  speak.onclick = null;
  speak.textContent = "🔊";

  card.classList.toggle("hidden", isWrittenMode());
  if (isWrittenMode()) {
    renderWrittenBatch();
    return;
  }

  if (q.mode === "card") {
    $("#quizWord").textContent = w.word;
    $("#quizPhonetic").textContent = w.phonetic;
    $("#quizMeaning").textContent = w.meaning;
    const reveal = () => { $("#quizMeaning").classList.remove("hidden"); card.classList.add("revealed"); };
    card.onclick = reveal;
    card.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); reveal(); }
    };
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "翻开卡片查看释义");
    speak.classList.remove("hidden");
    speak.onclick = (event) => { event.stopPropagation(); speakWord(w.word); };
    const opts = $("#quizOptions");
    opts.innerHTML = `
      <div class="options" style="grid-template-columns:1fr 1fr;margin-top:0">
        <button class="option" data-card="no">😰 不认识</button>
        <button class="option" data-card="ok">😎 认识</button>
      </div>`;
    opts.querySelectorAll("[data-card]").forEach((b) => (b.onclick = () => answerCard(b.dataset.card === "ok")));
    return;
  }

  const isEn2Zh = q.mode === "en2zh";
  if (isEn2Zh) {
    $("#quizWord").textContent = w.word;
    $("#quizPhonetic").textContent = w.phonetic;
    q.options = buildOptions(w, "meaning");
    speak.classList.remove("hidden");
    speak.onclick = () => speakWord(w.word);
  } else {
    $("#quizWord").textContent = w.meaning;
    $("#quizPhonetic").textContent = "";
    q.options = buildOptions(w, "word");
  }
  renderOptions();
}

function buildOptions(correctEntry, type) {
  const opts = [correctEntry];
  const targetPos = partOfSpeech(correctEntry.meaning);
  const targetWord = wordKey(correctEntry.word);
  const candidates = WORDS
    .filter((entry) => wordKey(entry.word) !== targetWord)
    .map((entry) => {
      const candidateWord = wordKey(entry.word);
      let score = Math.max(0, 5 - Math.abs(candidateWord.length - targetWord.length));
      if (targetPos && partOfSpeech(entry.meaning) === targetPos) score += 6;
      if (candidateWord[0] === targetWord[0]) score += 2;
      score += commonPrefixLength(candidateWord, targetWord);
      return { entry, score: score + Math.random() * 2 };
    })
    .sort((a, b) => b.score - a.score);
  for (const { entry } of candidates) {
    const value = type === "meaning" ? entry.meaning.trim().toLowerCase() : wordKey(entry.word);
    if (!opts.some((item) => (type === "meaning" ? item.meaning.trim().toLowerCase() : wordKey(item.word)) === value)) opts.push(entry);
    if (opts.length === 4) break;
  }
  return shuffle(opts);
}

function partOfSpeech(meaning) {
  const match = String(meaning || "").trim().match(/^(n|v|vt|vi|adj|adv|prep|conj|pron|num|int)\./i);
  return match ? match[1].toLowerCase() : "";
}

function commonPrefixLength(a, b) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

async function speakWord(word) {
  stopSpeech();
  const request = speechRequest;
  const audio = new Audio();
  wordAudio = audio;
  // Loading failures must not leave a listening question silently stuck.
  let timeout;
  const handleFailure = (error) => {
    if (request !== speechRequest) return;
    clearTimeout(timeout);
    stopSpeech();
    if (error?.name === "NotAllowedError") {
      notify("请点击「播放读音」开始播放。", "error");
      return;
    }
    notify("词典音频暂时不可用，已切换为系统英文语音。", "error");
    speakSystemWord(word);
  };
  // play() resolves when playback starts; decode/network errors can arrive later.
  audio.onerror = () => handleFailure(audio.error);
  audio.src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
  try {
    await Promise.race([
      audio.play(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("audio timeout")), 8000); }),
    ]);
  } catch (error) {
    handleFailure(error);
  } finally {
    clearTimeout(timeout);
  }
}

function speakSystemWord(word) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    notify("当前浏览器不支持语音朗读。", "error");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(word));
  utterance.lang = "en-US";
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((voice) => /^en[-_]/i.test(voice.lang));
  const score = (voice) => (/natural|premium|enhanced|neural/i.test(voice.name) ? 20 : 0)
    + (/samantha|ava|google us english/i.test(voice.name) ? 10 : 0)
    + (/^en[-_]US$/i.test(voice.lang) ? 5 : 0);
  const voice = english.sort((a, b) => score(b) - score(a))[0];
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  utterance.rate = 0.9;
  utterance.onerror = (event) => {
    if (event.error !== "canceled" && event.error !== "interrupted") {
      notify("读音播放失败，请点击朗读按钮重试，并检查浏览器语音设置。", "error");
    }
  };
  window.speechSynthesis.speak(utterance);
}

function renderOptions() {
  const box = $("#quizOptions");
  const showMeaning = q.mode === "en2zh";
  box.innerHTML = q.options
    .map((o, i) => `<button class="option" data-i="${i}"><span class="opt-key">${"ABCD"[i]}.</span> <span>${esc(showMeaning ? o.meaning : o.word)}</span></button>`)
    .join("");
  box.querySelectorAll(".option").forEach((b) => (b.onclick = () => answer(Number(b.dataset.i))));
}

function answer(i) {
  if (q.answered) return;
  q.answered = true;
  const w = q.pool[q.idx];
  const chosen = q.options[i];
  const ok = wordKey(chosen.word) === wordKey(w.word);
  answerFeedback(w, ok, chosen);
}

function renderWrittenBatch() {
  const dictation = q.mode === "dictation";
  $("#quizWord").textContent = "";
  $("#quizPhonetic").textContent = "";
  $("#quizMeaning").textContent = "";
  $("#quizOptions").innerHTML = `<div class="written-batch">
    <p class="muted">${dictation ? "聚焦输入框时自动播放读音，可点击播放按钮重听。" : "根据每题释义填写英文单词。"}按 Tab 跳到下一词，Shift + Tab 返回上一词；全部填完后统一提交。</p>
    ${q.pool.map((w, i) => `<div class="written-row">
      <div class="written-prompt"><label for="writtenInput${i}">第 ${i + 1} 题${dictation ? "" : ` · ${esc(w.meaning)}`}</label>
        ${dictation ? `<button type="button" class="btn small" id="writtenPlay${i}" aria-label="播放第 ${i + 1} 题读音">🔊 播放读音</button>` : ""}
        ${dictation ? "" : `<button type="button" class="btn ghost small" id="writtenHint${i}">音标提示</button><span id="writtenPhonetic${i}" class="muted"></span>`}
      </div>
      <div class="spell-box"><input type="text" id="writtenInput${i}" placeholder="输入英文单词…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div id="writtenFeedback${i}" class="feedback hidden" aria-live="polite"></div>
    </div>`).join("")}
    <button type="button" class="btn primary big" id="writtenSubmit">提交全部答案</button>
  </div>`;
  q.pool.forEach((w, i) => {
    const input = $(`#writtenInput${i}`);
    input.oninput = updateWrittenProgress;
    input.onkeydown = (event) => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Tab" && event.shiftKey) {
        if (i > 0) {
          event.preventDefault();
          $(`#writtenInput${i - 1}`).focus();
        }
      } else if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        (i + 1 < q.pool.length ? $(`#writtenInput${i + 1}`) : $("#writtenSubmit")).focus();
      }
    };
    input.onfocus = () => {
      if (dictation && QUIZ_ACTIVE && !q.answered) speakWord(w.word);
    };
    if (dictation) $(`#writtenPlay${i}`).onclick = () => speakWord(w.word);
    if (!dictation) $(`#writtenHint${i}`).onclick = () => { $(`#writtenPhonetic${i}`).textContent = w.phonetic || "（暂无音标）"; };
  });
  $("#writtenSubmit").onclick = submitWrittenBatch;
  $("#writtenSubmit").onkeydown = (event) => {
    if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !q.answered) {
      event.preventDefault();
      $(`#writtenInput${q.pool.length - 1}`).focus();
    }
  };
  updateWrittenProgress();
  $("#writtenInput0").focus();
}

function updateWrittenProgress() {
  const filled = q.pool.filter((_, i) => $(`#writtenInput${i}`).value.trim()).length;
  $("#quizProgressText").textContent = `已填写 ${filled} / ${q.pool.length} 题`;
  $("#quizProgressBar").style.width = `${filled / q.pool.length * 100}%`;
  $("#quizProgress").setAttribute("aria-valuenow", String(filled));
}

function submitWrittenBatch() {
  if (!QUIZ_ACTIVE || !isWrittenMode() || q.answered) return;
  const missing = q.pool.findIndex((_, i) => !$(`#writtenInput${i}`).value.trim());
  if (missing >= 0) {
    notify(`第 ${missing + 1} 题还未填写，请全部填完后提交。`, "error");
    $(`#writtenInput${missing}`).focus();
    return;
  }
  q.answered = true;
  stopSpeech();
  const norm = (value) => String(value).trim().toLowerCase().replace(/[\s\-\u0027\u2019]/g, "");
  let correct = 0;
  q.pool.forEach((w, i) => {
    const input = $(`#writtenInput${i}`);
    const ok = norm(input.value) === norm(w.word);
    recordQuizAnswer(w, ok);
    if (ok) correct++;
    input.disabled = true;
    input.classList.add(ok ? "correct" : "wrong");
    const feedback = $(`#writtenFeedback${i}`);
    feedback.className = `feedback ${ok ? "ok" : "no"}`;
    feedback.innerHTML = `<div>${ok ? "✅ 回答正确" : "❌ 回答错误"}</div>
      <div>正确答案：<strong class="fb-word">${esc(w.word)}</strong>
        <button type="button" class="speak-btn" id="writtenAnswerPlay${i}" aria-label="朗读正确答案 ${esc(w.word)}">🔊 播放读音</button></div>
      <div>音标：${esc(w.phonetic || "暂无音标")}</div>
      <div>词性：${esc(answerPartsOfSpeech(w.meaning))}</div>
      <div>释义：${esc(w.meaning)}</div>
      ${favoriteButton(w)}`;
    $(`#writtenAnswerPlay${i}`).onclick = () => speakWord(w.word);
  });
  recordSessionCompletion();
  $("#writtenSubmit").disabled = true;
  $("#quizProgressText").textContent = `已批改 ${q.pool.length} 题 · 对 ${correct} · 错 ${q.pool.length - correct}`;
  const next = $("#quizNext");
  next.textContent = q.retryWords.length ? "补测错词 →" : q.stage < QUIZ_STAGES.length - 1 ? "进入拼写测试 →" : "查看结果 🎉";
  next.classList.remove("hidden");
  next.onclick = advance;
}

function recordSessionCompletion() {
  if (q.completionRecorded || q.stage !== QUIZ_STAGES.length - 1 || !q.answered || q.retryWords.length) return;
  const completedAt = Date.now();
  const daily = todayStats();
  const day = todayStr();
  for (const entry of q.words) {
    const key = wordKey(entry.word);
    const stats = WSTATS[key];
    const wasWrong = q.wrongList.some(word => wordKey(word.word) === key);
    if (wasWrong) {
      stats.streak = 0;
      stats.interval = 0;
      stats.nextReviewAt = completedAt + 10 * 60 * 1000;
    } else if (stats.lastReviewDay !== day || (!stats.interval && stats.nextReviewAt <= completedAt)) {
      stats.streak = nonNegativeInt(stats.streak) + 1;
      stats.interval = REVIEW_INTERVALS[Math.min(stats.streak - 1, REVIEW_INTERVALS.length - 1)];
      stats.nextReviewAt = completedAt + stats.interval * DAY_MS;
    }
    stats.lastReviewDay = day;
    stats.completedAt = completedAt;
    stats.historicalLearning = false;
    if (!daily.completedWords.includes(key)) daily.completedWords.push(key);
  }
  q.completionRecorded = true;
  save(LS.wordstats, WSTATS);
  save(LS.stats, STATS);
  updateGoal();
}

function answerPartsOfSpeech(meaning) {
  const names = { n: "名词", v: "动词", vt: "及物动词", vi: "不及物动词", adj: "形容词", adv: "副词", prep: "介词", conj: "连词", pron: "代词", num: "数词", int: "感叹词", interj: "感叹词", art: "冠词", aux: "助动词", det: "限定词" };
  const tags = [...String(meaning || "").matchAll(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|int|interj|art|aux|det)\./gi)].map(match => match[1].toLowerCase());
  return [...new Set(tags)].map(tag => `${tag}. ${names[tag]}`).join(" / ") || "词库未标注";
}

function recordQuizAnswer(w, ok) {
  q.attempts++;
  if (ok) q.correct++;
  else {
    q.retryWords.push(w);
    if (!q.wrongList.some((entry) => wordKey(entry.word) === wordKey(w.word))) q.wrongList.push(w);
  }
  recordAnswer(wordKey(w.word), ok);
}

function answerCard(ok) {
  if (q.answered) return;
  q.answered = true;
  const w = q.pool[q.idx];
  $("#quizMeaning").classList.remove("hidden");
  answerFeedback(w, ok, null);
}

function answerFeedback(w, ok, chosen) {
  recordQuizAnswer(w, ok);
  const fb = $("#quizFeedback");
  const meaning = q.mode === "dictation" ? "" : esc(w.meaning);
  if (ok) {
    fb.className = "feedback ok";
    fb.innerHTML = `✅ 回答正确！<span class="fb-word">${esc(w.word)}</span> ${esc(w.phonetic)}<button class="speak-btn" type="button" data-speak="${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">🔊</button><br>${meaning}`;
    if (q.mode !== "card" && !isWrittenMode()) {
      const btns = $$("#quizOptions .option");
      btns.forEach((b, idx) => {
        if (wordKey(q.options[idx].word) === wordKey(w.word)) b.classList.add("correct");
        b.disabled = true;
      });
    }
  } else {
    fb.className = "feedback no";
    const typedNote = isWrittenMode() && chosen ? ` 你输入的是「${esc(chosen)}」<br>` : "";
    fb.innerHTML = `❌ 答错了。正确答案是 <span class="fb-word">${esc(w.word)}</span> ${esc(w.phonetic)}<button class="speak-btn" type="button" data-speak="${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">🔊</button><br>${typedNote}${meaning}`;
    if (q.mode !== "card" && !isWrittenMode()) {
      const btns = $$("#quizOptions .option");
      btns.forEach((b, idx) => {
        if (wordKey(q.options[idx].word) === wordKey(w.word)) b.classList.add("correct");
        else if (chosen && wordKey(q.options[idx].word) === wordKey(chosen.word)) b.classList.add("wrong");
        b.disabled = true;
      });
    }
  }
  fb.insertAdjacentHTML("beforeend", favoriteButton(w));
  fb.querySelector("[data-speak]")?.addEventListener("click", () => speakWord(w.word));
  const nextBtn = $("#quizNext");
  if (q.mode === "card") {
    // 卡片模式：不显示「下一题」按钮，答完自动进入下一题
    nextBtn.classList.add("hidden");
    scheduleCardAdvance();
  } else {
    nextBtn.textContent = q.idx + 1 < q.pool.length ? "下一题 →" : q.retryWords.length ? "继续补测错词 →" : q.stage < QUIZ_STAGES.length - 1 ? `进入${QUIZ_STAGES[q.stage + 1]}测试 →` : "查看结果 🎉";
    nextBtn.classList.remove("hidden");
    nextBtn.onclick = advance;
  }
}

function scheduleCardAdvance() {
  clearQuizTimer();
  if (!QUIZ_ACTIVE || q.mode !== "card" || !q.answered || !$("#view-study").classList.contains("active")) return;
  quizTimer = setTimeout(() => {
    quizTimer = null;
    if (QUIZ_ACTIVE && $("#view-study").classList.contains("active")) advance();
  }, 900);
}

function nextQuestion() {
  q.idx++;
  renderQuestion();
}

function advance() {
  if (!QUIZ_ACTIVE || !q.answered) return;
  if (!isWrittenMode() && q.idx + 1 < q.pool.length) { nextQuestion(); return; }
  if (q.retryWords.length) {
    q.pool = shuffle(q.retryWords);
    q.retryWords = [];
    q.retryRound++;
  } else if (q.stage < QUIZ_STAGES.length - 1) {
    q.stage++;
    q.mode = q.stage === 1 ? "dictation" : "spell";
    q.pool = shuffle(q.words);
    q.retryRound = 0;
  } else { finishQuiz(); return; }
  q.idx = 0;
  renderQuestion();
}

function finishQuiz() {
  stopSpeech();
  QUIZ_ACTIVE = false;
  clearQuizTimer();
  $("#studyQuiz").classList.add("hidden");
  const s = $("#studySummary");
  s.classList.remove("hidden");
  const total = q.attempts;
  const acc = Math.round((q.correct / total) * 100);
  $("#summaryTitle").textContent = `🎉 ${q.words.length} 个单词，三轮全部通过！`;
  $("#summaryStats").innerHTML = `
    <div class="summary-stat"><div class="num" style="color:var(--good)">${q.correct}</div><div class="lbl">答对</div></div>
    <div class="summary-stat"><div class="num" style="color:var(--bad)">${total - q.correct}</div><div class="lbl">答错</div></div>
    <div class="summary-stat"><div class="num">${acc}%</div><div class="lbl">累计正确率（含补测）</div></div>`;
  const box = $("#summaryWrong");
  if (q.wrongList.length) {
    box.innerHTML = `<h4>本次曾答错 ${q.wrongList.length} 个，现已补测通过（保留在错题本）：</h4>`
      + q.wrongList.map(w => `<span class="chip">${esc(w.word)}</span>`).join("");
  } else {
    box.innerHTML = "";
  }
  const mode = q.choiceMode;
  $("#summaryRetry").onclick = () => { if (q.wrongList.length) startQuiz(mode, "wordbook", q.wrongList.length, q.wrongList.slice(), q.returnContext); else notify("没有错词啦～"); };
  $("#summaryAgain").onclick = returnToSource;
  $("#summaryHome").onclick = returnToSource;
  updateGoal();
}

function backToSetup() {
  stopSpeech();
  QUIZ_ACTIVE = false;
  clearQuizTimer();
  $("#studyPreview").classList.add("hidden");
  $("#studyQuiz").classList.add("hidden");
  $("#studySummary").classList.add("hidden");
  $("#studySetup").classList.remove("hidden");
}

function invalidateQuiz(word) {
  if (word && !q.words?.some(entry => wordKey(entry.word) === word)) return false;
  const interrupted = QUIZ_ACTIVE || !$("#studyPreview").classList.contains("hidden");
  backToSetup();
  Object.assign(q, { mode: null, pool: [], words: [], options: [], retryWords: [], wrongList: [], answered: false });
  return interrupted;
}

function returnToSource() {
  const context = q.returnContext || { view: "study", scrollY: 0 };
  backToSetup();
  showView(context.view);
  window.scrollTo({ top: context.scrollY, behavior: "instant" });
}

/* ---------- 错题本 ---------- */
function syncMistakeRecord(word) {
  const stats = WSTATS[word];
  let item = WB.find(entry => entry.word === word);
  if (!stats?.wrong && !item?.wrong) return;
  if (!item) {
    item = { word, categories: [], status: "learning", addedAt: stats.lastAt || Date.now(), lastAt: 0, wrong: 0, right: 0 };
    WB.push(item);
  }
  item.wrong = Math.max(nonNegativeInt(item.wrong), nonNegativeInt(stats?.wrong));
  item.right = Math.max(nonNegativeInt(item.right), nonNegativeInt(stats?.right));
  item.lastAt = Math.max(nonNegativeInt(item.lastAt), nonNegativeInt(stats?.lastAt));
}

function reconcileMistakeBook() {
  const before = JSON.stringify(WB);
  WB = WB.filter(item => BYWORD.has(item.word) && (item.wrong > 0 || WSTATS[item.word]?.wrong > 0));
  for (const word of new Set([...WB.map(item => item.word), ...Object.keys(WSTATS)])) {
    if (BYWORD.has(word)) syncMistakeRecord(word);
  }
  if (JSON.stringify(WB) !== before) save(LS.wordbook, WB);
}

function removeFromWordbook(word, prefix = "wb") {
  if (prefix !== "fav") return; // Mistake history is retained after later correct answers.
  FAVORITES = FAVORITES.filter(item => item.word !== wordKey(word));
  save(LS.favorites, FAVORITES);
}
function setWbStatus(word, status, prefix = "wb") {
  const x = (prefix === "fav" ? FAVORITES : WB).find((e) => e.word === word);
  if (x) x.status = status;
  save(prefix === "fav" ? LS.favorites : LS.wordbook, prefix === "fav" ? FAVORITES : WB);
}

function filteredWordbook(prefix = "wb") {
  if (prefix === "wb") reconcileMistakeBook();
  const kw = $(`#${prefix}Search`).value.trim().toLowerCase();
  const flt = $(`#${prefix}Filter`).value;
  const sort = $(`#${prefix}Sort`).value;
  let list = (prefix === "fav" ? FAVORITES : WB).slice();
  const category = $(`#${prefix}Category`).value;
  if (prefix === "fav" && category === "uncategorized") list = list.filter(item => !item.categories?.length);
  else if (prefix === "fav" && category && category !== "all") list = list.filter(item => item.categories?.includes(category.slice(4)));
  if (flt && flt !== "all") list = list.filter((x) => x.status === flt);
  if (kw) {
    list = list.filter((x) => {
      const e = BYWORD.get(x.word);
      return x.word.includes(kw) || (e && (e.meaning || "").toLowerCase().includes(kw));
    });
  }
  list.sort((a, b) => {
    if (sort === "wrong") return b.wrong - a.wrong || b.lastAt - a.lastAt;
    if (sort === "recent") return b.lastAt - a.lastAt;
    if (sort === "added") return b.addedAt - a.addedAt;
    const as = WSTATS[a.word] || {};
    const bs = WSTATS[b.word] || {};
    return (as.nextReviewAt || 0) - (bs.nextReviewAt || 0) || b.wrong - a.wrong;
  });
  return list;
}

function renderWordbook(prefix = "wb") {
  const category = $(`#${prefix}Category`).value || "all";
  $(`#${prefix}Category`).innerHTML = '<option value="all">全部栏目</option><option value="uncategorized">未分类</option>' + favoriteCategories().map(name => `<option value="cat:${esc(name)}">${esc(name)}</option>`).join("");
  $(`#${prefix}Category`).value = category;
  if (!$(`#${prefix}Category`).value) $(`#${prefix}Category`).value = "all";
  const list = filteredWordbook(prefix);
  $(`#${prefix}Count`).textContent = `共 ${(prefix === "fav" ? FAVORITES : WB).length} 个 · 当前 ${list.length} 个`;
  $(`#${prefix}Review`).disabled = !list.length;
  const box = $(`#${prefix}List`);
  const empty = $(`#${prefix}Empty`);
  if (!list.length) {
    box.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  box.innerHTML = list.map((x) => {
    const e = BYWORD.get(x.word) || { word: x.word, phonetic: "", meaning: "" };
    const badge = x.status === "mastered" ? `<span class="badge mastered">已掌握</span>` : `<span class="badge learning">学习中</span>`;
    return `<div class="item">
      <div class="item-main">
        <div><span class="item-word">${esc(e.word)}</span>${e.phonetic ? `<span class="item-phonetic">${esc(e.phonetic)}</span>` : ""}</div>
        <div class="item-meaning">${esc(e.meaning)}</div>
        <div class="favorite-tags ${prefix === "fav" ? "" : "hidden"}">${(x.categories || []).map(category => `<span class="badge">${esc(category)}</span>`).join("") || '<span class="muted">未分类</span>'}</div>
        <div class="muted">错 ${x.wrong} · 对 ${x.right} · ${esc(reviewLabel(WSTATS[x.word]))}</div>
      </div>
      <div class="item-actions">
        ${badge}
        ${favoriteButton(e)}
        <button class="mini-btn" data-speak="${esc(e.word)}" aria-label="朗读 ${esc(e.word)}">🔊</button>
        <button class="mini-btn" data-wb-toggle="${esc(x.word)}" data-wb-cur="${x.status}">${x.status === "mastered" ? "转学习中" : "标为掌握"}</button>
        ${prefix === "fav" ? `<button class="mini-btn danger" data-wb-rm="${esc(x.word)}">取消收藏</button>` : ""}
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-wb-toggle]").forEach((b) => (b.onclick = () => { setWbStatus(b.dataset.wbToggle, b.dataset.wbCur === "mastered" ? "learning" : "mastered", prefix); renderWordbook(prefix); }));
  box.querySelectorAll("[data-wb-rm]").forEach((b) => (b.onclick = () => { removeFromWordbook(b.dataset.wbRm, prefix); renderWordbook(prefix); }));
  box.querySelectorAll("[data-speak]").forEach((b) => (b.onclick = () => speakWord(b.dataset.speak)));
}

function reviewLabel(stats) {
  if (!stats || !stats.seen) return "尚未学习";
  const remaining = finiteNumber(stats.nextReviewAt) - Date.now();
  if (remaining <= 0) return "现在复习";
  if (remaining < 3600000) return `${Math.max(1, Math.ceil(remaining / 60000))} 分钟后复习`;
  if (remaining < DAY_MS) return `${Math.max(1, Math.ceil(remaining / 3600000))} 小时后复习`;
  return `${Math.ceil(remaining / DAY_MS)} 天后复习`;
}

/* ---------- 已学单词 ---------- */
function learnedWords() {
  const keyword = $("#learnedSearch").value.trim().toLowerCase();
  const filter = $("#learnedFilter").value;
  const sort = $("#learnedSort").value;
  const now = Date.now();
  return buildPool("learned").filter((entry) => {
    const stats = WSTATS[wordKey(entry.word)];
    if (filter === "due" && stats.nextReviewAt > now) return false;
    if (filter === "wrong" && !stats.wrong) return false;
    return !keyword || wordKey(entry.word).includes(keyword) || entry.meaning.toLowerCase().includes(keyword);
  }).sort((a, b) => {
    const sa = WSTATS[wordKey(a.word)];
    const sb = WSTATS[wordKey(b.word)];
    if (sort === "recent") return (sb.lastAt || 0) - (sa.lastAt || 0);
    if (sort === "wrong") return sb.wrong - sa.wrong || (sb.lastAt || 0) - (sa.lastAt || 0);
    return (sa.nextReviewAt || 0) - (sb.nextReviewAt || 0) || sb.wrong - sa.wrong;
  });
}

function reviewLearned() {
  const list = learnedWords();
  const count = resolveReviewCount("learned", list.length);
  if (count == null) return;
  const words = list.slice(0, count);
  if (!words.length) { notify("当前列表没有可复习的单词。", "error"); return; }
  startQuiz("en2zh", "learned", words.length, words);
}

function resolveReviewCount(prefix, available) {
  const value = $(`#${prefix}ReviewCount`).value;
  if (value === "all") return available;
  const count = Number(value === "custom" ? $(`#${prefix}ReviewCountCustom`).value : value);
  if (!Number.isSafeInteger(count) || count < 1) {
    notify("请输入有效的单词数量（至少 1 个的整数）。", "error");
    return null;
  }
  return Math.min(count, available);
}

function bindReviewCount(prefix) {
  $(`#${prefix}ReviewCount`).onchange = () => {
    const custom = $(`#${prefix}ReviewCountCustom`);
    const show = $(`#${prefix}ReviewCount`).value === "custom";
    custom.classList.toggle("hidden", !show);
    if (show) custom.focus();
  };
}

function reviewWordbook(prefix = "wb") {
  const list = filteredWordbook(prefix).map(item => BYWORD.get(item.word)).filter(Boolean);
  const count = resolveReviewCount(prefix, list.length);
  if (count == null) return;
  startQuiz("en2zh", prefix === "fav" ? "favorites" : "wordbook", count, list.slice(0, count));
}

function renderLearned() {
  const total = buildPool("learned").length;
  const list = learnedWords();
  $("#learnedCount").textContent = `共 ${total} 个 · 当前 ${list.length} 个`;
  $("#learnedReview").disabled = list.length === 0;
  $("#learnedEmpty").classList.toggle("hidden", list.length > 0);
  $("#learnedEmptyTitle").textContent = total ? "没有符合条件的单词" : "还没有已学单词";
  $("#learnedEmptyHint").textContent = total ? "试试其他关键词或筛选条件。" : "完成整组的三轮测试后，单词会出现在这里。";
  const box = $("#learnedList");
  box.innerHTML = list.map((entry) => {
    const stats = WSTATS[wordKey(entry.word)];
    const lastAt = stats.lastAt ? new Date(stats.lastAt).toLocaleDateString("zh-CN") : "暂无记录";
    return `<div class="item">
      <div class="item-main">
        <div><span class="item-word">${esc(entry.word)}</span><span class="item-phonetic">${esc(entry.phonetic)}</span></div>
        <div class="item-meaning">${esc(entry.meaning)}</div>
        <div class="muted">已练 ${stats.seen} 次 · 对 ${stats.right} · 错 ${stats.wrong} · ${esc(reviewLabel(stats))}</div>
        <div class="muted">最近学习：${esc(lastAt)}</div>
        <div class="muted">${stats.completedAt > 0 ? "已完成三轮测试" : "历史学习记录 · 完成状态未确认"}</div>
      </div>
      <div class="item-actions">
        ${favoriteButton(entry)}
        <button class="mini-btn" data-learned-speak="${esc(entry.word)}" aria-label="朗读 ${esc(entry.word)}">🔊</button>
        <button class="mini-btn" data-learned-review="${esc(wordKey(entry.word))}">复习此词</button>
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-learned-speak]").forEach((button) => {
    button.onclick = () => speakWord(button.dataset.learnedSpeak);
  });
  box.querySelectorAll("[data-learned-review]").forEach((button) => {
    button.onclick = () => {
      const entry = BYWORD.get(button.dataset.learnedReview);
      if (entry) startQuiz("en2zh", "learned", 1, [entry]);
    };
  });
}

/* ---------- 词表 ---------- */
let glShown = 200;
function renderGlossary() {
  const kw = $("#glSearch").value.trim().toLowerCase();
  let list = WORDS;
  if (kw) list = list.filter((w) => w.word.toLowerCase().includes(kw) || w.meaning.toLowerCase().includes(kw));
  $("#glCount").textContent = `${list.length} 词`;
  const box = $("#glList");
  const empty = $("#glEmpty");
  if (!list.length) { box.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const head = list.slice(0, glShown);
  const customSet = new Set(CUSTOM.map((w) => w.word.toLowerCase()));
  box.innerHTML = head.map((w) => {
    const key = w.word.toLowerCase();
    const isCustom = customSet.has(key);
    const custom = isCustom ? `<span class="badge new">自定义</span>` : "";
    const addBtn = favoriteButton(w);
    return `<div class="item">
      <div class="item-main">
        <div><span class="item-word">${esc(w.word)}</span>${w.phonetic ? `<span class="item-phonetic">${esc(w.phonetic)}</span>` : ""} ${custom}</div>
        <div class="item-meaning">${esc(w.meaning)}</div>
      </div>
      <div class="item-actions">
        <button class="mini-btn" data-speak="${esc(w.word)}" aria-label="朗读 ${esc(w.word)}">🔊</button>
        ${addBtn}
        ${isCustom ? `<button class="mini-btn" data-custom-edit="${esc(key)}">编辑</button><button class="mini-btn danger" data-custom-rm="${esc(key)}">删除</button>` : ""}
      </div>
    </div>`;
  }).join("");
  if (list.length > glShown) {
    box.insertAdjacentHTML("beforeend", `<button class="btn small" id="glMore">显示更多（还剩 ${list.length - glShown} 个）</button>`);
    $("#glMore").onclick = () => { glShown += 200; renderGlossary(); };
  }
  box.querySelectorAll("[data-speak]").forEach((b) => (b.onclick = () => speakWord(b.dataset.speak)));
  box.querySelectorAll("[data-custom-edit]").forEach((b) => (b.onclick = () => editCustomWord(b.dataset.customEdit)));
  box.querySelectorAll("[data-custom-rm]").forEach((b) => (b.onclick = () => deleteCustomWord(b.dataset.customRm)));
}

/* ---------- 统计 ---------- */
function renderStats() {
  reconcileMistakeBook();
  const uniqueSeen = buildPool("learned").length;
  const total = STATS.total;
  const acc = total.right + total.wrong > 0 ? Math.round((total.right / (total.right + total.wrong)) * 100) : 0;
  const mastered = WB.filter((x) => x.status === "mastered").length;
  const due = buildPool("due").length;
  const today = todayStats().completedWords.length;
  $("#statGrid").innerHTML = `
    <div class="stat-card"><div class="num">${uniqueSeen}</div><div class="lbl">累计已学（含历史）</div></div>
    <div class="stat-card"><div class="num">${today}</div><div class="lbl">今日已学</div></div>
    <div class="stat-card"><div class="num">${acc}%</div><div class="lbl">总正确率</div></div>
    <div class="stat-card"><div class="num">${due}</div><div class="lbl">今日待复习</div></div>
    <div class="stat-card"><div class="num">${WB.length}</div><div class="lbl">错题本 / 已掌握 ${mastered}</div></div>`;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ key, seen: (STATS.daily[key] || {}).seen || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.seen));
  $("#statBars").innerHTML = days.map((d) => {
    const h = Math.max(4, Math.round((d.seen / max) * 100));
    const label = d.key.slice(5).replace("-", "/");
    return `<div class="bar-col"><div class="bar-num">${d.seen || ""}</div><div class="bar" style="height:${h}%"></div><div class="bar-label">${label}</div></div>`;
  }).join("");
}

/* ---------- 设置 ---------- */
function renderSettings() {
  $("#setGoal").value = SETTINGS.dailyGoal;
  $("#importText").value = "";
}

/* ---------- 目标徽章 ---------- */
function renderGoal() { updateGoal(); }
function updateGoal() {
  const t = todayStats().completedWords.length;
  const g = SETTINGS.dailyGoal;
  const badge = $("#goalBadge");
  badge.textContent = `今日 ${t}/${g} 词`;
  const done = t >= g;
  badge.classList.toggle("done", done);
}

let dailyRefreshTimer = null;
function refreshDailyDisplay() {
  if (!STATS || !SETTINGS) return;
  updateGoal();
  if ($("#view-stats").classList.contains("active")) renderStats();
}

function scheduleDailyRefresh() {
  clearTimeout(dailyRefreshTimer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  dailyRefreshTimer = setTimeout(() => {
    refreshDailyDisplay();
    scheduleDailyRefresh();
  }, midnight.getTime() - now.getTime() + 100);
}

function setupDailyRefresh() {
  scheduleDailyRefresh();
  window.addEventListener("focus", refreshDailyDisplay);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshDailyDisplay();
      scheduleDailyRefresh();
    }
  });
}

/* ---------- 持久化 ---------- */
function persist() {
  save(LS.favorites, FAVORITES);
  save(LS.custom, CUSTOM);
  save(LS.wordbook, WB);
  save(LS.wordstats, WSTATS);
  save(LS.stats, STATS);
  save(LS.settings, SETTINGS);
  save(LS.version, DATA_VERSION);
}

/* ---------- 题目数量 ---------- */
function resolveQuizCount() {
  const sel = $("#quizCount").value;
  const count = Number(sel === "custom" ? $("#quizCountCustom").value : sel);
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

function saveDailyGoal() {
  const goal = Number($("#setGoal").value);
  if (!Number.isInteger(goal) || goal < 5 || goal > 500) {
    notify("每日目标请输入 5 到 500 之间的整数。", "error");
    $("#setGoal").focus();
    return;
  }
  SETTINGS.dailyGoal = goal;
  persist();
  updateGoal();
  notify(`每日目标已设为 ${goal} 个单词`);
}

function handleQuizKeydown(e) {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
  if ($("#favoriteDialog").open || $("#wordDialog").open) return;
  if (!QUIZ_ACTIVE || !$("#view-study").classList.contains("active") || $("#studyQuiz").classList.contains("hidden")) return;
  if (q.mode === "card" || isWrittenMode()) return;
  const target = e.target;
  if (target?.isContentEditable || target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
  const optionKey = /^[1-4]$/.test(e.key) ? Number(e.key) - 1 : /^[a-d]$/i.test(e.key) ? "abcd".indexOf(e.key.toLowerCase()) : -1;
  if (!q.answered && optionKey >= 0 && optionKey < q.options.length) {
    e.preventDefault();
    answer(optionKey);
  } else if (q.answered && (e.key === "Enter" || e.key === " ")) {
    if (target?.closest?.("button, a, [role='button']")) return;
    const next = $("#quizNext");
    if (!next.classList.contains("hidden")) {
      e.preventDefault();
      next.click();
    }
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-favorite]");
    if (button) openFavorite(button.dataset.favorite);
  });
  $("#favoriteForm").onsubmit = saveFavorite;
  $("#favoriteCancel").onclick = closeFavorite;
  $("#favoriteDialog").addEventListener("cancel", () => { favoriteWord = null; });

  $$(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));

  // 学习
  let chosenMode = "en2zh";
  $$(".mode-card").forEach((c) => (c.onclick = () => {
    chosenMode = c.dataset.mode;
    $$(".mode-card").forEach((x) => {
      const selected = x === c;
      x.classList.toggle("selected", selected);
      x.setAttribute("aria-pressed", String(selected));
    });
  }));
  $$(".mode-card")[0].classList.add("selected");
  $$(".mode-card").forEach((card, index) => card.setAttribute("aria-pressed", String(index === 0)));
  $("#quizCount").onchange = () => {
    const isCustom = $("#quizCount").value === "custom";
    $("#quizCountCustom").classList.toggle("hidden", !isCustom);
    if (isCustom) $("#quizCountCustom").focus();
  };
  $("#startQuiz").onclick = () => {
    const count = resolveQuizCount();
    if (count == null) { notify("请输入有效的题目数量（至少 1 题的正整数）。", "error"); return; }
    startQuiz(chosenMode, $("#quizScope").value, count);
  };
  const leaveQuiz = () => {
    if (confirm("返回后将结束本次测试，已记录的答题结果会保留。确定返回？")) returnToSource();
  };
  $("#quizQuit").onclick = leaveQuiz;
  $("#quizBack").onclick = leaveQuiz;
  $("#previewStartTest").onclick = beginTest;
  $("#previewBack").onclick = returnToSource;

  // 已学单词
  const refreshLearned = renderLearned;
  $("#learnedSearch").oninput = refreshLearned;
  $("#learnedFilter").onchange = refreshLearned;
  $("#learnedSort").onchange = refreshLearned;
  $("#learnedReview").onclick = reviewLearned;
  bindReviewCount("learned");

  // 错题本
  $("#wbSearch").oninput = () => renderWordbook();
  $("#wbFilter").onchange = () => renderWordbook();
  $("#wbCategory").onchange = () => renderWordbook();
  $("#wbSort").onchange = () => renderWordbook();
  $("#wbReview").onclick = () => reviewWordbook();
  bindReviewCount("wb");
  $("#favSearch").oninput = () => renderWordbook("fav");
  ["Filter", "Category", "Sort"].forEach(suffix => { $(`#fav${suffix}`).onchange = () => renderWordbook("fav"); });
  $("#favReview").onclick = () => reviewWordbook("fav");
  bindReviewCount("fav");

  // 词表
  $("#glSearch").oninput = () => { glShown = 200; renderGlossary(); };

  // 设置
  $("#saveGoal").onclick = saveDailyGoal;
  $("#addWordBtn").onclick = addCustomWord;
  $("#importBtn").onclick = importWords;
  $("#exportBtn").onclick = exportData;
  $("#importDataInput").onchange = importData;
  $("#wordEditForm").onsubmit = saveCustomWordEdit;
  $("#wordDialogClose").onclick = closeWordDialog;
  $("#wordDialogCancel").onclick = closeWordDialog;
  $("#editWord").oninput = () => $("#editWord").setCustomValidity("");
  $("#wordDialog").onclick = (event) => { if (event.target === $("#wordDialog")) closeWordDialog(); };
  $("#resetBtn").onclick = () => {
    if (confirm("确定清空所有学习数据？此操作不可恢复！")) {
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      location.reload();
    }
  };

  // 键盘
  document.addEventListener("keydown", handleQuizKeydown);
  bindStorageConflictEvents();
}

/* ---------- 自定义单词 / 导入 ---------- */
function updateDailyWordRecords(key, replacement = null) {
  for (const daily of Object.values(STATS.daily)) {
    for (const field of ["words", "completedWords"]) {
      if (!Array.isArray(daily[field])) continue;
      daily[field] = [...new Set(daily[field].map(wordKey).map(word => word === key ? replacement : word).filter(Boolean))];
    }
  }
}

function parseEntryLine(line) {
  line = line.trim();
  if (!line) return null;
  const bracketed = line.match(/^([A-Za-z][A-Za-z'\- ]*?)\s*\[([^\]]*)\]\s*(.+)$/);
  if (bracketed) {
    return { word: bracketed[1].trim(), phonetic: bracketed[2].trim(), meaning: bracketed[3].trim() };
  }
  const plain = line.match(/^([A-Za-z][A-Za-z'\-]*)\s+(.+)$/);
  if (!plain) return null;
  return { word: plain[1].trim(), phonetic: "", meaning: plain[2].trim() };
}

function addCustomWord() {
  const word = $("#addWord").value.trim();
  const phonetic = $("#addPhonetic").value.trim();
  const meaning = $("#addMeaning").value.trim();
  if (!word || !meaning) { notify("请填写单词和释义。", "error"); return; }
  const key = wordKey(word);
  if (BYWORD.has(key)) { notify("这个词已存在词库中。", "error"); return; }
  const entry = normalizeEntry({ word, phonetic, meaning });
  if (!entry) { notify("单词格式不正确，请使用英文字母、空格、连字符或撇号。", "error"); return; }
  CUSTOM.push(entry);
  WORDS.push(entry);
  BYWORD.set(key, entry);
  persist();
  $("#addWord").value = $("#addPhonetic").value = $("#addMeaning").value = "";
  notify(`已添加 ${word}，自定义词会参与学习`);
}

function editCustomWord(rawKey) {
  const key = wordKey(rawKey);
  const index = CUSTOM.findIndex((entry) => wordKey(entry.word) === key);
  if (index < 0) return;
  const current = CUSTOM[index];
  editingWordKey = key;
  $("#editWord").value = current.word;
  $("#editWord").setCustomValidity("");
  $("#editPhonetic").value = current.phonetic;
  $("#editMeaning").value = current.meaning;
  $("#wordDialog").showModal();
  $("#editWord").focus();
}

function closeWordDialog() {
  editingWordKey = null;
  $("#wordDialog").close();
}

function saveCustomWordEdit(event) {
  event.preventDefault();
  const key = editingWordKey;
  const index = CUSTOM.findIndex((entry) => wordKey(entry.word) === key);
  if (!key || index < 0) { closeWordDialog(); return; }
  const word = $("#editWord").value;
  const phonetic = $("#editPhonetic").value;
  const meaning = $("#editMeaning").value;
  const entry = normalizeEntry({ word, phonetic, meaning });
  if (!entry) {
    $("#editWord").setCustomValidity("请使用英文字母、空格、连字符或撇号。");
    $("#editWord").reportValidity();
    return;
  }
  const newKey = wordKey(entry.word);
  if (newKey !== key && BYWORD.has(newKey)) {
    $("#editWord").setCustomValidity("这个词已经存在词库中。");
    $("#editWord").reportValidity();
    return;
  }
  CUSTOM[index] = entry;
  const interrupted = invalidateQuiz(key);
  if (newKey !== key) {
    [...WB, ...FAVORITES].forEach((item) => { if (item.word === key) item.word = newKey; });
    if (WSTATS[key]) { WSTATS[newKey] = WSTATS[key]; delete WSTATS[key]; }
    updateDailyWordRecords(key, newKey);
  }
  rebuildWords();
  persist();
  updateGoal();
  closeWordDialog();
  renderGlossary();
  notify(`已保存 ${entry.word}${interrupted ? "，本组词库已变更，请重新开始测试" : ""}`);
}

function deleteCustomWord(rawKey) {
  const key = wordKey(rawKey);
  const entry = CUSTOM.find((item) => wordKey(item.word) === key);
  if (!entry || !confirm(`确定删除自定义单词“${entry.word}”？相关学习记录也会删除。`)) return;
  const interrupted = invalidateQuiz(key);
  CUSTOM = CUSTOM.filter((item) => wordKey(item.word) !== key);
  WB = WB.filter((item) => item.word !== key);
  FAVORITES = FAVORITES.filter((item) => item.word !== key);
  delete WSTATS[key];
  updateDailyWordRecords(key);
  rebuildWords();
  persist();
  updateGoal();
  renderGlossary();
  notify(`已删除 ${entry.word}${interrupted ? "，本组词库已变更，请重新开始测试" : ""}`);
}

function importWords() {
  const text = $("#importText").value;
  let ok = 0, skip = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = normalizeEntry(parseEntryLine(line));
    if (!e) { skip++; continue; }
    const key = wordKey(e.word);
    if (BYWORD.has(key)) { skip++; continue; }
    CUSTOM.push(e); WORDS.push(e); BYWORD.set(key, e); ok++;
  }
  persist();
  renderGlossary();
  notify(`导入完成：成功 ${ok} 个，跳过 ${skip} 个`);
}

/* ---------- 数据备份 ---------- */
function exportData() {
  const data = {
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    custom: CUSTOM,
    wordbook: WB,
    favorites: FAVORITES,
    wordstats: WSTATS,
    stats: STATS,
    settings: SETTINGS,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `六级背单词-数据备份-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      const imported = validateBackup(d);
      invalidateQuiz();
      CUSTOM = imported.custom;
      rebuildWords();
      const validWords = new Set(WORDS.map((entry) => wordKey(entry.word)));
      FAVORITES = imported.favorites.filter(item => validWords.has(item.word));
      WB = imported.wordbook.filter((item) => validWords.has(item.word));
      WSTATS = normalizeWordStats(Object.fromEntries(Object.entries(imported.wordstats).filter(([word]) => validWords.has(word))));
      STATS = imported.stats;
      SETTINGS = imported.settings;
      reconcileMistakeBook();
      persist();
      updateGoal();
      notify("学习数据已导入");
      showView("stats");
    } catch (err) {
      notify("导入失败：文件格式不正确。", "error");
    }
  };
  reader.onerror = () => notify("导入失败：无法读取备份文件。", "error");
  reader.readAsText(file);
  e.target.value = "";
}

function validateBackup(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid root");
  if (nonNegativeInt(data.version) > DATA_VERSION) throw new Error("newer backup");
  if (!Array.isArray(data.custom) || !Array.isArray(data.wordbook)) throw new Error("invalid arrays");
  if (!data.wordstats || typeof data.wordstats !== "object" || Array.isArray(data.wordstats)) throw new Error("invalid wordstats");
  if (!data.stats || typeof data.stats !== "object" || Array.isArray(data.stats)) throw new Error("invalid stats");
  if (!data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) throw new Error("invalid settings");

  if (data.version >= 6 && !Array.isArray(data.favorites)) throw new Error("invalid favorites");
  const builtinKeys = new Set(BUILTIN.map((entry) => wordKey(entry.word)));
  const customKeys = new Set();
  const custom = data.custom.flatMap((raw) => {
    const entry = normalizeEntry(raw);
    const key = entry && wordKey(entry.word);
    if (!entry || builtinKeys.has(key) || customKeys.has(key)) return [];
    customKeys.add(key);
    return [entry];
  });
  return {
    custom,
    wordbook: normalizeWordbook(data.wordbook).filter(item => data.version >= 6 || item.wrong > 0),
    favorites: data.version >= 6 ? normalizeWordbook(data.favorites) : normalizeWordbook(data.wordbook).filter(item => item.categories.length || !item.wrong),
    wordstats: restoreHistoricalLearning(normalizeWordStats(data.wordstats), nonNegativeInt(data.version)),
    stats: normalizeStats(data.stats),
    settings: normalizeSettings(data.settings),
  };
}

/* ---------- 启动 ---------- */
init();
