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
    if (url.pathname !== "/letter") return json({ error: "not found" }, 404);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const job = body.job || {};
    if (!job.title) return json({ error: "Нет данных вакансии" }, 400);

    const description = job.ref ? await fetchDescription(job.ref) : "";
    const cv = String(body.cv || "").slice(0, MAX_CV);

    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(job, description, cv, String(body.notes || "").slice(0, 1500)) },
    ];

    try {
      const res = await env.AI.run(MODEL, { messages, max_tokens: 1100, temperature: 0.5 });
      const text = clean(res.response || "");
      if (!text) return json({ error: "Пустой ответ модели" }, 502);
      return json({ text, model: MODEL, has_description: !!description });
    } catch (e) {
      return json({ error: "Ошибка ИИ: " + (e && e.message ? e.message : e) }, 502);
    }
  },
};

const SYSTEM = `Du bist ein erfahrener deutscher Bewerbungsberater. Du schreibst den Hauptteil eines Anschreibens auf Deutsch.

Regeln:
- Schreibe NUR den Haupttext: keine Adressen, kein Datum, keinen Betreff, keine Anrede ("Sehr geehrte …") und keine Grußformel ("Mit freundlichen Grüßen").
- 4 bis 5 Absätze, insgesamt 220–320 Wörter. Absätze durch eine Leerzeile trennen.
- Verwende ausschließlich Fakten aus dem Lebenslauf und den Notizen. Erfinde nichts: keine Firmennamen, Zahlen, Zertifikate oder Kenntnisse, die nicht genannt sind.
- Wenn eine wichtige Angabe fehlt (z. B. Eintrittstermin, Arbeitszeiten, Gehaltswunsch nur falls in der Anzeige verlangt), setze einen Platzhalter in doppelten eckigen Klammern, z. B. [[ab sofort / ab TT.MM.JJJJ]].
- Beziehe dich konkret auf die Aufgaben und Anforderungen der Stelle und zeige, welche Erfahrungen dazu passen.
- Wenn die Erfahrung nicht exakt passt: betone Lernbereitschaft, schnelle Einarbeitung und übertragbare Erfahrungen — ehrlich, ohne Übertreibung.
- Keine Floskeln wie "hiermit bewerbe ich mich", "mit großem Interesse", "ich bin teamfähig, belastbar und flexibel". Natürlicher, klarer Stil, aktive Sätze, Sprachniveau B2–C1 (glaubwürdig für den Bewerber).
- Erster Absatz: Bezug auf die konkrete Stelle und warum sie passt. Letzter Absatz: Verfügbarkeit und Wunsch nach einem persönlichen Gespräch.
- Gib nur den Text aus, ohne Überschrift und ohne Erklärungen.`;

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
