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

  function careerLevel(job) {
    const ck = state.profile.career_keywords || {};
    const text = lower(job.title + " " + (job.beruf || ""));
    const has = list => (list || []).some(k => hit(text, k));
    if (has(ck.leitung)) return 3;
    if (has(ck.sprungbrett)) return 2;
    if (has(ck.einstieg_mit_perspektive)) return 1;
    return 0;
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
    if (isAusb && !f.show_ausbildung) return false;
    if (!isAusb && !f.show_job) return false;

    const text = lower(job.title + " " + (job.beruf || ""));
    const textAll = text + " " + lower(job.employer);
    if (state.q && !lower(job.title + " " + job.employer + " " + job.place).includes(lower(state.q))) return false;
    const mjFree = f.minijob_any && (job.wt || []).includes("mj");
    if (f.keywords.length && !mjFree && !f.keywords.some(k => hit(text, k))) return false;
    if (f.exclude.some(k => hit(textAll, k))) return false;
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
  const LVL = { 3: ["★", "руководство", "lvl3"], 2: ["↗", "ступенька к руководству", "lvl2"], 1: ["→", "вход с перспективой", "lvl1"] };

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
    const dirs = P.directions || [];
    const presets = (P.presets || []).filter(p => !p.union);
    $("#planBox").innerHTML = `
      <h2>Мой план</h2>
      <p class="goal">${esc(P.goal || "")}</p>
      <div class="plan-list">${dirs.map((d, i) => `
        <article class="plan">
          <h3><span class="num">${i + 1}</span>${esc(d.name)}</h3>
          <dl>
            <dt>Почему подходит</dt><dd>${esc(d.fit)}</dd>
            <dt>Путь</dt><dd>${esc(d.path)}</dd>
            <dt>ИИ и рынок</dt><dd>${esc(d.ai)}</dd>
          </dl>
        </article>`).join("")}</div>
      <p class="muted">Быстрые подборки вакансий по направлениям:</p>
      <div class="btns">${presets.map(p => `<button class="ghost" data-goto="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div>`;
    $$("[data-goto]", $("#planBox")).forEach(b => b.onclick = () => { usePreset(b.dataset.goto); switchTab("new"); });
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

    $("#defaultSource").value = LS.get("defaultSource", LS.get("testResult", null) ? "test" : "profile");
    const useDefault = LS.get("useDefault", true);
    $("#useDefault").checked = useDefault;
    state.filters = useDefault ? defaultFilters() : Object.assign({}, FALLBACK_FILTERS, LS.get("filters", defaultFilters()));
    writeFiltersToUI(state.filters);
    renderPresets();
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
    ["#showJob", "#showAusbildung", "#careerOnly", "#qeOnly", "#sort"].forEach(s => $(s).addEventListener("change", onUserChange));
    $$("#worktime input").forEach(i => i.addEventListener("change", onUserChange));
    $$("#minijob button").forEach(b => b.onclick = () => {
      $$("#minijob button").forEach(x => x.classList.toggle("on", x === b)); onUserChange();
    });
    let t; $("#q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); resetLimits(); render(); }, 150); });
    document.addEventListener("click", e => {
      const m = e.target.closest(".more"); if (!m) return;
      state.limit[m.dataset.type] += 50; render();
    });

    renderMeta();
    render();
  }

  init();
})();
