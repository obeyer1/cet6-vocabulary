/* =========================================================
 * 六级背单词 App - 前端逻辑（无任何第三方依赖）
 * ========================================================= */
"use strict";

/* ---------- 存储 ---------- */
const LS = {
  custom: "cet6_custom_words",
  wordbook: "cet6_wordbook",
  wordstats: "cet6_wordstats",
  stats: "cet6_stats",
  settings: "cet6_settings",
};
const DATA_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];
const QUIZ_STAGES = ["选择", "听写", "拼写"];
const isWrittenMode = () => q.mode === "spell" || q.mode === "dictation";
let wordAudio = null;
let speechRequest = 0;
function stopSpeech() {
  speechRequest++;
  if (wordAudio) {
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
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

/* ---------- 全局状态 ---------- */
let WORDS = [];            // 全部单词（内置 + 自定义）
let BYWORD = new Map();    // word -> entry
let BUILTIN = [];          // 内置词库
let CUSTOM = [];           // 自定义单词
let WB = [];               // 单词本 [{word, addedAt, status, wrong, right, lastAt}]
let WSTATS = {};           // { word: {seen, right, wrong} }
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
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
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
      wrong: nonNegativeInt(item.wrong),
      right: nonNegativeInt(item.right),
      lastAt: nonNegativeInt(item.lastAt) || Date.now(),
    }];
  });
}

function normalizeWordStats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
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
    };
  }
  return result;
}

function normalizeStats(value) {
  const result = { total: { seen: 0, right: 0, wrong: 0 }, daily: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const total = value.total && typeof value.total === "object" ? value.total : {};
  result.total = { seen: nonNegativeInt(total.seen), right: nonNegativeInt(total.right), wrong: nonNegativeInt(total.wrong) };
  if (value.daily && typeof value.daily === "object" && !Array.isArray(value.daily)) {
    for (const [date, raw] of Object.entries(value.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !raw || typeof raw !== "object") continue;
      result.daily[date] = { seen: nonNegativeInt(raw.seen), right: nonNegativeInt(raw.right), wrong: nonNegativeInt(raw.wrong) };
    }
  }
  return result;
}

function normalizeSettings(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    dailyGoal: Math.max(5, Math.min(500, nonNegativeInt(raw.dailyGoal) || 20)),
    autoAddWrong: raw.autoAddWrong !== false,
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
  if (!STATS.daily[key]) STATS.daily[key] = { seen: 0, right: 0, wrong: 0 };
  return STATS.daily[key];
}
function recordAnswer(word, ok) {
  word = wordKey(word);
  const ws = WSTATS[word] || (WSTATS[word] = { seen: 0, right: 0, wrong: 0, streak: 0, interval: 0, nextReviewAt: 0, lastAt: 0 });
  ws.seen++; ok ? ws.right++ : ws.wrong++;
  ws.lastAt = Date.now();
  if (ok) {
    ws.streak = nonNegativeInt(ws.streak) + 1;
    ws.interval = REVIEW_INTERVALS[Math.min(ws.streak - 1, REVIEW_INTERVALS.length - 1)];
    ws.nextReviewAt = ws.lastAt + ws.interval * DAY_MS;
  } else {
    ws.streak = 0;
    ws.interval = 0;
    ws.nextReviewAt = ws.lastAt + 10 * 60 * 1000;
  }
  STATS.total.seen++; ok ? STATS.total.right++ : STATS.total.wrong++;
  const t = todayStats(); t.seen++; ok ? t.right++ : t.wrong++;
  const wb = WB.find((x) => x.word === word);
  if (wb) { wb.right += ok ? 1 : 0; wb.wrong += ok ? 0 : 1; wb.lastAt = Date.now(); }
  save(LS.wordbook, WB);
  save(LS.wordstats, WSTATS);
  save(LS.stats, STATS);
  updateGoal();
}

/* ---------- 初始化 ---------- */
async function init() {
  const storedCustom = load(LS.custom, []);
  WB = normalizeWordbook(load(LS.wordbook, []));
  WSTATS = normalizeWordStats(load(LS.wordstats, {}));
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
  persist();
  bindEvents();
  renderGoal();
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
  if (scope === "learned") pool = pool.filter((w) => WSTATS[wordKey(w.word)]?.seen > 0);
  if (scope === "new") pool = pool.filter((w) => !WSTATS[w.word.toLowerCase()] || WSTATS[w.word.toLowerCase()].seen === 0);
  if (scope === "wrong") pool = pool.filter((w) => { const s = WSTATS[w.word.toLowerCase()]; return s && s.wrong > 0; });
  if (scope === "wordbook") {
    const set = new Set(WB.map((x) => x.word.toLowerCase()));
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
  Object.assign(q, { words: q.pool.slice(), choiceMode: mode === "zh2en" ? "zh2en" : "en2zh", stage: 0, retryRound: 0, retryWords: [], attempts: 0 });
  QUIZ_ACTIVE = false;
  showView("study");
  $("#studySetup").classList.add("hidden");
  $("#studySummary").classList.add("hidden");
  $("#studyQuiz").classList.add("hidden");
  $("#studyPreview").classList.remove("hidden");
  const returnLabel = q.returnContext.view === "learned" ? "已学单词" : q.returnContext.view === "wordbook" ? "单词本" : "学习设置";
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

  if (isWrittenMode()) {
    const dictation = q.mode === "dictation";
    $("#quizWord").textContent = dictation ? "听读音，写单词" : w.meaning;
    $("#quizPhonetic").textContent = "";
    $("#quizMeaning").textContent = dictation ? "" : w.meaning;
    const opts = $("#quizOptions");
    opts.innerHTML = `
      <div class="spell-box">
        <input type="text" id="spellInput" aria-label="输入英文单词" placeholder="输入英文单词…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn primary" id="spellSubmit">确认</button>
      </div>
      ${dictation ? '<div class="spell-tools muted">未听清可点击上方按钮重听</div>' : '<div class="spell-tools"><button class="btn ghost small" id="spellHint">💡 音标提示</button></div>'}`;
    const input = $("#spellInput");
    input.focus();
    const submit = () => { if (!q.answered) submitSpell(); };
    $("#spellSubmit").onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    if (dictation) {
      speak.classList.remove("hidden");
      speak.textContent = "🔊 播放读音";
      speak.onclick = () => speakWord(w.word);
      speakWord(w.word);
    } else {
      $("#spellHint").onclick = () => { $("#quizPhonetic").textContent = w.phonetic ? w.phonetic : "（暂无音标）"; };
    }
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
  audio.src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
  // Loading failures must not leave a listening question silently stuck.
  let timeout;
  try {
    await Promise.race([
      audio.play(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("audio timeout")), 8000); }),
    ]);
  } catch (error) {
    if (request !== speechRequest) return;
    stopSpeech();
    if (error.name === "NotAllowedError") {
      notify("请点击「播放读音」开始播放。", "error");
      return;
    }
    notify("词典音频暂时不可用，已切换为系统英文语音。", "error");
    speakSystemWord(word);
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

function submitSpell() {
  if (q.answered) return;
  q.answered = true;
  const w = q.pool[q.idx];
  const typed = $("#spellInput").value;
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s\-\u0027\u2019]/g, "");
  const ok = norm(typed) === norm(w.word);
  const input = $("#spellInput");
  input.classList.add(ok ? "correct" : "wrong");
  input.disabled = true;
  $("#spellSubmit").disabled = true;
  answerFeedback(w, ok, typed);
}

function answerCard(ok) {
  if (q.answered) return;
  q.answered = true;
  const w = q.pool[q.idx];
  $("#quizMeaning").classList.remove("hidden");
  answerFeedback(w, ok, null);
}

function answerFeedback(w, ok, chosen) {
  q.attempts++;
  if (!ok) q.retryWords.push(w);
  if (!ok && SETTINGS.autoAddWrong) addToWordbook(w);
  recordAnswer(wordKey(w.word), ok);
  const fb = $("#quizFeedback");
  const meaning = q.mode === "dictation" ? "" : esc(w.meaning);
  if (ok) {
    q.correct++;
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
    if (!q.wrongList.some((entry) => wordKey(entry.word) === wordKey(w.word))) q.wrongList.push(w);
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
  if (q.idx + 1 < q.pool.length) { nextQuestion(); return; }
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
  const auto = !!SETTINGS.autoAddWrong;
  if (q.wrongList.length) {
    const chips = q.wrongList.map((w) => auto
      ? `<span class="chip">${esc(w.word)}<button title="移除" data-rm="${esc(w.word.toLowerCase())}">✕</button></span>`
      : `<span class="chip">${esc(w.word)}</span>`).join("");
    box.innerHTML = `<h4>本次曾答错 ${q.wrongList.length} 个，现已补测通过${auto ? "（已加入单词本）" : ""}：</h4>` + chips;
    if (auto) {
      box.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { removeFromWordbook(b.dataset.rm); b.parentElement.remove(); }));
    }
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

function returnToSource() {
  const context = q.returnContext || { view: "study", scrollY: 0 };
  backToSetup();
  showView(context.view);
  window.scrollTo({ top: context.scrollY, behavior: "instant" });
}

/* ---------- 单词本 ---------- */
function addToWordbook(entry) {
  const key = wordKey(entry.word);
  if (WB.some((x) => x.word === key)) return false;
  WB.push({ word: key, addedAt: Date.now(), status: "learning", wrong: 0, right: 0, lastAt: Date.now() });
  save(LS.wordbook, WB);
  return true;
}
function removeFromWordbook(word) {
  const key = wordKey(word);
  WB = WB.filter((x) => x.word !== key);
  save(LS.wordbook, WB);
}
function setWbStatus(word, status) {
  const x = WB.find((e) => e.word === word);
  if (x) x.status = status;
  save(LS.wordbook, WB);
}

function renderWordbook() {
  $("#wbCount").textContent = `${WB.length} 个单词`;
  const kw = $("#wbSearch").value.trim().toLowerCase();
  const flt = $("#wbFilter").value;
  const sort = $("#wbSort").value;
  let list = WB.slice();
  if (flt !== "all") list = list.filter((x) => x.status === flt);
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
  const box = $("#wbList");
  const empty = $("#wbEmpty");
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
        <div class="muted">错 ${x.wrong} · 对 ${x.right} · ${esc(reviewLabel(WSTATS[x.word]))}</div>
      </div>
      <div class="item-actions">
        ${badge}
        <button class="mini-btn" data-speak="${esc(e.word)}" aria-label="朗读 ${esc(e.word)}">🔊</button>
        <button class="mini-btn" data-wb-toggle="${esc(x.word)}" data-wb-cur="${x.status}">${x.status === "mastered" ? "转学习中" : "标为掌握"}</button>
        <button class="mini-btn danger" data-wb-rm="${esc(x.word)}">移除</button>
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-wb-toggle]").forEach((b) => (b.onclick = () => { setWbStatus(b.dataset.wbToggle, b.dataset.wbCur === "mastered" ? "learning" : "mastered"); renderWordbook(); }));
  box.querySelectorAll("[data-wb-rm]").forEach((b) => (b.onclick = () => { removeFromWordbook(b.dataset.wbRm); renderWordbook(); }));
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
let learnedShown = 100;
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

function reviewWordbook() {
  const available = buildPool("wordbook").length;
  const count = resolveReviewCount("wb", available);
  if (count == null) return;
  startQuiz("en2zh", "wordbook", count);
}

function renderLearned() {
  const total = buildPool("learned").length;
  const list = learnedWords();
  $("#learnedCount").textContent = `共 ${total} 个 · 当前 ${list.length} 个`;
  $("#learnedReview").disabled = list.length === 0;
  $("#learnedEmpty").classList.toggle("hidden", list.length > 0);
  $("#learnedEmptyTitle").textContent = total ? "没有符合条件的单词" : "还没有已学单词";
  $("#learnedEmptyHint").textContent = total ? "试试其他关键词或筛选条件。" : "完成一次作答后，单词就会出现在这里。";
  const box = $("#learnedList");
  box.innerHTML = list.slice(0, learnedShown).map((entry) => {
    const stats = WSTATS[wordKey(entry.word)];
    const lastAt = stats.lastAt ? new Date(stats.lastAt).toLocaleDateString("zh-CN") : "暂无记录";
    return `<div class="item">
      <div class="item-main">
        <div><span class="item-word">${esc(entry.word)}</span><span class="item-phonetic">${esc(entry.phonetic)}</span></div>
        <div class="item-meaning">${esc(entry.meaning)}</div>
        <div class="muted">已练 ${stats.seen} 次 · 对 ${stats.right} · 错 ${stats.wrong} · ${esc(reviewLabel(stats))}</div>
        <div class="muted">最近学习：${esc(lastAt)}</div>
      </div>
      <div class="item-actions">
        <button class="mini-btn" data-learned-speak="${esc(entry.word)}" aria-label="朗读 ${esc(entry.word)}">🔊</button>
        <button class="mini-btn" data-learned-review="${esc(wordKey(entry.word))}">复习此词</button>
      </div>
    </div>`;
  }).join("");
  if (list.length > learnedShown) {
    box.insertAdjacentHTML("beforeend", `<button class="btn small" id="learnedMore">显示更多（还剩 ${list.length - learnedShown} 个）</button>`);
    $("#learnedMore").onclick = () => { learnedShown += 100; renderLearned(); };
  }
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
    const inWb = WB.some((x) => x.word === key);
    const isCustom = customSet.has(key);
    const custom = isCustom ? `<span class="badge new">自定义</span>` : "";
    const addBtn = inWb
      ? `<button class="mini-btn added" disabled>✓ 已收藏</button>`
      : `<button class="mini-btn" data-gl-add="${esc(w.word)}">+ 收藏</button>`;
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
  box.querySelectorAll("[data-gl-add]").forEach((b) => (b.onclick = () => { const e = BYWORD.get(wordKey(b.dataset.glAdd)); if (e) { addToWordbook(e); renderGlossary(); } }));
  box.querySelectorAll("[data-speak]").forEach((b) => (b.onclick = () => speakWord(b.dataset.speak)));
  box.querySelectorAll("[data-custom-edit]").forEach((b) => (b.onclick = () => editCustomWord(b.dataset.customEdit)));
  box.querySelectorAll("[data-custom-rm]").forEach((b) => (b.onclick = () => deleteCustomWord(b.dataset.customRm)));
}

/* ---------- 统计 ---------- */
function renderStats() {
  const uniqueSeen = Object.values(WSTATS).filter((item) => item.seen > 0).length;
  const total = STATS.total;
  const acc = total.right + total.wrong > 0 ? Math.round((total.right / (total.right + total.wrong)) * 100) : 0;
  const mastered = WB.filter((x) => x.status === "mastered").length;
  const due = buildPool("due").length;
  const today = todayStats().seen;
  $("#statGrid").innerHTML = `
    <div class="stat-card"><div class="num">${uniqueSeen}</div><div class="lbl">累计学过单词</div></div>
    <div class="stat-card"><div class="num">${today}</div><div class="lbl">今日已学</div></div>
    <div class="stat-card"><div class="num">${acc}%</div><div class="lbl">总正确率</div></div>
    <div class="stat-card"><div class="num">${due}</div><div class="lbl">今日待复习</div></div>
    <div class="stat-card"><div class="num">${WB.length}</div><div class="lbl">单词本 / 已掌握 ${mastered}</div></div>`;
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
  $("#setAutoAdd").checked = !!SETTINGS.autoAddWrong;
  $("#importText").value = "";
}

/* ---------- 目标徽章 ---------- */
function renderGoal() { updateGoal(); }
function updateGoal() {
  const t = todayStats().seen;
  const g = SETTINGS.dailyGoal;
  const badge = $("#goalBadge");
  badge.textContent = `今日 ${t}/${g}`;
  const done = t >= g;
  badge.classList.toggle("done", done);
}

/* ---------- 持久化 ---------- */
function persist() {
  save(LS.custom, CUSTOM);
  save(LS.wordbook, WB);
  save(LS.wordstats, WSTATS);
  save(LS.stats, STATS);
  save(LS.settings, SETTINGS);
}

/* ---------- 题目数量 ---------- */
function resolveQuizCount() {
  const sel = $("#quizCount").value;
  if (sel === "custom") {
    const v = Math.floor(Number($("#quizCountCustom").value));
    return (v && v >= 1) ? v : null;
  }
  return Number(sel);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
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
    if (count == null) { notify("请输入有效的自定义题目数量（至少 1 题）。", "error"); return; }
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
  const refreshLearned = () => { learnedShown = 100; renderLearned(); };
  $("#learnedSearch").oninput = refreshLearned;
  $("#learnedFilter").onchange = refreshLearned;
  $("#learnedSort").onchange = refreshLearned;
  $("#learnedReview").onclick = reviewLearned;
  bindReviewCount("learned");

  // 单词本
  $("#wbSearch").oninput = renderWordbook;
  $("#wbFilter").onchange = renderWordbook;
  $("#wbSort").onchange = renderWordbook;
  $("#wbReview").onclick = reviewWordbook;
  bindReviewCount("wb");

  // 词表
  $("#glSearch").oninput = () => { glShown = 200; renderGlossary(); };

  // 设置
  $("#saveGoal").onclick = () => {
    const v = Math.max(5, Math.min(500, Number($("#setGoal").value) || 20));
    SETTINGS.dailyGoal = v;
    persist(); updateGoal(); notify(`每日目标已设为 ${v} 题`);
  };
  $("#setAutoAdd").onchange = () => { SETTINGS.autoAddWrong = $("#setAutoAdd").checked; persist(); };
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
  document.addEventListener("keydown", (e) => {
    if (!QUIZ_ACTIVE || !$("#view-study").classList.contains("active") || $("#studyQuiz").classList.contains("hidden")) return;
    if (q.mode === "card") return;
    const typingInSpell = isWrittenMode() && e.target && e.target.id === "spellInput";
    const optionKey = /^[1-4]$/.test(e.key) ? Number(e.key) - 1 : "abcd".indexOf(e.key.toLowerCase());
    if (!q.answered && !typingInSpell && optionKey >= 0) {
      const i = optionKey;
      if (i < q.options.length) answer(i);
    } else if (q.answered && (e.key === "Enter" || e.key === " ") && !typingInSpell) {
      e.preventDefault();
      const nb = $("#quizNext");
      if (!nb.classList.contains("hidden")) nb.click();
    }
  });
}

/* ---------- 自定义单词 / 导入 ---------- */
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
  if (newKey !== key) {
    WB.forEach((item) => { if (item.word === key) item.word = newKey; });
    if (WSTATS[key]) { WSTATS[newKey] = WSTATS[key]; delete WSTATS[key]; }
  }
  rebuildWords();
  persist();
  closeWordDialog();
  renderGlossary();
  notify(`已保存 ${entry.word}`);
}

function deleteCustomWord(rawKey) {
  const key = wordKey(rawKey);
  const entry = CUSTOM.find((item) => wordKey(item.word) === key);
  if (!entry || !confirm(`确定删除自定义单词“${entry.word}”？相关学习记录也会删除。`)) return;
  CUSTOM = CUSTOM.filter((item) => wordKey(item.word) !== key);
  WB = WB.filter((item) => item.word !== key);
  delete WSTATS[key];
  rebuildWords();
  persist();
  renderGlossary();
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
      CUSTOM = imported.custom;
      rebuildWords();
      const validWords = new Set(WORDS.map((entry) => wordKey(entry.word)));
      WB = imported.wordbook.filter((item) => validWords.has(item.word));
      WSTATS = Object.fromEntries(Object.entries(imported.wordstats).filter(([word]) => validWords.has(word)));
      STATS = imported.stats;
      SETTINGS = imported.settings;
      persist();
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
    wordbook: normalizeWordbook(data.wordbook),
    wordstats: normalizeWordStats(data.wordstats),
    stats: normalizeStats(data.stats),
    settings: normalizeSettings(data.settings),
  };
}

/* ---------- 启动 ---------- */
init();
