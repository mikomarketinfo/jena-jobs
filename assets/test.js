/* Тест профориентации: определяет 2–3 подходящих направления и превращает их в фильтры. */
window.CAREER_TEST = (function () {
  const DIRECTIONS = {
    handel: {
      name: "Торговля (Einzelhandel, супермаркеты, дрогерии)",
      keywords: ["Verkäufer", "Verkauf", "Einzelhandel", "Kassierer", "Filiale", "Markt", "Supermarkt", "Discounter", "Drogerie", "Handelsfachwirt"],
      path: "Verkäufer → Erstverkäufer / stellv. Filialleitung → Filialleitung. У дискаунтеров и сетей (Aldi, Lidl, Netto, Penny, Kaufland, dm, Rossmann) есть программы для будущих руководителей; с Ausbildung Kaufmann/-frau im Einzelhandel или опытом путь в 1–2 года реален.",
    },
    logistik: {
      name: "Склад и логистика",
      keywords: ["Lager", "Logistik", "Kommissionierer", "Lagerlogistik", "Versand", "Staplerfahrer", "Fachlagerist"],
      path: "Lagermitarbeiter → Schichtleiter / Vorarbeiter → Lagerleitung. Права на погрузчик (Staplerschein) и стабильность часто дают быстрый рост; Ausbildung Fachlagerist (2 года) ускоряет.",
    },
    gastro: {
      name: "Гастрономия и отели",
      keywords: ["Gastronomie", "Systemgastronomie", "Restaurant", "Service", "Hotel", "Küche", "Koch", "Barista", "Rezeption"],
      path: "Servicekraft / Crew → Schichtführer → Restaurantleitung. В Systemgastronomie (McDonald's, Burger King, Vapiano и т.п.) позиция Schichtführer часто достижима за 6–12 месяцев.",
    },
    buero: {
      name: "Офис, администрирование, клиентский сервис",
      keywords: ["Büro", "Kaufmann für Büromanagement", "Kauffrau für Büromanagement", "Verwaltung", "Kundenservice", "Sachbearbeiter", "Empfang", "Callcenter"],
      path: "Kundenservice / Bürokraft → Teamleitung Kundenservice. Нужен хороший немецкий (B2+); Ausbildung Kaufmann/-frau für Büromanagement — частый вход.",
    },
    produktion: {
      name: "Производство и техника",
      keywords: ["Produktion", "Produktionshelfer", "Maschinenbediener", "Montage", "Mechatroniker", "Elektroniker", "Industriemechaniker", "Fertigung"],
      path: "Produktionshelfer → Maschinenführer → Vorarbeiter / Schichtleiter. В Jena много оптики и техники (Zeiss, Jenoptik, Schott) — там ценят Ausbildung.",
    },
    pflege: {
      name: "Уход и социальная сфера",
      keywords: ["Pflege", "Pflegehelfer", "Pflegefachkraft", "Betreuung", "Altenpflege", "Erzieher", "Sozialassistent"],
      path: "Pflegehelfer → Pflegefachkraft (Ausbildung 3 года) → Wohnbereichsleitung. Работа надёжная, но до руководства обычно дольше 2 лет.",
    },
    it: {
      name: "IT (инфраструктура, сети, данные)",
      keywords: ["Fachinformatiker", "Systemintegration", "Digitale Vernetzung", "Prozessanalyse", "IT-System-Elektroniker", "Administrator", "IT-Support", "Helpdesk", "Netzwerk"],
      path: "Ausbildung Fachinformatiker / IT-System-Elektroniker (с дипломом часто сокращается) → администратор → Teamleitung IT-Betrieb. Инфраструктура и сети менее подвержены замене ИИ, чем рутинное программирование.",
    },
    einkauf: {
      name: "Закупки и снабжение",
      keywords: ["Einkauf", "Einkäufer", "Beschaffung", "Groß- und Außenhandel", "Industriekaufmann", "Industriekauffrau", "Disposition", "Materialwirtschaft"],
      path: "Ausbildung Groß- und Außenhandelsmanagement / Industriekaufmann или прямой вход Sachbearbeiter Einkauf → Einkäufer → Teamleitung Einkauf.",
    },
    elektro: {
      name: "Электрика и техника зданий",
      keywords: ["Elektroniker", "Elektriker", "Energie- und Gebäudetechnik", "Betriebstechnik", "Elektrotechnik"],
      path: "Ausbildung / Umschulung Elektroniker → Vorarbeiter / Meister. Спрос очень высокий, ИИ практически не угрожает.",
    },
  };

  // каждая опция: текст и баллы по направлениям; flags — особые настройки фильтров
  const QUESTIONS = [
    { q: "Что тебе больше нравится?", a: [
      { t: "Общаться с покупателями и продавать", s: { handel: 3, gastro: 1, buero: 1 } },
      { t: "Работать руками, двигаться, что-то собирать или переносить", s: { logistik: 3, produktion: 2 } },
      { t: "Работать за компьютером и с документами", s: { buero: 3 } },
      { t: "Помогать людям, заботиться о ком-то", s: { pflege: 3, gastro: 1 } },
      { t: "Разбираться в компьютерах, системах и процессах", s: { it: 3, einkauf: 1 } },
      { t: "Договариваться с поставщиками, считать выгоду", s: { einkauf: 3, logistik: 1 } },
    ]},
    { q: "Какая обстановка тебе ближе?", a: [
      { t: "Магазин / торговый зал", s: { handel: 3 } },
      { t: "Склад, цех, производство", s: { logistik: 2, produktion: 3 } },
      { t: "Кафе, ресторан, отель", s: { gastro: 3 } },
      { t: "Офис", s: { buero: 2, einkauf: 2 } },
      { t: "IT-отдел, серверная", s: { it: 3 } },
      { t: "Объекты, мастерская", s: { elektro: 3, produktion: 1 } },
    ]},
    { q: "Хочешь ли ты руководить людьми через 1–2 года?", a: [
      { t: "Да, это главная цель", s: { handel: 2, gastro: 2, logistik: 1 }, f: { career: 2 } },
      { t: "Да, если получится", s: { handel: 1, logistik: 1, gastro: 1 }, f: { career: 1 } },
      { t: "Нет, важнее стабильность", s: { produktion: 1, buero: 1, pflege: 1 } },
    ]},
    { q: "Твой уровень немецкого сейчас?", a: [
      { t: "A1–A2", s: { logistik: 2, produktion: 2, gastro: 1 }, f: { lang: "low" } },
      { t: "B1", s: { handel: 1, logistik: 1, gastro: 1, produktion: 1 } },
      { t: "B2", s: { handel: 1, buero: 1, pflege: 1 } },
      { t: "C1 и выше", s: { buero: 2, handel: 1 } },
    ]},
    { q: "Готов(а) к сменам, вечерам и выходным?", a: [
      { t: "Да, без проблем", s: { gastro: 2, logistik: 1, handel: 1, pflege: 1 }, f: { shifts: true } },
      { t: "Иногда можно", s: { handel: 1 } },
      { t: "Нет, только будни днём", s: { buero: 2, produktion: 1 }, f: { shifts: false } },
    ]},
    { q: "Физическая нагрузка (стоять весь день, носить)?", a: [
      { t: "Нормально", s: { logistik: 2, handel: 1, gastro: 1, produktion: 1 } },
      { t: "Лучше умеренная", s: { handel: 1, buero: 1 } },
      { t: "Лучше без неё", s: { buero: 3 } },
    ]},
    { q: "Что тебе сейчас важнее?", a: [
      { t: "Сразу зарабатывать (работа)", s: {}, f: { mode: "job" } },
      { t: "Получить профессию (Ausbildung)", s: {}, f: { mode: "ausbildung" } },
      { t: "И то и другое смотрю", s: {}, f: { mode: "both" } },
      { t: "Пока только подработка (Minijob)", s: {}, f: { mode: "minijob" } },
    ]},
    { q: "Как ты будешь добираться?", a: [
      { t: "Только Jena (пешком, трамвай, автобус)", s: {}, f: { radius: 10 } },
      { t: "Поезд / региональный транспорт", s: {}, f: { radius: 25 } },
      { t: "Есть машина", s: { logistik: 1 }, f: { radius: 40 } },
    ]},
    { q: "Что уже было в твоём опыте?", a: [
      { t: "Продажи, касса, магазин", s: { handel: 3 } },
      { t: "Склад, доставка, водитель", s: { logistik: 3 } },
      { t: "Кухня, официант, отель", s: { gastro: 3 } },
      { t: "Офис, бухгалтерия, менеджмент", s: { buero: 3 } },
      { t: "Завод, стройка, ремонт", s: { produktion: 3 } },
      { t: "Уход, медицина, дети", s: { pflege: 3 } },
      { t: "IT, программирование, анализ систем", s: { it: 3 } },
      { t: "Закупки, свой бизнес / магазин", s: { einkauf: 3, logistik: 1 } },
      { t: "Электрика", s: { elektro: 3 } },
    ]},
    { q: "Был ли у тебя опыт руководства (бригадир, старший смены, свой бизнес)?", a: [
      { t: "Да", s: { handel: 1, logistik: 1, gastro: 1 }, f: { career: 1, lead: true } },
      { t: "Немного", s: {}, f: { career: 0 } },
      { t: "Нет", s: {} },
    ]},
  ];

  function evaluate(answers) {
    const score = {}; Object.keys(DIRECTIONS).forEach(k => score[k] = 0);
    const flags = { career: 0, mode: "both", radius: 30, shifts: null, lang: null, lead: false };
    answers.forEach((ai, qi) => {
      if (ai == null) return;
      const opt = QUESTIONS[qi].a[ai];
      Object.entries(opt.s || {}).forEach(([k, v]) => score[k] += v);
      Object.entries(opt.f || {}).forEach(([k, v]) => {
        if (k === "career") flags.career += v; else flags[k] = v;
      });
    });
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const top = ranked.filter(([, v], i) => i < 2 || (i === 2 && v >= ranked[0][1] * 0.7)).map(([k]) => k);

    const keywords = [...new Set(top.flatMap(k => DIRECTIONS[k].keywords))];
    const exclude = ["Arzt", "Ärztin", "Professor", "Senior", "Softwareentwickler", "Ingenieur"];
    if (flags.shifts === false) exclude.push("Nachtschicht", "Wochenende");
    if (flags.lang === "low") exclude.push("verhandlungssicher", "Deutsch C1");

    const filters = {
      keywords, exclude,
      radius_km: flags.radius,
      show_job: flags.mode !== "ausbildung",
      show_ausbildung: flags.mode === "ausbildung" || flags.mode === "both",
      minijob: flags.mode === "minijob" ? "only" : "include",
      worktime: ["vz", "tz", "mj", "snw", "praktikum", "unknown"],
      career_only: false,
      sort: flags.career >= 1 ? "career" : "date",
    };
    if (flags.shifts === false) filters.worktime = filters.worktime.filter(w => w !== "snw");
    return { date: new Date().toISOString().slice(0, 10), score, ranked, top, flags, filters };
  }

  return { DIRECTIONS, QUESTIONS, evaluate };
})();
