/**
 * Мост «Anschreiben с ИИ» для сайта jena-jobs.
 * Cloudflare Worker + Workers AI. Пароль хранится в секрете BRIDGE_PASSWORD.
 *
 * POST /check   — проверка пароля            → { ok: true }
 * POST /letter  — текст письма (только основная часть, без адресов)
 *   body: { job: {title, employer, place, beruf, type, minijob, qe, ref}, cv: "обезличенный текст резюме",
 *           notes: "доп. пожелания", lang_level: "B2/C1" }
 *   →    { text: "абзацы, разделённые пустой строкой", model, has_description }
 */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_CV = 7000;
const MAX_DESC = 4000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || "*"),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "jena-jobs bridge" });
    if (request.method !== "POST") return json({ error: "method" }, 405);

    // --- пароль
    if (!env.BRIDGE_PASSWORD) return json({ error: "BRIDGE_PASSWORD не задан в настройках Worker" }, 500);
    const key = request.headers.get("X-Bridge-Key") || "";
    if (!(await safeEqual(key, env.BRIDGE_PASSWORD))) return json({ error: "Неверный пароль" }, 401);

    if (url.pathname === "/check") return json({ ok: true });

    // «Очеловечить»: переписать готовый текст естественнее, не меняя фактов
    if (url.pathname === "/rewrite") {
      let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const text = String(b.text || "").slice(0, 6000);
      if (!text.trim()) return json({ error: "Пустой текст" }, 400);
      const sys = `Du überarbeitest den Haupttext eines deutschen Anschreibens, damit er natürlich und menschlich klingt.
- Inhalt und Fakten bleiben gleich. Nichts hinzufügen, nichts erfinden.
- Platzhalter in doppelten eckigen Klammern [[…]] unverändert übernehmen.
- Absätze beibehalten (durch Leerzeilen getrennt). Keine Anrede, keine Grußformel.
- Gib nur den überarbeiteten Text aus.
` + (b.focus === "simple" ? "- Studienabschlüsse, Führungserfahrung und Selbstständigkeit entfernen, falls sie vorkommen — die Stelle ist eine einfache Tätigkeit.\n" : "") + "\n" + STYLE;
      try {
        const res = await env.AI.run(MODEL, { messages: [{ role: "system", content: sys }, { role: "user", content: text }], max_tokens: 1100, temperature: 0.8 });
        const out = clean(res.response || "");
        return out ? json({ text: out, model: MODEL }) : json({ error: "Пустой ответ модели" }, 502);
      } catch (e) { return json({ error: "Ошибка ИИ: " + (e && e.message ? e.message : e) }, 502); }
    }

    if (url.pathname !== "/letter") return json({ error: "not found" }, 404);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const job = body.job || {};
    if (!job.title) return json({ error: "Нет данных вакансии" }, 400);

    const description = job.ref ? await fetchDescription(job.ref) : "";
    const cv = String(body.cv || "").slice(0, MAX_CV);

    const simple = body.focus === "simple";
    const messages = [
      { role: "system", content: SYSTEM + "\n\n" + (simple ? FOCUS_SIMPLE : FOCUS_FULL) },
      { role: "user", content: userPrompt(job, description, cv, String(body.notes || "").slice(0, 1500)) },
    ];

    try {
      const res = await env.AI.run(MODEL, { messages, max_tokens: 1100, temperature: 0.7 });
      const text = clean(res.response || "");
      if (!text) return json({ error: "Пустой ответ модели" }, 502);
      return json({ text, model: MODEL, has_description: !!description });
    } catch (e) {
      return json({ error: "Ошибка ИИ: " + (e && e.message ? e.message : e) }, 502);
    }
  },
};

const STYLE = `Stil — der Text soll klingen wie von einem echten Menschen geschrieben, nicht wie von einer KI:
- Einfache, klare Wörter. Kurze und mittellange Sätze abwechseln. Keine Schachtelsätze.
- Konkret statt allgemein: lieber eine echte Tätigkeit aus dem Lebenslauf nennen als Eigenschaften aufzählen.
- VERBOTEN sind diese typischen KI- und Bewerbungsfloskeln: "hiermit bewerbe ich mich", "mit großem Interesse", "Ich bin überzeugt, dass", "Darüber hinaus", "Zudem", "Des Weiteren", "leidenschaftlich", "dynamisch", "spannende Herausforderung", "wertvolle Erfahrungen", "ideale Kandidat", "bringe ich mit", "einen wertvollen Beitrag leisten", "teamfähig, belastbar und flexibel", "in einem dynamischen Umfeld", "meine Fähigkeiten einbringen".
- Keine Superlative, keine Übertreibungen, keine Aufzählungen mit Spiegelstrichen.
- Höchstens ein Satz über Motivation — ehrlich und bodenständig (z. B. warum genau diese Arbeit gerade passt).
- Höchstens zwei Sätze im ganzen Text dürfen mit "Ich" beginnen; Satzanfänge variieren (z. B. "In meinem …", "Dabei …", "Gern …", "Seit …").
- Der Schlussabsatz besteht aus genau zwei kurzen Sätzen: Verfügbarkeit, dann Gesprächswunsch.
- Ich-Form, freundlich, sachlich, Niveau B2–C1 — so, wie ein Bewerber mit gutem, aber nicht perfektem Deutsch schreiben würde.`;

const SYSTEM = `Du bist ein erfahrener deutscher Bewerbungsberater. Du schreibst den Hauptteil eines Anschreibens auf Deutsch.

Regeln:
- Schreibe NUR den Haupttext: keine Adressen, kein Datum, keinen Betreff, keine Anrede ("Sehr geehrte …") und keine Grußformel ("Mit freundlichen Grüßen").
- Absätze durch eine Leerzeile trennen.
- Verwende ausschließlich Fakten aus dem Lebenslauf und den Notizen. Erfinde nichts: keine Firmennamen, Zahlen, Zertifikate oder Kenntnisse, die nicht genannt sind.
- Anforderungen aus der Stellenanzeige (z. B. körperliche Belastbarkeit, Heben, Schichtbereitschaft, Führerschein, Staplerschein, Wochenendarbeit) NIEMALS als Eigenschaft des Bewerbers behaupten, wenn sie nicht im Lebenslauf oder in den Notizen stehen. Lieber weglassen.
- RELEVANZ: Nenne nur Erfahrungen und Qualifikationen, die für genau diese Stelle nützlich sind. Alles andere weglassen — auch wenn es im Lebenslauf steht.
- Wenn eine wichtige Angabe fehlt (z. B. Eintrittstermin oder Arbeitszeiten), setze einen Platzhalter in doppelten eckigen Klammern, z. B. [[ab sofort / ab TT.MM.JJJJ]].
- Beziehe dich konkret auf die Aufgaben der Stelle und zeige, welche Erfahrungen dazu passen.
- Beginne nie mit Einschränkungen oder Schwächen. Zeige zuerst, was passt; Lernbereitschaft danach und kurz.
- Letzter Absatz: Verfügbarkeit und Wunsch nach einem Gespräch, in einem natürlichen Satz.
- Gib nur den Text aus, ohne Überschrift und ohne Erklärungen.

` + STYLE;

// Einfache Tätigkeit / Minijob: keine Überqualifikation zeigen
const FOCUS_SIMPLE = `WICHTIG — einfache Tätigkeit bzw. Minijob:
- Erwähne KEINE Studienabschlüsse (Master, Bachelor, Studium), KEINE Führungserfahrung, KEINE Programmierkenntnisse und KEINE Selbstständigkeit als Unternehmer — das wirkt überqualifiziert und schreckt ab.
- Erwähne nur praktische, passende Erfahrung (z. B. Umgang mit Waren, Wareneingang, Verpacken, Versand, Kundenkontakt), Zuverlässigkeit, Pünktlichkeit, sorgfältiges Arbeiten, zeitliche Verfügbarkeit.
- Bei Minijob PFLICHT: ein Satz, dass man langfristig bleiben und später gern mehr Stunden übernehmen möchte.
- Erster Absatz: welche Stelle (Titel, Arbeitgeber) und warum sie gerade passt.
- 3 Absätze, insgesamt MINDESTENS 120 und höchstens 170 Wörter.`;

const FOCUS_FULL = `Länge: 4 Absätze, insgesamt 200–300 Wörter. Qualifikationen nur nennen, wenn sie zur Stelle passen.`;

function userPrompt(job, description, cv, notes) {
  const kind = job.type === "ausbildung" ? "Ausbildungsplatz" : job.minijob ? "Minijob" : "Stelle";
  return [
    `Art: ${kind}${job.qe ? " (Quereinstieg möglich)" : ""}`,
    `Stellentitel: ${job.title}`,
    job.employer ? `Arbeitgeber: ${job.employer}` : "",
    job.place ? `Ort: ${job.place}` : "",
    job.beruf ? `Beruf laut Jobbörse: ${job.beruf}` : "",
    description ? `\nStellenbeschreibung (Auszug):\n${description}` : "\n(Keine Stellenbeschreibung verfügbar — orientiere dich am Stellentitel.)",
    `\nLebenslauf des Bewerbers (anonymisiert):\n${cv || "(nicht angegeben — nutze Platzhalter für Erfahrungen)"}`,
    notes ? `\nZusätzliche Hinweise des Bewerbers:\n${notes}` : "",
  ].filter(Boolean).join("\n");
}

// Описание вакансии из Jobbörse der Bundesagentur für Arbeit (если доступно)
async function fetchDescription(ref) {
  const code = btoa(ref);
  const urls = [
    `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${encodeURIComponent(code)}`,
    `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v3/jobdetails/${encodeURIComponent(code)}`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { "X-API-Key": "jobboerse-jobsuche", "Accept": "application/json" } });
      if (!r.ok) continue;
      const d = await r.json();
      const raw = d.stellenangebotsBeschreibung || d.stellenbeschreibung || d.beschreibung || "";
      if (raw) return stripHtml(raw).slice(0, MAX_DESC);
    } catch { /* следующий вариант */ }
  }
  return "";
}

function stripHtml(s) {
  return String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// убираем то, что модель могла добавить лишнего
function clean(t) {
  return String(t)
    .replace(/^\s*(Betreff|Subject)[^\n]*\n/i, "")
    .replace(/^\s*Sehr geehrte[^\n]*\n/i, "")
    .replace(/\n\s*(Mit freundlichen Grüßen|Freundliche Grüße|Viele Grüße)[\s\S]*$/i, "")
    .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
