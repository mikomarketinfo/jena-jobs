(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("jj_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("jj_" + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem("jj_" + k); } catch { /* ignore */ } },
  };

  const FALLBACK_FILTERS = {
    keywords: [], exclude: [], radius_km: 30, show_job: true, show_ausbildung: true,
    minijob: "include", worktime: ["vz", "tz", "mj", "snw", "praktikum", "unknown"], career_only: false, sort: "career",
  };

  const state = {
    data: { meta: {}, jobs: [] },
    profile: { filters: FALLBACK_FILTERS, career_keywords: {} },
    filters: null,
    tab: "new",
    q: "",
    limit: { job: 50, ausbildung: 50 },
    sourcesOff: [],
    preset: null,
  };

  // ------------------------------------------------------------------ helpers
  const lower = s => (s || "").toLocaleLowerCase("de");
  // короткие слова (ERP, SAP, SQL…) ищем только целым словом, длинные — как часть слова (немецкие составные слова)
  const reCache = new Map();
  function hit(text, k) {
    const kl = lower(k);
    if (kl.length > 4) return text.includes(kl);
    if (!reCache.has(kl)) reCache.set(kl, new RegExp("(^|[^\\p{L}\\p{N}])" + kl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\p{L}\\p{N}])", "u"));
    return reCache.get(kl).test(text);
  }
  const splitList = s => s.split(/[,\n;]/).map(x => x.trim()).filter(Boolean);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const daysAgo = iso => iso ? Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 864e5) : null;
  const fmtDate = iso => iso ? new Date(iso + "T00:00:00").toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";

  // Пресет из profile.json → готовый набор фильтров
  function presetFilters(id) {
    const P = state.profile;
    const presets = P.presets || [];
    const p = presets.find(x => x.id === id);
    if (!p) return structuredClone(Object.assign({}, FALLBACK_FILTERS, P.filters || {}));
    const f = Object.assign({}, FALLBACK_FILTERS, P.common || {}, p.filters || {});
    if (p.union) {
      const all = presets.filter(x => !x.union).flatMap(x => (x.filters && x.filters.keywords) || []);
      f.keywords = [...new Set(all)];
      // миниджобы показываются все (кроме исключённых), ключевые слова к ним не применяются
      f.minijob_any = presets.some(x => !x.union && x.filters && x.filters.minijob === "only" && !(x.filters.keywords || []).length);
    }
    return structuredClone(f);
  }

  function defaultFilters() {
    const src = $("#defaultSource").value;
    const test = LS.get("testResult", null);
    if (src === "test" && test) return structuredClone(test.filters);
    return presetFilters(state.profile.default_preset);
  }

  function setActivePreset(id) {
    state.preset = id;
    LS.set("preset", id);
    $$("#presets button").forEach(b => b.classList.toggle("on", b.dataset.id === id));
    const p = (state.profile.presets || []).find(x => x.id === id);
    $("#presetHint").textContent = p ? p.hint : "";
  }

  // ★ (3) — Quereinstieg / обучение на месте; ↗ (2) — моё направление; 0 — прочее
  function careerLevel(job) {
    const ck = state.profile.career_keywords || {};
    const text = lower(job.title + " " + (job.beruf || ""));
    const has = list => (list || []).some(k => hit(text, k));
    if (job.qe || has(ck.einstieg)) return 3;
    if (has(ck.richtung)) return 2;
    return 0;
  }

  // название биржи: для агрегатора Jooble — исходный сайт (StepStone, Indeed …)
  function srcName(j) {
    const s = j.src || "";
    if (s.startsWith("Jooble / ")) return s.slice(9).trim() || "Jooble";
    return s.split(" /")[0] || "—";
  }

  // ---------------------------------------------------------------- Jooble (хранится в мосте, обновляется по кнопке)
  const bridge = () => (window.__BRIDGE_URL || LS.get("bridgeUrl", "") || "").replace(/\/+$/, "");
  const normKey = j => lower(j.title).replace(/\(.*?\)|[^a-zäöüß0-9]+/g, "") + "|" + lower(j.employer).replace(/[^a-zäöüß0-9]+/g, "");
  state.jooble = { used: null, limit: 500, updated: null };

  async function loadJooble() {
    const url = bridge(); if (!url) return;
    try {
      const r = await fetch(url + "/jooble/data", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      state.jooble = { used: d.used, limit: d.limit, updated: d.updated, has_key: d.has_key };
      const have = new Set(state.data.jobs.filter(j => !j.id.startsWith("joo:")).map(normKey));
      state.data.jobs = state.data.jobs.filter(j => !j.id.startsWith("joo:"))
        .concat((d.jobs || []).filter(j => !have.has(normKey(j))));
      renderSources(); resetLimits(); render();
    } catch { /* мост недоступен — показываем только основные данные */ }
  }

  async function refreshJooble() {
    const url = bridge();
    let key = LS.get("bridgeKey", "");
    if (!url) { alert("Мост ещё не загрузился, попробуй через пару секунд."); return; }
    if (!key) {
      key = (prompt("Пароль моста (тот же, что для ИИ в Anschreiben):") || "").trim();
      if (!key) return;
      LS.set("bridgeKey", key);
    }
    const left = state.jooble.used != null ? state.jooble.limit - state.jooble.used : "?";
    const kw = state.q || "";
    if (!confirm(`Запросить свежие вакансии Jooble${kw ? ` по слову «${kw}»` : " (все в радиусе Jena)"}?\nБудет использован 1 запрос, осталось: ${left}.`)) return;
    const btn = $("#joobleBtn"); btn.disabled = true; btn.textContent = "Загружаю…";
    try {
      const r = await fetch(url + "/jooble/refresh", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
        body: JSON.stringify({ keywords: kw, location: (state.data.meta && state.data.meta.location) || "Jena", radius: 26, per_page: 100 }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) LS.set("bridgeKey", "");
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      await loadJooble();
      alert(`Jooble: получено ${d.received}, новых ${d.added}. Всего сохранено: ${d.stored}. Осталось запросов: ${d.limit - d.used}.`);
    } catch (e) { alert("Jooble: " + e.message); }
    finally { renderSources(); }
  }

  function renderSources() {
    const counts = {};
    state.data.jobs.forEach(j => { const n = srcName(j); counts[n] = (counts[n] || 0) + 1; });
    const inactive = Object.entries((state.data.meta || {}).sources || {})
      .filter(([k, v]) => !v.ok && !counts[k] && !/выключен/.test(v.note || "")).map(([k, v]) => [k, v.note || "не подключён"]);
    const chips = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) =>
      `<button class="src-chip ${state.sourcesOff.includes(n) ? "" : "on"}" data-src="${esc(n)}" aria-pressed="${!state.sourcesOff.includes(n)}">${esc(n)} <span>${c}</span></button>`).join("") +
      inactive.map(([n, note]) => `<button class="src-chip off" disabled title="${esc(note)} — см. README, раздел «Подключить больше бирж»">${esc(n)} <span>нет ключа</span></button>`).join("");
    const j = state.jooble || {};
    const left = j.used != null ? j.limit - j.used : null;
    const upd = j.updated ? new Date(j.updated).toLocaleDateString("ru-RU") : "ещё не загружали";
    $("#sources").innerHTML = chips + (bridge() ? `<button class="src-chip jooble-btn" id="joobleBtn" title="Jooble собирает вакансии со StepStone, Indeed и других сайтов. Обновление: ${esc(upd)}">↻ Jooble · 1 запрос${left != null ? ` · осталось ${left}` : ""}</button>` : "");
    const jb = $("#joobleBtn"); if (jb) jb.onclick = refreshJooble;
    $$("#sources .src-chip[data-src]").forEach(b => b.onclick = () => {
      const n = b.dataset.src;
      state.sourcesOff = state.sourcesOff.includes(n) ? state.sourcesOff.filter(x => x !== n) : [...state.sourcesOff, n];
      LS.set("sourcesOff", state.sourcesOff);
      renderSources(); resetLimits(); render();
    });
  }

  function renderExternal() {
    const sites = state.profile.external_sites || [];
    if (!sites.length) { $("#extRow").hidden = true; return; }
    const p = (state.profile.presets || []).find(x => x.id === state.preset);
    const q = state.q || (p && p.web_query) || (state.filters.keywords || [])[0] || "Quereinsteiger";
    const where = (state.data.meta && state.data.meta.location) || "Jena";
    const r = state.filters.radius_km || 25;
    const slug = t => lower(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const url = t => t.replace("{qslug}", encodeURIComponent(slug(q))).replace("{whereslug}", encodeURIComponent(slug(where)))
      .replace("{q}", encodeURIComponent(q)).replace("{where}", encodeURIComponent(where)).replace("{rindeed}", [5, 10, 15, 25, 35, 50, 100].find(x => x >= r) || 100).replace("{r}", r);
    $("#extLinks").innerHTML = sites.map(s => `<a class="ext" href="${esc(url(s.url))}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>`).join("");
    $("#extQuery").textContent = `«${q}»`;
    $("#extRow").hidden = false;
  }

  function isLead(job) {
    const P = state.profile;
    const t = lower(job.title);
    if ((P.lead_override || []).some(k => hit(t, k))) return false;
    return (P.lead_terms || []).some(k => hit(t, k));
  }

  // ------------------------------------------------------------------ filters UI
  function writeFiltersToUI(f) {
    $("#keywords").value = (f.keywords || []).join(", ");
    $("#exclude").value = (f.exclude || []).join(", ");
    $("#radius").value = f.radius_km; $("#radiusVal").textContent = f.radius_km;
    $$("#minijob button").forEach(b => b.classList.toggle("on", b.dataset.v === f.minijob));
    $$("#worktime input").forEach(i => i.checked = (f.worktime || []).includes(i.value));
    $("#showJob").checked = !!f.show_job;
    $("#showAusbildung").checked = !!f.show_ausbildung;
    $("#careerOnly").checked = !!f.career_only;
    $("#qeOnly").checked = !!f.qe_only;
    $("#noLead").checked = !!f.no_lead;
    $("#sort").value = f.sort || "career";
  }

  function readFiltersFromUI() {
    return {
      keywords: splitList($("#keywords").value),
      exclude: splitList($("#exclude").value),
      radius_km: +$("#radius").value,
      minijob: ($("#minijob button.on") || { dataset: { v: "include" } }).dataset.v,
      worktime: $$("#worktime input:checked").map(i => i.value),
      show_job: $("#showJob").checked,
      show_ausbildung: $("#showAusbildung").checked,
      career_only: $("#careerOnly").checked,
      minijob_any: !!(state.filters && state.filters.minijob_any),
      qe_only: $("#qeOnly").checked,
      no_lead: $("#noLead").checked,
      sort: $("#sort").value,
    };
  }

  function onUserChange() {
    state.filters = readFiltersFromUI();
    $("#radiusVal").textContent = state.filters.radius_km;
    $("#useDefault").checked = false;
    LS.set("useDefault", false);
    LS.set("filters", state.filters);
    setActivePreset(null);
    resetLimits(); render();
  }

  function applyDefaults() {
    state.filters = defaultFilters();
    writeFiltersToUI(state.filters);
    setActivePreset($("#defaultSource").value === "profile" ? state.profile.default_preset : null);
    LS.set("filters", state.filters);
    resetLimits(); render();
  }

  // ------------------------------------------------------------------ matching
  function matches(job, f) {
    const isAusb = job.type === "ausbildung";
    if (state.sourcesOff.length && state.sourcesOff.includes(srcName(job))) return false;
    if (isAusb && !f.show_ausbildung) return false;
    if (!isAusb && !f.show_job) return false;

    const text = lower(job.title + " " + (job.beruf || ""));

    if (state.q && !lower(job.title + " " + job.employer + " " + job.place).includes(lower(state.q))) return false;
    const mjFree = f.minijob_any && (job.wt || []).includes("mj");
    if (f.keywords.length && !mjFree && !f.keywords.some(k => hit(text, k))) return false;
    if (f.exclude.some(k => hit(text, k))) return false;
    if (f.no_lead && isLead(job)) return false;
    if (job.dist != null && job.dist > f.radius_km) return false;

    const wt = job.wt || [];
    const isMj = wt.includes("mj");
    if (!isAusb) {
      if (f.minijob === "only" && !isMj) return false;
      if (f.minijob === "exclude" && isMj) return false;
      if (!isMj) {
        const kinds = wt.filter(w => ["vz", "tz", "snw", "praktikum"].includes(w));
        const ok = kinds.length ? kinds.some(w => f.worktime.includes(w)) : f.worktime.includes("unknown");
        if (!ok) return false;
      }
    }
    if (f.career_only && careerLevel(job) === 0) return false;
    if (f.qe_only && !job.qe && !isAusb) return false;
    return true;
  }

  function sortJobs(list, how) {
    const by = {
      date: (a, b) => (b.first_seen || "").localeCompare(a.first_seen || "") || (b.published || "").localeCompare(a.published || ""),
      dist: (a, b) => (a.dist ?? 999) - (b.dist ?? 999),
      career: (a, b) => b._lvl - a._lvl || by.date(a, b),
    };
    return list.sort(by[how] || by.date);
  }

  // ------------------------------------------------------------------ render
  const WT_LABEL = { vz: "Vollzeit", tz: "Teilzeit", mj: "Minijob", snw: "Schicht/WE", praktikum: "Praktikum", ho: "Homeoffice" };
  const LVL = { 3: ["★", "Quereinstieg / обучение на месте", "lvl3"], 2: ["↗", "моё направление", "lvl2"] };

  function card(j) {
    const lvl = LVL[j._lvl];
    const fresh = daysAgo(j.first_seen);
    const badges = (j.wt || []).map(w => `<span class="b ${w === "mj" ? "b-mj" : ""}">${esc(WT_LABEL[w] || w)}</span>`).join("") +
      (j.qe ? `<span class="b b-qe" title="Работодатель готов взять без профильной Ausbildung">Quereinstieg</span>` : "");
    const alt = (j.alt || []).map(a => `<a class="alt" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.src)}</a>`).join(" ");
    return `<article class="job ${lvl ? lvl[2] : ""}">
      <div class="job-top">
        ${lvl ? `<span class="lvl" title="${lvl[1]}">${lvl[0]}</span>` : ""}
        <h3><a class="job-link" href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></h3>
        ${fresh != null && fresh <= 1 ? `<span class="fresh">новое</span>` : ""}
      </div>
      <div class="job-meta">
        <span>${esc(j.employer || "—")}</span>
        <span>${esc(j.place)}${j.dist != null ? ` · ${j.dist} км` : ""}</span>
      </div>
      <div class="job-foot">
        ${badges}
        ${j.start ? `<span class="muted">старт ${fmtDate(j.start)}</span>` : ""}
        <span class="muted src">${esc(j.src)} · найдено ${fmtDate(j.first_seen)}</span>
      </div>
      ${alt ? `<div class="alts">также: ${alt}</div>` : ""}
      <div class="job-actions"><button class="lt-btn" data-letter="${esc(j.id)}">✉ Anschreiben erstellen</button></div>
    </article>`;
  }

  function render() {
    if (state.tab === "test" || state.tab === "plan") return;
    const f = state.filters;
    const newDays = state.data.meta.new_days || 14;
    const isNew = j => (daysAgo(j.first_seen) ?? 0) < newDays;

    const filtered = state.data.jobs.filter(j => matches(j, f));
    filtered.forEach(j => j._lvl = careerLevel(j));
    const nNew = filtered.filter(isNew).length;
    $("#cnt-new").textContent = nNew;
    $("#cnt-all").textContent = filtered.length - nNew;

    renderExternal();
    const inTab = filtered.filter(j => state.tab === "new" ? isNew(j) : !isNew(j));
    ["job", "ausbildung"].forEach(type => {
      const list = sortJobs(inTab.filter(j => j.type === type), f.sort);
      $("#n-" + type).textContent = list.length;
      const col = $("#col-" + type);
      const show = type === "job" ? f.show_job : f.show_ausbildung;
      col.classList.toggle("dim", !show);
      const box = $("#list-" + type);
      if (!show) { box.innerHTML = `<p class="empty">Колонка скрыта фильтром «Показывать».</p>`; return; }
      if (!list.length) {
        box.innerHTML = `<p class="empty">${state.data.jobs.length ? "Нет вакансий под эти фильтры." : "Данных пока нет — дождись первого ежедневного запуска или запусти его вручную во вкладке Actions."}</p>`;
        return;
      }
      const lim = state.limit[type];
      box.innerHTML = list.slice(0, lim).map(card).join("") +
        (list.length > lim ? `<button class="more" data-type="${type}">Показать ещё (${list.length - lim})</button>` : "");
    });
  }

  function resetLimits() { state.limit = { job: 50, ausbildung: 50 }; }

  function renderMeta() {
    const m = state.data.meta || {};
    if (!m.updated) { $("#meta").textContent = "Ещё не обновлялось."; return; }
    const upd = new Date(m.updated).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    const src = Object.entries(m.sources || {}).map(([k, v]) =>
      `<span class="src-st ${v.ok ? "ok" : "off"}" title="${esc(v.note || (v.complete === false ? "собрано не полностью" : ""))}">${esc(k)}${v.ok ? ` ${v.count}` : " —"}</span>`).join("");
    $("#meta").innerHTML = `Обновлено ${upd} · радиус сбора ${m.radius_km} км · ${state.data.jobs.length} вакансий · истекло сегодня: ${m.removed_today ?? 0} ${src}`;
  }

  // ------------------------------------------------------------------ test
  function renderTest() {
    const T = window.CAREER_TEST;
    const box = $("#testBox");
    const saved = LS.get("testResult", null);
    let answers = LS.get("testDraft", new Array(T.QUESTIONS.length).fill(null));

    function showResult(res) {
      box.innerHTML = `
        <h2>Твой результат</h2>
        <p class="muted">Тест пройден ${fmtDate(res.date)}. Подходящие направления (по убыванию):</p>
        <ol class="dirs">${res.top.map(k => `<li><b>${esc(T.DIRECTIONS[k].name)}</b><p>${esc(T.DIRECTIONS[k].path)}</p></li>`).join("")}</ol>
        <details><summary>Все баллы</summary><ul>${res.ranked.map(([k, v]) => `<li>${esc(T.DIRECTIONS[k].name)}: ${v}</li>`).join("")}</ul></details>
        <p>Эти направления превращены в фильтры (ключевые слова, радиус, режим работы). Они станут твоими стандартными фильтрами «по результату теста».</p>
        <div class="btns">
          <button class="primary" id="applyTest">Применить и показать вакансии</button>
          <button class="ghost" id="retake">Пройти заново</button>
        </div>`;
      $("#applyTest").onclick = () => {
        $("#defaultSource").value = "test"; LS.set("defaultSource", "test");
        $("#useDefault").checked = true; LS.set("useDefault", true);
        applyDefaults(); switchTab("new");
      };
      $("#retake").onclick = () => { answers = new Array(T.QUESTIONS.length).fill(null); LS.set("testDraft", answers); showQuestions(); };
    }

    function showQuestions() {
      const done = answers.filter(a => a != null).length;
      box.innerHTML = `
        <h2>Тест профориентации</h2>
        <p class="muted">${T.QUESTIONS.length} вопросов, ~3 минуты. Результат: 2–3 направления, где реально вырасти до небольшого руководителя за 1–2 года, и готовые фильтры.</p>
        <div class="progress"><div style="width:${done / T.QUESTIONS.length * 100}%"></div></div>
        ${T.QUESTIONS.map((q, qi) => `
          <fieldset class="q"><legend>${qi + 1}. ${esc(q.q)}</legend>
            ${q.a.map((a, ai) => `<label class="opt ${answers[qi] === ai ? "on" : ""}"><input type="radio" name="q${qi}" value="${ai}" ${answers[qi] === ai ? "checked" : ""}> ${esc(a.t)}</label>`).join("")}
          </fieldset>`).join("")}
        <div class="btns"><button class="primary" id="finish" ${done < T.QUESTIONS.length ? "disabled" : ""}>Показать результат</button></div>`;
      $$("input[type=radio]", box).forEach(r => r.onchange = () => {
        answers[+r.name.slice(1)] = +r.value; LS.set("testDraft", answers);
        const y = window.scrollY; showQuestions(); window.scrollTo(0, y);
      });
      $("#finish").onclick = () => {
        const res = T.evaluate(answers); LS.set("testResult", res); showResult(res); window.scrollTo(0, 0);
      };
    }

    saved ? showResult(saved) : showQuestions();
  }

  // ------------------------------------------------------------------ plan
  function renderPlan() {
    const P = state.profile;
    const crit = P.criteria || [];
    const wsum = crit.reduce((a, c) => a + c.w * 5, 0) || 1;
    const savedQ = state.q; state.q = "";
    const dirFilters = d => Object.assign(presetFilters(d.preset), d.keywords ? { keywords: d.keywords } : {});
    const countFor = d => state.data.jobs.filter(j => matches(j, dirFilters(d))).length;
    const dirs = (P.directions || []).map(d => ({
      ...d,
      total: Math.round(crit.reduce((a, c) => a + c.w * ((d.scores || {})[c.id] || 0), 0) / wsum * 100),
      count: d.preset ? countFor(d) : null,
    })).sort((a, b) => b.total - a.total);
    state.q = savedQ;
    const done = LS.get("roadmap", {});
    const dots = n => `<span class="dots" title="${n} из 5">${"●".repeat(n)}<i>${"●".repeat(5 - n)}</i></span>`;
    const sap = P.sap;

    $("#planBox").innerHTML = `
      <h2>Мой план</h2>
      <p class="goal">${esc(P.goal || "")}</p>

      <h3 class="ph">1. Что у меня есть</h3>
      <div class="assets">${(P.assets || []).map(g => `
        <div class="asset"><b>${esc(g.group)}</b><ul>${g.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>`).join("")}</div>

      <h3 class="ph">2. Чего я хочу</h3>
      <ul class="wishes">${(P.wishes || []).map(w => `<li>${esc(w)}</li>`).join("")}</ul>

      <h3 class="ph">3. Сравнение направлений</h3>
      <p class="muted">Оценки 1–5 — экспертная прикидка по твоему профилю. Итог учитывает веса: лёгкость входа ×2, доход ×1, остальное ×1,5. Вакансии — сколько сейчас найдено в радиусе (нажми, чтобы открыть).</p>
      <div class="tbl-wrap"><table class="matrix">
        <thead><tr><th>#</th><th>Направление</th>${crit.map(c => `<th>${esc(c.name)}</th>`).join("")}<th>Итог</th><th>Вакансий</th></tr></thead>
        <tbody>${dirs.map((d, i) => `
          <tr class="${i < 2 ? "top" : ""}">
            <td>${i + 1}</td>
            <td><details><summary>${esc(d.name)}</summary>
              <p><b>Почему:</b> ${esc(d.fit)}</p><p><b>Путь:</b> ${esc(d.path)}</p><p><b>ИИ:</b> ${esc(d.ai)}</p></details></td>
            ${crit.map(c => `<td>${dots((d.scores || {})[c.id] || 0)}</td>`).join("")}
            <td><b class="score">${d.total}</b></td>
            <td>${d.preset ? `<button class="linkbtn" data-dir="${i}">${d.count}</button>` : "—"}</td>
          </tr>`).join("")}</tbody>
      </table></div>

      <h3 class="ph">4. Вывод</h3>
      <div class="verdict">
        <p><b>План A:</b> ${esc(dirs[0] ? dirs[0].name : "")}</p>
        <p><b>План B:</b> ${esc(dirs[1] ? dirs[1].name : "")}</p>
        <p><b>Старт сейчас:</b> миниджоб на складе или в сервисе — параллельно с планом A, чтобы быстрее получить немецкий стаж и доход.</p>
        <p class="muted">Общее ядро твоих сильных сторон: <b>закупки + логистика + IT-системы</b>. Входить — с начальной позиции, а SAP учить параллельно: так через 1–2 года можно перейти на уровень выше.</p>
      </div>

      ${sap ? `<h3 class="ph">5. Какой SAP выбрать</h3>
      <div class="sap">
        <p class="sap-rec">Рекомендация: <b>${esc(sap.recommend)}</b></p>
        <p>${esc(sap.why)}</p>
        <div class="routes">${sap.routes.map(r => `<div class="route"><b>${esc(r.name)}</b><span class="muted">${esc(r.time)}</span><p>Для: ${esc(r.for)}</p><p class="muted">${esc(r.note)}</p></div>`).join("")}</div>
        ${sap.free ? `<h4>Как учиться бесплатно</h4><div class="routes">${sap.free.map(r => `<div class="route"><b>${esc(r.name)}</b><p>${esc(r.what)}</p></div>`).join("")}</div>` : ""}
        <p class="muted">Не рекомендую: ${sap.avoid.map(a => `<b>${esc(a.name)}</b> — ${esc(a.why)}`).join("; ")}.</p>
      </div>` : ""}

      <h3 class="ph">6. Мои шаги</h3>
      <div class="roadmap">${(P.roadmap || []).map(r => `
        <label class="opt ${done[r.id] ? "on" : ""}"><input type="checkbox" data-step="${esc(r.id)}" ${done[r.id] ? "checked" : ""}> ${esc(r.text)}</label>`).join("")}</div>
      <p class="muted">Галочки сохраняются в этом браузере.</p>`;

    $$("[data-dir]", $("#planBox")).forEach(b => b.onclick = () => {
      const d = dirs[+b.dataset.dir];
      if (d.keywords) {
        state.filters = dirFilters(d); writeFiltersToUI(state.filters); LS.set("filters", state.filters);
        $("#useDefault").checked = false; LS.set("useDefault", false); setActivePreset(null);
        $("#presetHint").textContent = "Подборка: " + d.name;
      } else usePreset(d.preset);
      switchTab("new");
    });
    $$("[data-step]", $("#planBox")).forEach(c => c.onchange = () => {
      const st = LS.get("roadmap", {}); st[c.dataset.step] = c.checked; LS.set("roadmap", st);
      c.closest("label").classList.toggle("on", c.checked);
    });
  }

  function usePreset(id) {
    state.filters = presetFilters(id);
    writeFiltersToUI(state.filters);
    LS.set("filters", state.filters);
    const isDefault = id === state.profile.default_preset && $("#defaultSource").value === "profile";
    $("#useDefault").checked = isDefault; LS.set("useDefault", isDefault);
    setActivePreset(id);
    resetLimits(); render();
  }

  function renderPresets() {
    const presets = state.profile.presets || [];
    $("#presets").innerHTML = presets.map(p => `<button data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("");
    $$("#presets button").forEach(b => b.onclick = () => usePreset(b.dataset.id));
    $("#presetRow").hidden = !presets.length;
  }

  function switchTab(tab) {
    state.tab = tab;
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    const jobsView = tab === "new" || tab === "all";
    $("#view-jobs").hidden = !jobsView;
    $("#filters").hidden = !jobsView;
    $("#view-test").hidden = tab !== "test";
    $("#view-plan").hidden = tab !== "plan";
    if (tab === "test") renderTest();
    else if (tab === "plan") renderPlan();
    else { resetLimits(); render(); }
  }

  // ------------------------------------------------------------------ init
  async function init() {
    const [data, profile] = await Promise.all([
      fetch("data/jobs.json", { cache: "no-store" }).then(r => r.ok ? r.json() : { meta: {}, jobs: [] }).catch(() => ({ meta: {}, jobs: [] })),
      fetch("config/profile.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    state.data = data;
    if (profile) state.profile = profile;
    window.__PROFILE = state.profile;
    fetch("config/bridge.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null)
      .then(b => { if (b && b.url) { window.__BRIDGE_URL = b.url; loadJooble(); } }).catch(() => {});

    $("#defaultSource").value = LS.get("defaultSource", LS.get("testResult", null) ? "test" : "profile");
    const useDefault = LS.get("useDefault", true);
    $("#useDefault").checked = useDefault;
    state.filters = useDefault ? defaultFilters() : Object.assign({}, FALLBACK_FILTERS, LS.get("filters", defaultFilters()));
    writeFiltersToUI(state.filters);
    state.sourcesOff = LS.get("sourcesOff", []);
    renderPresets();
    renderSources();
    setActivePreset(useDefault && $("#defaultSource").value === "profile" ? state.profile.default_preset : LS.get("preset", null));

    // события
    $$(".tab").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $("#useDefault").onchange = e => { LS.set("useDefault", e.target.checked); if (e.target.checked) applyDefaults(); };
    $("#defaultSource").onchange = e => {
      if (e.target.value === "test" && !LS.get("testResult", null)) {
        alert("Тест ещё не пройден — открой вкладку «Тест профориентации»."); e.target.value = "profile"; return;
      }
      LS.set("defaultSource", e.target.value);
      if ($("#useDefault").checked) applyDefaults();
    };
    $("#toggleMore").onclick = e => {
      const body = $("#filtersBody"); body.hidden = !body.hidden;
      e.target.setAttribute("aria-expanded", String(!body.hidden));
      e.target.textContent = body.hidden ? "Все фильтры ▾" : "Свернуть ▴";
    };
    ["#keywords", "#exclude"].forEach(s => $(s).addEventListener("change", onUserChange));
    $("#radius").addEventListener("input", onUserChange);
    ["#showJob", "#showAusbildung", "#careerOnly", "#qeOnly", "#noLead", "#sort"].forEach(s => $(s).addEventListener("change", onUserChange));
    $$("#worktime input").forEach(i => i.addEventListener("change", onUserChange));
    $$("#minijob button").forEach(b => b.onclick = () => {
      $$("#minijob button").forEach(x => x.classList.toggle("on", x === b)); onUserChange();
    });
    let t; $("#q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); resetLimits(); render(); }, 150); });
    document.addEventListener("click", e => {
      const lb = e.target.closest("[data-letter]");
      if (lb) {
        const j = state.data.jobs.find(x => x.id === lb.dataset.letter);
        if (j && window.LETTER) window.LETTER.open(j, state.profile);
        return;
      }
      const m = e.target.closest(".more"); if (!m) return;
      state.limit[m.dataset.type] += 50; render();
    });

    renderMeta();
    render();
  }

  init();
})();
