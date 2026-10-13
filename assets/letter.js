/* Помощник «Anschreiben erstellen».
   Всё работает в браузере: личные данные хранятся только в localStorage этого устройства
   и никуда не отправляются. Шаблоны текста — в config/profile.json → letter. */
window.LETTER = (function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("jj_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("jj_" + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lower = s => (s || "").toLocaleLowerCase("de");

  const FIELDS = [
    ["name", "Имя и фамилия", "Vorname Nachname"],
    ["street", "Улица, дом", "Musterstraße 1"],
    ["city", "Индекс и город", "07743 Jena"],
    ["phone", "Телефон", "+49 …"],
    ["email", "E-Mail", "name@example.de"],
  ];

  // ---------------------------------------------------------------- люди (для кого письмо)
  function people() {
    let list = LS.get("people", null);
    if (!list) {
      const old = LS.get("me", {});
      list = [Object.assign({ id: "me", label: "Я", mode: "me" }, old)];
      LS.set("people", list);
    }
    return list;
  }
  const currentId = () => { const id = LS.get("person", "me"); return people().some(p => p.id === id) ? id : "me"; };
  const current = () => people().find(p => p.id === currentId());
  function savePerson(p) { LS.set("people", people().map(x => x.id === p.id ? p : x)); }
  const draftKey = () => `letter_${currentId()}_${job.id}`;

  let cfg = null;       // profile.letter
  let job = null;       // текущая вакансия
  let root = null;      // DOM панели
  const loaded = {};    // загруженные библиотеки

  // ---------------------------------------------------------------- библиотеки (лениво)
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Не удалось загрузить " + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  async function readFile(file) {
    const name = lower(file.name);
    if (name.endsWith(".pdf")) {
      await loadScript("assets/vendor/pdf.min.js");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.js";
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const c = await page.getTextContent();
        let lastY = null;
        c.items.forEach(it => {
          const y = it.transform ? Math.round(it.transform[5]) : null;
          text += (lastY !== null && y !== lastY ? "\n" : " ") + it.str;
          lastY = y;
        });
        text += "\n";
      }
      return text;
    }
    if (name.endsWith(".docx")) {
      await loadScript("assets/vendor/mammoth.browser.min.js");
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return r.value;
    }
    if (name.endsWith(".doc")) throw new Error("Старый формат .doc не читается — сохрани файл как .docx или PDF.");
    return await file.text();
  }

  // ---------------------------------------------------------------- разбор текста резюме
  function parseCV(text) {
    const out = {};
    const t = text.replace(/ /g, " ");
    const email = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (email) out.email = email[0];
    const phone = t.match(/(\+?\d[\d ()/-]{7,}\d)/);
    if (phone && !/^\d{2}\/\d{4}/.test(phone[0])) out.phone = phone[0].trim();
    const lines = t.split(/\n/).map(l => l.trim()).filter(Boolean);
    const cityIdx = lines.findIndex(l => /^\d{5}\s+[A-ZÄÖÜ][\wäöüß .-]+$/.test(l));
    if (cityIdx >= 0) {
      out.city = lines[cityIdx];
      const prev = lines[cityIdx - 1] || "";
      if (/(str\.|straße|weg|platz|allee|ring|gasse)\s*\d|\d+\s*[a-z]?$/i.test(prev)) out.street = prev;
    } else {
      const inline = t.match(/([A-ZÄÖÜ][\wäöüß.-]+(?:straße|str\.|weg|platz|allee|ring|gasse)\s*\d+\s*[a-z]?)[,\s]+(\d{5}\s+[A-ZÄÖÜ][\wäöüß-]+)/i);
      if (inline) { out.street = inline[1]; out.city = inline[2]; }
    }
    const name = lines.slice(0, 8).find(l => /^[A-ZÄÖÜ][a-zäöüß]+(?:[- ][A-ZÄÖÜ][a-zäöüß]+){1,2}$/.test(l)
      && !/Lebenslauf|Kurzprofil|Bewerbung|Persönlich|Kontakt|Ausbildung/i.test(l));
    if (name) out.name = name;
    out.hasSAP = /\bSAP\b/.test(t);
    out.text = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return out;
  }

  // ---------------------------------------------------------------- генерация
  function category(j) {
    if (j.type === "ausbildung") return "ausbildung";
    const text = lower(j.title + " " + (j.beruf || ""));
    const cats = cfg.categories || {};
    for (const c of ["einkauf", "lager", "it", "office"]) {
      if ((cats[c] || []).some(k => text.includes(lower(k)))) return c;
    }
    return "generic";
  }

  const cleanTitle = t => (t || "").replace(/\s*\((?:m|w|d|f|x|div)\s*[/|,]\s*(?:m|w|d|f|x)(?:\s*[/|,]\s*(?:m|w|d|f|x))?\)\s*/gi, " ")
    .replace(/\s*[mwd]\/[mwd]\/[mwd]\s*/gi, " ").replace(/^\d{4}\s*/, "").replace(/\s+/g, " ").trim();

  // [[подсказка]] → подсвеченное поле
  function marks(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, (_, hint) => `<mark class="todo" title="Заполни или удали">[${hint}]</mark>`);
  }
  const todo = hint => `[[${hint}]]`;

  function build(me, aiBody) {
    const j = job;
    const isMj = (j.wt || []).includes("mj");
    const kind = j.type === "ausbildung" ? "ausbildung" : isMj ? "minijob" : "job";
    const cat = category(j);
    const title = cleanTitle(j.title);
    const ref = j.id && j.id.startsWith("ba:") ? j.id.slice(3) : "";
    const source = j.src && j.src.startsWith("Arbeitsagentur") ? "in der Jobbörse der Bundesagentur für Arbeit" : (j.src ? `auf ${j.src.split(" /")[0]}` : "");
    const v = k => (me[k] && me[k].trim()) ? me[k].trim() : todo(FIELDS.find(f => f[0] === k)[2]);
    const myCity = (me.city || "").replace(/^\d{5}\s*/, "").trim() || todo("Ort");
    const today = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    const place = (j.place || "").trim();
    if (aiBody) return frame(aiBody);

    const other = me.mode === "other";
    const O = cfg.other || {};
    const body = [];
    body.push((cfg.intro[kind] || cfg.intro.job).replace("{title}", title).replace("{source}", source).replace(/\s+\./, "."));
    if (other) {
      body.push(me.background && me.background.trim() ? me.background.trim() : O.background);
      body.push(me.summary && me.summary.trim() ? me.summary.trim() : O.block);
      body.push(O.team + " " + O.learning);
      body.push((me.languages && me.languages.trim() ? me.languages.trim() : O.language) + " " + (cfg.availability[kind] || cfg.availability.job));
      if (me.extra && me.extra.trim()) body.push(me.extra.trim());
      body.push(cfg.closing);
      return frame(body);
    }
    body.push(cfg.background);
    const block = cat === "generic" && kind === "ausbildung" ? cfg.blocks.ausbildung : (cfg.blocks[cat] || cfg.blocks.generic);
    let p3 = block;
    if (kind === "ausbildung" && cat !== "ausbildung") p3 += " " + cfg.blocks.ausbildung;
    const wantsSAP = /\bSAP\b|ERP|Einkauf|Disposition|Lager|Logistik/i.test(j.title + " " + (j.beruf || ""));
    if (wantsSAP) p3 += " " + (me.hasSAP ? cfg.sap.replace(/\s*\[\[.*?\]\]/, "") : cfg.sap);
    body.push(p3);
    body.push(cfg.team + " " + (j.qe || kind !== "ausbildung" ? cfg.learning : ""));
    body.push(cfg.language + " " + (cfg.availability[kind] || cfg.availability.job));
    if (me.extra && me.extra.trim()) body.push(me.extra.trim());
    body.push(cfg.closing);
    return frame(body);

    // блоки письма: {t: текст с [[ ]], a: выравнивание, cls}
    function frame(body) {
    return [
      { t: [v("name"), v("street"), v("city"), v("phone"), v("email")].join("\n"), cls: "sender" },
      { t: [j.employer || todo("Firma"), todo("Ansprechpartner/in (falls bekannt)"), todo("Straße Hausnummer"), place ? place : todo("PLZ Ort")].join("\n"), cls: "recipient" },
      { t: `${myCity}, ${today}`, a: "right" },
      { t: `Bewerbung ${kind === "ausbildung" ? "um einen Ausbildungsplatz als" : "als"} ${title}${ref ? ` – Referenznummer ${ref}` : ""}`, cls: "subject" },
      { t: `Sehr geehrte Damen und Herren, ${todo("besser: Sehr geehrte/r Frau/Herr Name — wenn Ansprechpartner bekannt")}` },
      ...body.map(t => ({ t })),
      { t: `Mit freundlichen Grüßen\n\n\n${v("name")}` },
      { t: cfg.attachments, cls: "small" },
    ];
    }
  }

  function renderLetter(blocks) {
    const ed = $("#lt-editor", root);
    ed.innerHTML = blocks.map(b =>
      `<p class="${b.cls || ""}" ${b.a ? `data-align="${b.a}"` : ""}>${marks(b.t).replace(/\n/g, "<br>")}</p>`).join("");
    afterEdit();
  }

  // ---------------------------------------------------------------- редактор
  function afterEdit() {
    const ed = $("#lt-editor", root);
    // если пользователь вписал текст в подсвеченное поле — гасим подсветку (элемент не трогаем, чтобы не сбить курсор)
    $$("mark.todo", ed).forEach(m => m.classList.toggle("done", !/^\[.*\]$/.test(m.textContent.trim())));
    const n = pending().length;
    $("#lt-count", root).textContent = n ? `Нужно заполнить: ${n}` : "Всё заполнено ✓";
    $("#lt-count", root).classList.toggle("ok", !n);
    if (job) LS.set(draftKey(), ed.innerHTML);
  }

  const pending = () => $$("#lt-editor mark.todo", root).filter(m => !m.classList.contains("done"));

  function nextMark() {
    const m = pending()[0];
    if (!m) return;
    m.scrollIntoView({ block: "center", behavior: "smooth" });
    const r = document.createRange(); r.selectNodeContents(m);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    $("#lt-editor", root).focus();
  }

  // абзацы редактора → [{text, align, cls}]
  function paragraphs() {
    return $$("#lt-editor > *", root).map(p => ({
      text: p.innerText.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trimEnd(),
      align: p.dataset.align || "left",
      cls: p.className || "",
    })).filter(p => p.text.trim() || p.cls);
  }

  function fileBase() {
    const t = cleanTitle(job.title).replace(/[^\wäöüÄÖÜß-]+/g, "_").slice(0, 40);
    return `Anschreiben_${t || "Bewerbung"}`;
  }

  function confirmMarks() {
    const n = pending().length;
    return !n || confirm(`В тексте осталось незаполненных мест: ${n}. Всё равно сохранить?`);
  }

  async function savePDF() {
    if (!confirmMarks()) return;
    await loadScript("assets/vendor/jspdf.umd.min.js");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const L = 25, R = 20, W = 210 - L - R, lh = 5.2;
    let y = 25;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    for (const p of paragraphs()) {
      const bold = p.cls.includes("subject");
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(p.cls.includes("small") ? 9.5 : 11);
      const lines = p.text.split("\n").flatMap(l => l ? doc.splitTextToSize(l, W) : [""]);
      for (const line of lines) {
        if (y > 280) { doc.addPage(); y = 25; }
        if (p.align === "right") doc.text(line, 210 - R, y, { align: "right" });
        else doc.text(line, L, y);
        y += lh;
      }
      y += p.cls.includes("recipient") ? 10 : p.cls.includes("sender") ? 8 : 3.5;
    }
    doc.save(fileBase() + ".pdf");
  }

  async function saveDOCX() {
    if (!confirmMarks()) return;
    await loadScript("assets/vendor/jszip.min.js");
    const x = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const para = p => {
      const runs = p.text.split("\n").map((l, i) =>
        `${i ? "<w:r><w:br/></w:r>" : ""}<w:r><w:rPr>${p.cls.includes("subject") ? "<w:b/>" : ""}${p.cls.includes("small") ? '<w:sz w:val="19"/>' : ""}</w:rPr><w:t xml:space="preserve">${x(l)}</w:t></w:r>`).join("");
      const after = p.cls.includes("recipient") ? 480 : p.cls.includes("sender") ? 360 : 200;
      return `<w:p><w:pPr><w:spacing w:after="${after}"/>${p.align === "right" ? '<w:jc w:val="right"/>' : ""}</w:pPr>${runs}</w:p>`;
    };
    const body = paragraphs().map(para).join("");
    const zip = new window.JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = fileBase() + ".docx";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- ИИ (Cloudflare Workers AI через мост)
  const bridgeUrl = () => (LS.get("bridgeUrl", "") || window.__BRIDGE_URL || (window.__PROFILE && window.__PROFILE.ai_bridge_url) || "").replace(/\/+$/, "");

  // резюме по умолчанию для «Я», если файл не загружен: факты из шаблонов профиля
  function defaultCV() {
    const b = cfg.blocks || {};
    return [cfg.background, b.einkauf, b.lager, b.it, b.office, cfg.team, cfg.language].filter(Boolean)
      .join("\n").replace(/\[\[.*?\]\]/g, "");
  }

  async function aiWrite() {
    const url = bridgeUrl(), key = LS.get("bridgeKey", "");
    if (!url || !key) { toggleAISettings(true); setAIStatus("Укажи адрес моста и пароль.", "err"); return; }
    const me = readMe();
    if (LS.get(draftKey(), null) && !confirm("Написать письмо с ИИ? Текущий текст будет заменён (контакты сохранятся).")) return;
    const cv = me.cv || (me.mode === "me" ? defaultCV() : [me.background, me.summary, me.languages].filter(Boolean).join("\n"));
    const btn = $("#lt-ai", root); btn.disabled = true; btn.textContent = "ИИ пишет… ~10–20 с";
    setAIStatus("");
    try {
      const r = await fetch(url + "/letter", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Key": key },
        body: JSON.stringify({
          job: { title: cleanTitle(job.title), employer: job.employer, place: job.place, beruf: job.beruf, type: job.type,
            minijob: (job.wt || []).includes("mj"), qe: !!job.qe, ref: job.id && job.id.startsWith("ba:") ? job.id.slice(3) : "" },
          cv, notes: me.extra || "",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      const paras = d.text.split(/\n\s*\n/).map(x => x.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
      renderLetter(build(me, paras));
      setAIStatus(d.has_description ? "Готово. ИИ учёл описание вакансии — проверь текст." : "Готово (описание вакансии недоступно, письмо по названию) — проверь текст.", "ok");
    } catch (e) {
      setAIStatus("Ошибка: " + e.message, "err");
    } finally {
      btn.disabled = false; btn.textContent = "✨ Написать с ИИ";
    }
  }

  async function aiCheck() {
    LS.set("bridgeUrl", $("#lt-burl", root).value.trim());
    LS.set("bridgeKey", $("#lt-bkey", root).value);
    const url = bridgeUrl();
    if (!url) { setAIStatus("Нет адреса моста.", "err"); return; }
    try {
      const r = await fetch(url + "/check", { method: "POST", headers: { "X-Bridge-Key": LS.get("bridgeKey", "") } });
      const d = await r.json().catch(() => ({}));
      setAIStatus(r.ok ? "Мост работает, пароль верный ✓" : ("Ошибка: " + (d.error || r.status)), r.ok ? "ok" : "err");
    } catch (e) { setAIStatus("Мост недоступен: " + e.message, "err"); }
  }

  function setAIStatus(t, kind) { const el = $("#lt-aistatus", root); el.textContent = t; el.className = "small lt-aistatus " + (kind || ""); }
  function toggleAISettings(force) {
    const box = $("#lt-aiset", root); box.hidden = force === undefined ? !box.hidden : !force;
    $("#lt-burl", root).value = bridgeUrl(); $("#lt-bkey", root).value = LS.get("bridgeKey", "");
  }

  // ---------------------------------------------------------------- панель
  const OTHER_FIELDS = ["background", "summary", "languages"];

  function readMe() {
    const me = current();
    FIELDS.forEach(([k]) => { me[k] = $(`#lt-${k}`, root).value; });
    me.extra = $("#lt-extra", root).value;
    OTHER_FIELDS.forEach(k => { me[k] = $(`#lt-${k}`, root).value; });
    savePerson(me);
    return me;
  }

  function fillMe(me) {
    FIELDS.forEach(([k]) => { $(`#lt-${k}`, root).value = me[k] || ""; });
    $("#lt-extra", root).value = me.extra || "";
    OTHER_FIELDS.forEach(k => { $(`#lt-${k}`, root).value = me[k] || ""; });
    $("#lt-otherwrap", root).hidden = me.mode !== "other";
    $("#lt-del", root).hidden = me.id === "me";
    $("#lt-person", root).innerHTML = people().map(p => `<option value="${esc(p.id)}" ${p.id === me.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");
  }

  function loadLetter() {
    const me = current();
    fillMe(me);
    let draft = LS.get(draftKey(), null);
    if (!draft && me.id === "me") draft = LS.get("letter_" + job.id, null); // старые черновики
    if (draft) { $("#lt-editor", root).innerHTML = draft; afterEdit(); }
    else renderLetter(build(me));
  }

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "lt-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div class="lt-panel" role="dialog" aria-modal="true" aria-labelledby="lt-title">
        <header class="lt-head">
          <div><h2 id="lt-title">Anschreiben erstellen</h2><p class="muted" id="lt-job"></p></div>
          <button class="ghost" id="lt-close" aria-label="Закрыть">✕</button>
        </header>
        <div class="lt-body">
          <section class="lt-data">
            <details open id="lt-datawrap">
              <summary><b>Данные</b> <span class="muted">— хранятся только в этом браузере</span></summary>
              <div class="lt-person">
                <label class="fl">Для кого письмо
                  <select id="lt-person"></select>
                </label>
                <button class="ghost" id="lt-add" title="Создать письмо для другого человека">+ Другой человек</button>
                <button class="ghost" id="lt-del" title="Удалить этого человека">✕</button>
              </div>
              <label class="lt-file">📄 Загрузить Lebenslauf (PDF, Word .docx, .txt)
                <input type="file" id="lt-file" accept=".pdf,.docx,.txt,.doc">
              </label>
              <p class="muted small" id="lt-filemsg"></p>
              <label class="fl">или вставь текст резюме
                <textarea id="lt-paste" rows="3" placeholder="Текст резюме или контакты…"></textarea>
              </label>
              <button class="ghost" id="lt-parse">Взять данные из текста</button>
              <div class="lt-fields">
                ${FIELDS.map(([k, label, ph]) => `<label class="fl">${label}<input id="lt-${k}" placeholder="${ph}"></label>`).join("")}
              </div>
              <div id="lt-otherwrap" hidden>
                <p class="muted small">Для другого человека текст не берётся из твоего профиля — опиши кратко по-немецки, иначе в письме будут подсвеченные места.</p>
                <label class="fl">Образование и опыт (1–2 предложения)
                  <textarea id="lt-background" rows="2" placeholder="Ich habe eine Ausbildung als … und arbeite seit … als …"></textarea>
                </label>
                <label class="fl">Что подходит к вакансии
                  <textarea id="lt-summary" rows="2" placeholder="In meiner Tätigkeit bei … habe ich …"></textarea>
                </label>
                <label class="fl">Языки
                  <input id="lt-languages" placeholder="Ich spreche Deutsch (B1) und …">
                </label>
              </div>
              <label class="fl">Дополнительный абзац (необязательно)
                <textarea id="lt-extra" rows="2" placeholder="Например: почему именно эта фирма"></textarea>
              </label>
            </details>
            <button class="primary" id="lt-make">Создать заново</button>
          </section>
          <section class="lt-result">
            <div class="lt-tools">
              <button class="primary" id="lt-ai">✨ Написать с ИИ</button>
              <button class="ghost" id="lt-aicfg" title="Настройки моста ИИ">⚙</button>
              <span class="lt-count" id="lt-count"></span>
              <button class="ghost" id="lt-next">К следующему пропуску</button>
              <button class="ghost" id="lt-pdf">Сохранить PDF</button>
              <button class="ghost" id="lt-docx">Сохранить Word</button>
            </div>
            <div class="lt-aiset" id="lt-aiset" hidden>
              <label class="fl">Адрес моста<input id="lt-burl" placeholder="https://round-forest-2940….workers.dev"></label>
              <label class="fl">Пароль моста<input id="lt-bkey" type="password" autocomplete="off"></label>
              <button class="ghost" id="lt-bcheck">Сохранить и проверить</button>
            </div>
            <p class="small lt-aistatus" id="lt-aistatus"></p>
            <div id="lt-editor" class="lt-editor" contenteditable="true" spellcheck="true" lang="de"></div>
            <p class="muted small">Текст можно править прямо здесь. Подсвеченные места — заполни или удали. Черновик для этой вакансии сохраняется автоматически.</p>
          </section>
        </div>
      </div>`;
    document.body.appendChild(root);

    $("#lt-close", root).onclick = close;
    root.addEventListener("click", e => { if (e.target === root) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !root.hidden) close(); });
    $("#lt-make", root).onclick = () => {
      const pend = LS.get(draftKey(), null);
      if (pend && !confirm("Создать письмо заново? Твои правки в тексте будут заменены.")) return;
      renderLetter(build(readMe()));
    };
    $("#lt-next", root).onclick = nextMark;
    $("#lt-ai", root).onclick = aiWrite;
    $("#lt-aicfg", root).onclick = () => toggleAISettings();
    $("#lt-bcheck", root).onclick = aiCheck;
    $("#lt-pdf", root).onclick = () => savePDF().catch(err => alert(err.message));
    $("#lt-docx", root).onclick = () => saveDOCX().catch(err => alert(err.message));
    $("#lt-editor", root).addEventListener("input", afterEdit);
    FIELDS.forEach(([k]) => $(`#lt-${k}`, root).addEventListener("change", readMe));
    $("#lt-extra", root).addEventListener("change", readMe);
    OTHER_FIELDS.forEach(k => $(`#lt-${k}`, root).addEventListener("change", readMe));
    $("#lt-person", root).onchange = e => { readMe(); LS.set("person", e.target.value); loadLetter(); };
    $("#lt-add", root).onclick = () => {
      const label = prompt("Как назвать (например: Анна, брат)?");
      if (!label || !label.trim()) return;
      readMe();
      const p = { id: "p" + Date.now().toString(36), label: label.trim(), mode: "other" };
      LS.set("people", [...people(), p]); LS.set("person", p.id);
      loadLetter(); $("#lt-datawrap", root).open = true;
    };
    $("#lt-del", root).onclick = () => {
      const me = current(); if (me.id === "me") return;
      if (!confirm(`Удалить «${me.label}» и его данные из этого браузера?`)) return;
      LS.set("people", people().filter(p => p.id !== me.id)); LS.set("person", "me"); loadLetter();
    };
    $("#lt-parse", root).onclick = () => applyParsed(parseCV($("#lt-paste", root).value), "текста");
    $("#lt-file", root).onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const msg = $("#lt-filemsg", root); msg.textContent = "Читаю файл…";
      try { applyParsed(parseCV(await readFile(f)), f.name); }
      catch (err) { msg.textContent = "Ошибка: " + err.message; }
      e.target.value = "";
    };
    return root;
  }

  function applyParsed(found, from) {
    const me = readMe();
    const got = [];
    FIELDS.forEach(([k, label]) => { if (found[k]) { me[k] = found[k]; got.push(label); } });
    me.hasSAP = !!found.hasSAP;
    if (found.text) me.cv = found.text.slice(0, 8000);
    savePerson(me); fillMe(me);
    $("#lt-filemsg", root).textContent = got.length
      ? `Из ${from} взято: ${got.join(", ")}. Проверь поля.`
      : `В ${from} не нашлось контактов — заполни поля вручную.`;
    renderLetter(build(me));
  }

  function open(j, profile) {
    cfg = (profile && profile.letter) || cfg;
    if (!cfg) { alert("Шаблоны писем не загружены."); return; }
    job = j;
    ensureRoot();
    const me = current();
    $("#lt-job", root).textContent = `${cleanTitle(j.title)} · ${j.employer || ""}`;
    loadLetter();
    // если данных ещё нет — раскрываем блок данных, иначе сворачиваем на телефоне
    $("#lt-datawrap", root).open = !me.name || window.innerWidth > 900;
    root.hidden = false;
    document.body.classList.add("lt-open");
  }

  function close() {
    root.hidden = true;
    document.body.classList.remove("lt-open");
  }

  return { open, _parseCV: parseCV, _cleanTitle: cleanTitle };
})();
