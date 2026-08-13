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

function clearQuizTimer() {
  if (quizTimer) { clearTimeout(quizTimer); quizTimer = null; }
}

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sample = (arr, n) => shuffle(arr).slice(0, n);

function todayStats() {
  const key = todayStr();
  if (!STATS.daily[key]) STATS.daily[key] = { seen: 0, right: 0, wrong: 0 };
  return STATS.daily[key];
}
function recordAnswer(word, ok) {
  const ws = WSTATS[word] || (WSTATS[word] = { seen: 0, right: 0, wrong: 0 });
  ws.seen++; ok ? ws.right++ : ws.wrong++;
  STATS.total.seen++; ok ? STATS.total.right++ : STATS.total.wrong++;
  const t = todayStats(); t.seen++; ok ? t.right++ : t.wrong++;
  const wb = WB.find((x) => x.word === word);
  if (wb) { wb.right += ok ? 1 : 0; wb.wrong += ok ? 0 : 1; wb.lastAt = Date.now(); }
  persist();
  updateGoal();
}

/* ---------- 初始化 ---------- */
async function init() {
  CUSTOM = load(LS.custom, []);
  WB = load(LS.wordbook, []);
  WSTATS = load(LS.wordstats, {});
  STATS = load(LS.stats, { total: { seen: 0, right: 0, wrong: 0 }, daily: {} });
  SETTINGS = load(LS.settings, { dailyGoal: 20, autoAddWrong: true });

  let builtin = [];
  try {
    const res = await fetch("/data/words.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    builtin = await res.json();
  } catch (e) {
    showFatal("无法加载词库。请通过「启动背单词.command」启动本应用（而不是直接双击 index.html）。");
    return;
  }
  BUILTIN = builtin;
  WORDS = BUILTIN.concat(CUSTOM);
  BYWORD = new Map(WORDS.map((w) => [w.word.toLowerCase(), w]));
  bindEvents();
  renderGoal();
  showView("study");
}

function showFatal(msg) {
  document.body.innerHTML = `<div style="max-width:560px;margin:80px auto;padding:24px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.1);font-family:-apple-system,sans-serif">
    <h2 style="margin-top:0">⚠️ ${esc(msg)}</h2></div>`;
}

/* ---------- 导航 ---------- */
function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "wordbook") renderWordbook();
  if (name === "glossary") renderGlossary();
  if (name === "stats") renderStats();
  if (name === "settings") renderSettings();
}

/* ---------- 学习 ---------- */
function buildPool(scope) {
  let pool = WORDS.slice();
  if (scope === "new") pool = pool.filter((w) => !WSTATS[w.word.toLowerCase()] || WSTATS[w.word.toLowerCase()].seen === 0);
  if (scope === "wrong") pool = pool.filter((w) => { const s = WSTATS[w.word.toLowerCase()]; return s && s.wrong > 0; });
  if (scope === "wordbook") {
    const set = new Set(WB.map((x) => x.word.toLowerCase()));
    pool = pool.filter((w) => set.has(w.word.toLowerCase()));
  }
  return pool;
}

function startQuiz(mode, scope, count, explicitPool) {
  clearQuizTimer();
  const pool = shuffle(explicitPool ? explicitPool : buildPool(scope));
  if (pool.length === 0) { alert("当前范围没有可学习的单词，换个范围试试～"); return; }
  const n = Math.min(count, pool.length);
  if (n < 1) { alert("题目数量不正确，请重新选择。"); return; }
  Object.assign(q, { mode, pool: pool.slice(0, n), idx: 0, correct: 0, wrongList: [], options: [], answered: false });
  QUIZ_ACTIVE = true;
  $("#studySetup").classList.add("hidden");
  $("#studySummary").classList.add("hidden");
  $("#studyQuiz").classList.remove("hidden");
  renderQuestion();
}

function renderQuestion() {
  const w = q.pool[q.idx];
  q.answered = false;
  q.options = [];
  $("#quizNext").classList.add("hidden");
  $("#quizFeedback").classList.add("hidden");
  $("#quizFeedback").className = "feedback hidden";
  $("#quizMeaning").classList.add("hidden");
  $("#quizProgressText").textContent = `第 ${q.idx + 1} / ${q.pool.length} 题`;
  $("#quizProgressBar").style.width = `${(q.idx / q.pool.length) * 100}%`;

  const card = $("#quizCard");
  card.classList.remove("revealed");

  if (q.mode === "spell") {
    $("#quizWord").textContent = w.meaning;
    $("#quizPhonetic").textContent = "";
    $("#quizMeaning").textContent = w.meaning;
    const opts = $("#quizOptions");
    opts.innerHTML = `
      <div class="spell-box">
        <input type="text" id="spellInput" placeholder="输入英文单词…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn primary" id="spellSubmit">确认</button>
      </div>
      <div class="spell-tools">
        <button class="btn ghost small" id="spellHint">💡 音标提示</button>
      </div>`;
    const input = $("#spellInput");
    input.focus();
    const submit = () => { if (!q.answered) submitSpell(); };
    $("#spellSubmit").onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    $("#spellHint").onclick = () => { $("#quizPhonetic").textContent = w.phonetic ? w.phonetic : "（暂无音标）"; };
    return;
  }

  if (q.mode === "card") {
    $("#quizWord").textContent = w.word;
    $("#quizPhonetic").textContent = w.phonetic;
    $("#quizMeaning").textContent = w.meaning;
    card.onclick = () => { $("#quizMeaning").classList.remove("hidden"); card.classList.add("revealed"); };
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
  } else {
    $("#quizWord").textContent = w.meaning;
    $("#quizPhonetic").textContent = "";
    q.options = buildOptions(w, "word");
  }
  renderOptions();
}

function buildOptions(correctEntry, type) {
  const others = WORDS.filter((w) => w.word.toLowerCase() !== correctEntry.word.toLowerCase());
  const distract = sample(others, 3);
  const opts = [correctEntry];
  for (const d of distract) {
    if (type === "meaning") {
      if (!opts.some((o) => o.meaning === d.meaning)) opts.push(d);
    } else {
      if (!opts.some((o) => o.word === d.word)) opts.push(d);
    }
  }
  return shuffle(opts);
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
  const ok = chosen.word.toLowerCase() === w.word.toLowerCase();
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
  recordAnswer(w.word.toLowerCase(), ok);
  const fb = $("#quizFeedback");
  const isEn2Zh = q.mode === "en2zh";
  if (ok) {
    q.correct++;
    fb.className = "feedback ok";
    fb.innerHTML = `✅ 回答正确！<span class="fb-word">${esc(w.word)}</span> ${esc(w.phonetic)}<br>${esc(w.meaning)}`;
    if (q.mode !== "card" && q.mode !== "spell") {
      const btns = $$("#quizOptions .option");
      btns.forEach((b, idx) => {
        if (q.options[idx].word.toLowerCase() === w.word.toLowerCase()) b.classList.add("correct");
        b.disabled = true;
      });
    }
  } else {
    q.wrongList.push(w);
    fb.className = "feedback no";
    const typedNote = q.mode === "spell" && chosen ? ` 你输入的是「${esc(chosen)}」<br>` : "";
    fb.innerHTML = `❌ 答错了。正确答案是 <span class="fb-word">${esc(w.word)}</span> ${esc(w.phonetic)}<br>${typedNote}${esc(w.meaning)}`;
    if (q.mode !== "card" && q.mode !== "spell") {
      const btns = $$("#quizOptions .option");
      btns.forEach((b, idx) => {
        if (q.options[idx].word.toLowerCase() === w.word.toLowerCase()) b.classList.add("correct");
        else if (chosen && q.options[idx].word.toLowerCase() === chosen.word.toLowerCase()) b.classList.add("wrong");
        b.disabled = true;
      });
    }
    if (SETTINGS.autoAddWrong) addToWordbook(w, true);
  }
  const nextBtn = $("#quizNext");
  if (q.mode === "card") {
    // 卡片模式：不显示「下一题」按钮，答完自动进入下一题
    nextBtn.classList.add("hidden");
    clearQuizTimer();
    quizTimer = setTimeout(() => {
      quizTimer = null;
      if (!QUIZ_ACTIVE) return;
      advance();
    }, 900);
  } else {
    nextBtn.textContent = q.idx + 1 >= q.pool.length ? "查看结果 🎉" : "下一题 →";
    nextBtn.classList.remove("hidden");
    nextBtn.onclick = advance;
  }
}

function nextQuestion() {
  q.idx++;
  renderQuestion();
}

function advance() {
  if (q.idx + 1 >= q.pool.length) finishQuiz();
  else nextQuestion();
}

function finishQuiz() {
  QUIZ_ACTIVE = false;
  clearQuizTimer();
  $("#studyQuiz").classList.add("hidden");
  const s = $("#studySummary");
  s.classList.remove("hidden");
  const total = q.pool.length;
  const acc = Math.round((q.correct / total) * 100);
  $("#summaryTitle").textContent = acc >= 90 ? "🎉 太棒了！" : acc >= 60 ? "👍 继续加油！" : "💪 再练练吧";
  $("#summaryStats").innerHTML = `
    <div class="summary-stat"><div class="num" style="color:var(--good)">${q.correct}</div><div class="lbl">答对</div></div>
    <div class="summary-stat"><div class="num" style="color:var(--bad)">${total - q.correct}</div><div class="lbl">答错</div></div>
    <div class="summary-stat"><div class="num">${acc}%</div><div class="lbl">正确率</div></div>`;
  const box = $("#summaryWrong");
  const auto = !!SETTINGS.autoAddWrong;
  if (q.wrongList.length) {
    const chips = q.wrongList.map((w) => auto
      ? `<span class="chip">${esc(w.word)}<button title="移除" data-rm="${esc(w.word.toLowerCase())}">✕</button></span>`
      : `<span class="chip">${esc(w.word)}</span>`).join("");
    box.innerHTML = `<h4>❌ 错词（${q.wrongList.length} 个${auto ? "，已自动加入单词本" : ""}）：</h4>` + chips;
    if (auto) {
      box.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { removeFromWordbook(b.dataset.rm); b.parentElement.remove(); }));
    }
  } else {
    box.innerHTML = "";
  }
  const mode = q.mode;
  $("#summaryRetry").onclick = () => { if (q.wrongList.length) startQuiz(mode, "wordbook", q.wrongList.length, q.wrongList.slice()); else alert("没有错词啦～"); };
  $("#summaryAgain").onclick = () => backToSetup();
  $("#summaryHome").onclick = () => backToSetup();
  updateGoal();
}

function backToSetup() {
  QUIZ_ACTIVE = false;
  clearQuizTimer();
  $("#studyQuiz").classList.add("hidden");
  $("#studySummary").classList.add("hidden");
  $("#studySetup").classList.remove("hidden");
}

/* ---------- 单词本 ---------- */
function wbStatus(word) { const x = WB.find((e) => e.word === word); return x ? x.status : null; }

function addToWordbook(entry, auto) {
  const key = entry.word.toLowerCase();
  if (WB.some((x) => x.word === key)) return false;
  WB.push({ word: key, addedAt: Date.now(), status: "learning", wrong: 0, right: 0, lastAt: Date.now() });
  persist();
  return true;
}
function removeFromWordbook(word) {
  const key = String(word).toLowerCase();
  WB = WB.filter((x) => x.word !== key);
  persist();
}
function setWbStatus(word, status) {
  const x = WB.find((e) => e.word === word);
  if (x) x.status = status;
  persist();
}

function renderWordbook() {
  $("#wbCount").textContent = `${WB.length} 个单词`;
  const kw = $("#wbSearch").value.trim().toLowerCase();
  const flt = $("#wbFilter").value;
  let list = WB.slice();
  if (flt !== "all") list = list.filter((x) => x.status === flt);
  if (kw) {
    list = list.filter((x) => {
      const e = BYWORD.get(x.word);
      return x.word.includes(kw) || (e && (e.meaning || "").toLowerCase().includes(kw));
    });
  }
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
      </div>
      <div class="item-actions">
        ${badge}
        <button class="mini-btn" data-wb-toggle="${esc(x.word)}" data-wb-cur="${x.status}">${x.status === "mastered" ? "转学习中" : "标为掌握"}</button>
        <button class="mini-btn danger" data-wb-rm="${esc(x.word)}">移除</button>
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-wb-toggle]").forEach((b) => (b.onclick = () => { setWbStatus(b.dataset.wbToggle, b.dataset.wbCur === "mastered" ? "learning" : "mastered"); renderWordbook(); }));
  box.querySelectorAll("[data-wb-rm]").forEach((b) => (b.onclick = () => { removeFromWordbook(b.dataset.wbRm); renderWordbook(); }));
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
    const custom = customSet.has(key) ? `<span class="badge new">自定义</span>` : "";
    const addBtn = inWb
      ? `<button class="mini-btn added" disabled>✓ 已收藏</button>`
      : `<button class="mini-btn" data-gl-add="${esc(w.word)}">+ 收藏</button>`;
    return `<div class="item">
      <div class="item-main">
        <div><span class="item-word">${esc(w.word)}</span>${w.phonetic ? `<span class="item-phonetic">${esc(w.phonetic)}</span>` : ""} ${custom}</div>
        <div class="item-meaning">${esc(w.meaning)}</div>
      </div>
      <div class="item-actions">${addBtn}</div>
    </div>`;
  }).join("");
  if (list.length > glShown) {
    box.insertAdjacentHTML("beforeend", `<button class="btn small" id="glMore">显示更多（还剩 ${list.length - glShown} 个）</button>`);
    $("#glMore").onclick = () => { glShown += 200; renderGlossary(); };
  }
  box.querySelectorAll("[data-gl-add]").forEach((b) => (b.onclick = () => { const e = BYWORD.get(b.dataset.glAdd.toLowerCase()); if (e) { addToWordbook(e, false); renderGlossary(); } }));
}

/* ---------- 统计 ---------- */
function renderStats() {
  const uniqueSeen = Object.keys(WSTATS).length;
  const total = STATS.total;
  const acc = total.right + total.wrong > 0 ? Math.round((total.right / (total.right + total.wrong)) * 100) : 0;
  const mastered = WB.filter((x) => x.status === "mastered").length;
  const today = todayStats().seen;
  $("#statGrid").innerHTML = `
    <div class="stat-card"><div class="num">${uniqueSeen}</div><div class="lbl">累计学过单词</div></div>
    <div class="stat-card"><div class="num">${today}</div><div class="lbl">今日已学</div></div>
    <div class="stat-card"><div class="num">${acc}%</div><div class="lbl">总正确率</div></div>
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
  $("#goalBadge").textContent = `今日 ${t}/${g}`;
  const done = t >= g;
  $("#goalBadge").style.background = done ? "#d1fae5" : "#fff";
  $("#goalBadge").style.color = done ? "#065f46" : "var(--primary-dark)";
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
    $$(".mode-card").forEach((x) => x.classList.toggle("selected", x === c));
  }));
  $$(".mode-card")[0].classList.add("selected");
  $("#quizCount").onchange = () => {
    const isCustom = $("#quizCount").value === "custom";
    $("#quizCountCustom").classList.toggle("hidden", !isCustom);
    if (isCustom) $("#quizCountCustom").focus();
  };
  $("#startQuiz").onclick = () => {
    const count = resolveQuizCount();
    if (count == null) { alert("请输入有效的自定义题目数量（至少 1 题）。"); return; }
    startQuiz(chosenMode, $("#quizScope").value, count);
  };
  $("#quizQuit").onclick = () => { if (confirm("确定结束本组学习？")) backToSetup(); };

  // 单词本
  $("#wbSearch").oninput = renderWordbook;
  $("#wbFilter").onchange = renderWordbook;
  $("#wbReview").onclick = () => startQuiz("en2zh", "wordbook", Math.min(20, WB.length || 1));

  // 词表
  $("#glSearch").oninput = () => { glShown = 200; renderGlossary(); };

  // 设置
  $("#saveGoal").onclick = () => {
    const v = Math.max(5, Math.min(500, Number($("#setGoal").value) || 20));
    SETTINGS.dailyGoal = v;
    persist(); updateGoal(); alert(`每日目标已设为 ${v} 题`);
  };
  $("#setAutoAdd").onchange = () => { SETTINGS.autoAddWrong = $("#setAutoAdd").checked; persist(); };
  $("#addWordBtn").onclick = addCustomWord;
  $("#importBtn").onclick = importWords;
  $("#exportBtn").onclick = exportData;
  $("#importDataInput").onchange = importData;
  $("#resetBtn").onclick = () => {
    if (confirm("确定清空所有学习数据？此操作不可恢复！")) {
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      location.reload();
    }
  };

  // 键盘
  document.addEventListener("keydown", (e) => {
    if (!QUIZ_ACTIVE || $("#studyQuiz").classList.contains("hidden")) return;
    if (q.mode === "card") return;
    const typingInSpell = q.mode === "spell" && e.target && e.target.id === "spellInput";
    if (!q.answered && /^[1-4]$/.test(e.key)) {
      const i = Number(e.key) - 1;
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
  const m = line.match(/^([A-Za-z][A-Za-z'\- ]*?)\s*(?:\[([^\]]*)\])?\s*(.+)$/);
  if (!m) return null;
  const word = m[1].trim().split(/\s+/)[0];
  const phonetic = (m[2] || "").trim();
  const meaning = (m[3] || "").trim();
  if (!word || !meaning) return null;
  return { word, phonetic, meaning };
}

function addCustomWord() {
  const word = $("#addWord").value.trim();
  const phonetic = $("#addPhonetic").value.trim();
  const meaning = $("#addMeaning").value.trim();
  if (!word || !meaning) { alert("请填写单词和释义。"); return; }
  const key = word.toLowerCase();
  if (BYWORD.has(key)) { alert("这个词已存在词库中。"); return; }
  const entry = { word, phonetic, meaning };
  CUSTOM.push(entry);
  WORDS.push(entry);
  BYWORD.set(key, entry);
  persist();
  $("#addWord").value = $("#addPhonetic").value = $("#addMeaning").value = "";
  alert(`已添加：${word}（自定义词会参与学习）`);
}

function importWords() {
  const text = $("#importText").value;
  let ok = 0, skip = 0;
  for (const line of text.split("\n")) {
    const e = parseEntryLine(line);
    if (!e) { skip++; continue; }
    const key = e.word.toLowerCase();
    if (BYWORD.has(key)) { skip++; continue; }
    CUSTOM.push(e); WORDS.push(e); BYWORD.set(key, e); ok++;
  }
  persist();
  renderGlossary();
  alert(`导入完成：成功 ${ok} 个，跳过 ${skip} 个（重复或格式不对）。`);
}

/* ---------- 数据备份 ---------- */
function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    words: WORDS,
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
      if (d.wordbook) WB = d.wordbook;
      if (d.wordstats) WSTATS = d.wordstats;
      if (d.stats) STATS = d.stats;
      if (d.settings) SETTINGS = { dailyGoal: 20, autoAddWrong: true, ...d.settings };
      if (d.custom && Array.isArray(d.custom)) {
        CUSTOM = d.custom;
        WORDS = BUILTIN.concat(CUSTOM);
        BYWORD = new Map(WORDS.map((w) => [w.word.toLowerCase(), w]));
      }
      persist();
      alert("学习数据已导入！");
      showView("stats");
    } catch (err) {
      alert("导入失败：文件格式不正确。");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}

/* ---------- 启动 ---------- */
init();
