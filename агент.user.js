// ==UserScript==
// @name         Агент-рекрутер для work.ua
// @namespace    workua-helper
// @version      1.0
// @description  Гортає пошук резюме на work.ua, оцінює кандидатів через Gemini і складає їх у Google Таблицю
// @match        https://www.work.ua/*
// @match        https://work.ua/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // Налаштування
  // ═══════════════════════════════════════════════════════════════════

  var ЗА_ЗАМОВЧУВАННЯМ = {
    адресаТаблиці: '',
    ключТаблиці: '',
    ключGemini: '',
    модель: 'gemini-3.5-flash-lite',
    відкриватиРезюмеВід: 50,   // з якого чорнового балу відкривати повне резюме
    паузаСторінки: 1200,       // мс між сторінками work.ua
    // Безкоштовний тариф рахує ЗАПИТИ, а не обсяг: 5 за хвилину, 20 за добу.
    // Тому пачки великі (токенів усе одно витрачається лише десята частина
    // дозволеного), а пауза з запасом під 5 запитів на хвилину.
    паузаGeminiСек: 13,
    пачкаКарток: 25,           // скільки карток за один запит до Gemini
    пачкаРезюме: 10            // скільки повних резюме за один запит
  };

  function налаштування() {
    var н = {};
    for (var к in ЗА_ЗАМОВЧУВАННЯМ) {
      var з = GM_getValue(к, ЗА_ЗАМОВЧУВАННЯМ[к]);
      н[к] = (з === '' || з === undefined || з === null) ? ЗА_ЗАМОВЧУВАННЯМ[к] : з;
    }
    return н;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Мережа
  // ═══════════════════════════════════════════════════════════════════

  function запит(параметри) {
    return new Promise(function (готово, зламалось) {
      GM_xmlhttpRequest({
        method: параметри.метод || 'GET',
        url: параметри.адреса,
        headers: параметри.заголовки || {},
        data: параметри.тіло,
        timeout: 60000,
        onload: function (в) { готово({ код: в.status, текст: в.responseText }); },
        onerror: function () { зламалось(new Error('Немає зв’язку з ' + параметри.адреса)); },
        ontimeout: function () { зламалось(new Error('Занадто довго чекали відповіді')); }
      });
    });
  }

  /** Звертання до Apps Script у таблиці */
  async function доТаблиці(дія, дані) {
    var н = налаштування();
    if (!н.адресаТаблиці) throw new Error('Не вказано адресу таблиці в налаштуваннях');

    var тіло = Object.assign({ дія: дія, ключ: н.ключТаблиці }, дані || {});

    var в = await запит({
      метод: 'POST',
      адреса: н.адресаТаблиці,
      // text/plain — щоб браузер не питав у Apps Script зайвого дозволу
      заголовки: { 'Content-Type': 'text/plain;charset=utf-8' },
      тіло: JSON.stringify(тіло)
    });

    var відповідь;
    try {
      відповідь = JSON.parse(в.текст);
    } catch (e) {
      throw new Error('Таблиця відповіла незрозуміло. Найчастіше це означає, що ' +
                      'у розгортку не стоїть «Хто має доступ: Усі».');
    }

    if (!відповідь.ok) throw new Error('Таблиця: ' + відповідь.помилка);
    return відповідь;
  }

  /** Звертання до Gemini */
  var часОстанньогоGemini = 0;

  async function доGemini(підказка, схема) {
    var н = налаштування();
    if (!н.ключGemini) throw new Error('Не вказано ключ Gemini в налаштуваннях');

    // Не частіше, ніж дозволяє безкоштовний тариф
    var чекати = (Number(н.паузаGeminiСек) || 13) * 1000 - (Date.now() - часОстанньогоGemini);
    if (чекати > 0) await пауза(чекати);
    часОстанньогоGemini = Date.now();

    var адреса = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                 encodeURIComponent(н.модель) + ':generateContent?key=' +
                 encodeURIComponent(н.ключGemini);

    var тіло = {
      contents: [{ parts: [{ text: підказка }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: схема
      }
    };

    var в = await запит({
      метод: 'POST',
      адреса: адреса,
      заголовки: { 'Content-Type': 'application/json' },
      тіло: JSON.stringify(тіло)
    });

    if (в.код === 429) {
      throw new Error('ЛІМІТ: безкоштовна норма запитів до Gemini на сьогодні вичерпана. ' +
                      'Прогрес збережено — запусти завтра, агент продовжить з того ж місця.');
    }
    if (в.код !== 200) {
      throw new Error('Gemini відповів кодом ' + в.код + ': ' + в.текст.slice(0, 200));
    }

    var дані = JSON.parse(в.текст);
    var текст = дані &&
                дані.candidates &&
                дані.candidates[0] &&
                дані.candidates[0].content &&
                дані.candidates[0].content.parts &&
                дані.candidates[0].content.parts[0] &&
                дані.candidates[0].content.parts[0].text;

    if (!текст) throw new Error('Gemini повернув порожню відповідь');
    return JSON.parse(текст);
  }

  function пауза(мс) {
    return new Promise(function (r) { setTimeout(r, мс); });
  }

  /**
   * Питає в самого Google, які моделі доступні цьому ключу.
   * Так список ніколи не застаріє — Google міняє назви моделей часто.
   */
  async function списокМоделей() {
    var н = налаштування();
    if (!н.ключGemini) throw new Error('Спершу впиши ключ Gemini');

    var в = await запит({
      метод: 'GET',
      адреса: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' +
              encodeURIComponent(н.ключGemini)
    });

    if (в.код !== 200) throw new Error('Google відповів кодом ' + в.код);

    var моделі = (JSON.parse(в.текст).models || [])
      .filter(function (м) {
        return (м.supportedGenerationMethods || []).indexOf('generateContent') > -1;
      })
      .map(function (м) { return String(м.name).replace(/^models\//, ''); })
      .filter(function (і) { return і.indexOf('gemini') === 0 && і.indexOf('-tts') === -1; });

    // Легкі моделі вгору: у них щедріші безкоштовні ліміти
    моделі.sort(function (a, b) {
      var вагаA = (a.indexOf('lite') > -1 ? 0 : a.indexOf('flash') > -1 ? 1 : 2);
      var вагаB = (b.indexOf('lite') > -1 ? 0 : b.indexOf('flash') > -1 ? 1 : 2);
      return вагаA - вагаB || a.localeCompare(b);
    });

    return моделі;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Читання work.ua
  // ═══════════════════════════════════════════════════════════════════

  var ПЕРЕВІРКА_CLOUDFLARE = /Перевірка надійності підключення|Enable JavaScript and cookies/;

  async function сторінка(адреса) {
    var в = await fetch(адреса, { credentials: 'include' });
    var html = await в.text();

    if (ПЕРЕВІРКА_CLOUDFLARE.test(html)) {
      throw new Error('work.ua попросив перевірку безпеки. Відкрий сайт у вкладці, ' +
                      'дочекайся, поки сторінка завантажиться, і запусти ще раз.');
    }
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function адресаСторінки(базова, номер) {
    var u = new URL(базова, 'https://www.work.ua');
    u.searchParams.set('page', номер);
    return u.toString();
  }

  function скількиСторінок(doc) {
    var найбільша = 1;
    var посилання = doc.querySelectorAll('a[href*="page="]');
    for (var i = 0; i < посилання.length; i++) {
      var m = (посилання[i].getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) найбільша = Math.max(найбільша, parseInt(m[1], 10));
    }
    return найбільша;
  }

  function карткиЗіСторінки(doc) {
    var знайдені = [];
    var вжеБули = {};
    var посилання = doc.querySelectorAll('a[href*="/resumes/"]');

    for (var i = 0; i < посилання.length; i++) {
      var m = (посилання[i].getAttribute('href') || '').match(/\/resumes\/(\d+)/);
      if (!m) continue;

      var номер = m[1];
      if (вжеБули[номер]) continue;
      вжеБули[номер] = true;

      var el = посилання[i];
      for (var k = 0; k < 6 && el.parentElement; k++) {
        el = el.parentElement;
        if (el.textContent && el.textContent.trim().length > 120) break;
      }

      знайдені.push({
        номер: номер,
        посилання: 'https://www.work.ua/resumes/' + номер + '/',
        картка: прибратиОсобисте((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 700))
      });
    }
    return знайдені;
  }

  async function текстРезюме(посилання) {
    var doc = await сторінка(посилання);
    var текст = (doc.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

    // Відрізаємо шапку сайту й хвіст зі схожими резюме
    var початок = текст.indexOf('Резюме від');
    if (початок > 0) текст = текст.slice(початок);

    ['Схожі резюме', 'Ще резюме', 'Порівняти з іншими'].forEach(function (мітка) {
      var і = текст.indexOf(мітка);
      if (і > 500) текст = текст.slice(0, і);
    });

    return прибратиОсобисте(текст).slice(0, 4000);
  }

  /**
   * Страхувальна сітка: у Gemini не має потрапити нічого контактного,
   * навіть якщо work.ua колись почне це показувати.
   */
  function прибратиОсобисте(текст) {
    return String(текст)
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[пошта прихована]')
      .replace(/(?:\+?38)?[\s(-]*0\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[телефон прихований]')
      .replace(/Прізвище, контакти та світлина[^.]*\./g, '');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Оцінювання
  // ═══════════════════════════════════════════════════════════════════

  var СХЕМА = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        id:         { type: 'STRING'  },
        score:      { type: 'INTEGER' },
        why:        { type: 'STRING'  },
        position:   { type: 'STRING'  },
        city:       { type: 'STRING'  },
        age:        { type: 'STRING'  },
        experience: { type: 'STRING'  },
        salary:     { type: 'STRING'  }
      },
      required: ['id', 'score', 'why']
    }
  };

  function підказка(пошук, люди, повніРезюме) {
    var шапка =
      'Ти досвідчений рекрутер. Оцінюєш, наскільки кандидат підходить під вакансію.\n\n' +
      'ЯКОГО КАНДИДАТА ШУКАЄМО:\n' + (пошук.ідеальний || '(опис не заданий)') + '\n\n';

    if (пошук.стопСигнали) {
      шапка += 'СТОП-СИГНАЛИ (що дискваліфікує):\n' + пошук.стопСигнали + '\n' +
               'Якщо спрацював стоп-сигнал — бал не вище 30.\n\n';
    }

    шапка +=
      'ШКАЛА БАЛІВ:\n' +
      '80–100 — збігається все головне\n' +
      '60–79 — основне збігається, але є питання\n' +
      '40–59 — частковий збіг\n' +
      '0–39 — не той профіль\n\n' +
      'ПРАВИЛА:\n' +
      '• У полі why — одне-два речення, конкретно за фактами з тексту. ' +
      'Без загальних слів на кшталт «хороший кандидат».\n' +
      '• Поля position, city, age, experience, salary витягни з тексту як є. ' +
      'Чого в тексті немає — лишай порожнім, не вигадуй.\n' +
      '• experience — стисло: скільки років і в чому.\n' +
      '• Поверни рівно стільки обʼєктів, скільки кандидатів нижче, ' +
      'і збережи їхні id без змін.\n\n' +
      (повніРезюме
        ? 'Нижче — ПОВНІ тексти резюме.\n\n'
        : 'Нижче — КОРОТКІ картки зі списку пошуку. Оцінюй за тим, що є.\n\n') +
      'КАНДИДАТИ:\n';

    var тіло = люди.map(function (л) {
      return '=== id: ' + л.номер + ' ===\n' + (повніРезюме ? л.повне : л.картка);
    }).join('\n\n');

    return шапка + тіло;
  }

  async function оцінити(пошук, люди, повніРезюме) {
    var результат = await доGemini(підказка(пошук, люди, повніРезюме), СХЕМА);
    var заНомером = {};

    (результат || []).forEach(function (р) {
      if (р && р.id) заНомером[String(р.id).trim()] = р;
    });

    return люди.map(function (л) {
      var о = заНомером[л.номер];
      if (!о) return null;
      return {
        номер:      л.номер,
        посилання:  л.посилання,
        картка:     л.картка || '',
        бал:        Math.max(0, Math.min(100, Number(о.score) || 0)),
        чому:       о.why || '',
        посада:     о.position || '',
        місто:      о.city || '',
        вік:        о.age || '',
        досвід:     о.experience || '',
        зарплата:   о.salary || ''
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Головний цикл
  // ═══════════════════════════════════════════════════════════════════

  var зупинити = false;

  async function запустити(пошук, максСторінок, спочатку) {
    var н = налаштування();
    зупинити = false;

    var лічильники = { сторінок: 0, переглянуто: 0, нових: 0, записано: 0 };
    var помилки = [];

    журнал('Пошук: ' + пошук.назва);
    статус('Питаю таблицю, кого вже бачили…');

    var історія = (await доТаблиці('історія', { пошук: пошук.назва })).номери || [];
    var вжеБачили = {};
    історія.forEach(function (н) { вжеБачили[н] = true; });
    журнал('В «Історії» вже ' + історія.length + ' кандидатів — їх пропускаємо.');

    // Звідки продовжувати
    var ключПрогресу = 'прогрес::' + пошук.назва;
    if (спочатку) GM_setValue(ключПрогресу, 0);

    var прогрес = спочатку ? 0 : (GM_getValue(ключПрогресу, 0) || 0);
    var стартова = прогрес + 1;
    if (стартова > 1) журнал('Продовжую з сторінки ' + стартова + '.');

    статус('Читаю сторінку ' + стартова + '…');
    var перша = await сторінка(адресаСторінки(пошук.адреса, стартова));
    var всього = скількиСторінок(перша);

    if (стартова > всього) {
      var повідомлення = 'Цей пошук уже пройдено повністю (' + всього + ' сторінок). ' +
                         'Щоб пройти заново, постав галочку «почати спочатку».';
      статус(повідомлення);
      журнал(повідомлення);
      return;
    }

    var межа = максСторінок > 0 ? Math.min(стартова + максСторінок - 1, всього) : всього;
    журнал('Усього сторінок: ' + всього + '. Цього разу пройду до ' + межа + '.');

    var черга = [];

    for (var с = стартова; с <= межа; с++) {
      if (зупинити) { журнал('Зупинено на сторінці ' + с + '.'); break; }

      var doc;
      try {
        doc = (с === стартова) ? перша : await сторінка(адресаСторінки(пошук.адреса, с));
      } catch (e) {
        помилки.push('Сторінка ' + с + ': ' + e.message);
        журнал('⚠️ ' + e.message);
        break;
      }

      var картки = карткиЗіСторінки(doc);
      лічильники.сторінок++;
      лічильники.переглянуто += картки.length;

      if (картки.length === 0) {
        помилки.push('Сторінка ' + с + ': жодного резюме — можливо, змінилась верстка');
        журнал('⚠️ Сторінка ' + с + ': порожньо.');
      }

      var новіТут = 0;
      картки.forEach(function (к) {
        if (вжеБачили[к.номер]) return;
        вжеБачили[к.номер] = true;
        черга.push(к);
        новіТут++;
      });
      лічильники.нових += новіТут;

      статус('Сторінка ' + с + ' з ' + межа + ' · нових ' + лічильники.нових +
             ' · записано ' + лічильники.записано);

      // Назбирали достатньо — оцінюємо, щоб результат зʼявлявся в таблиці по ходу
      while (черга.length >= н.пачкаКарток * 3) {
        var порція = черга.splice(0, н.пачкаКарток * 3);
        лічильники.записано += await обробити(пошук, порція, н, помилки);
        GM_setValue(ключПрогресу, с);
      }

      GM_setValue(ключПрогресу, с);
      if (с < межа) await пауза(н.паузаСторінки);
    }

    if (черга.length && !зупинити) {
      лічильники.записано += await обробити(пошук, черга, н, помилки);
    }

    var підсумок = 'Готово · переглянуто ' + лічильники.переглянуто +
                   ' резюме, записано ' + лічильники.записано;

    статус(підсумок);
    журнал(підсумок);

    await доТаблиці('журнал', {
      рядок: {
        пошук: пошук.назва,
        сторінок: лічильники.сторінок,
        переглянуто: лічильники.переглянуто,
        нових: лічильники.нових,
        записано: лічильники.записано,
        помилки: помилки.slice(0, 5).join(' | ')
      }
    });
    await доТаблиці('статус', { пошук: пошук.назва, статус: підсумок });
  }

  /** Два проходи над однією порцією кандидатів */
  async function обробити(пошук, порція, н, помилки) {
    статус('Оцінюю ' + порція.length + ' кандидатів…');

    // ── Прохід 1: коротко, за картками ─────────────────────────────
    var чорнові = [];
    for (var i = 0; i < порція.length; i += н.пачкаКарток) {
      if (зупинити) break;
      var шматок = порція.slice(i, i + н.пачкаКарток);
      var оцінки = await оцінити(пошук, шматок, false);

      оцінки.forEach(function (о, j) {
        if (о) чорнові.push(о);
        else помилки.push('Gemini пропустив кандидата ' + шматок[j].номер);
      });
      журнал('Чорнова оцінка: ' + Math.min(i + н.пачкаКарток, порція.length) +
             ' з ' + порція.length);
    }

    // ── Прохід 2: повні резюме тих, хто пройшов поріг ──────────────
    var доУточнення = чорнові.filter(function (о) { return о.бал >= н.відкриватиРезюмеВід; });
    журнал('Варті повного резюме: ' + доУточнення.length + ' з ' + чорнові.length);

    var уточнені = {};
    for (var k = 0; k < доУточнення.length; k += н.пачкаРезюме) {
      if (зупинити) break;
      var група = доУточнення.slice(k, k + н.пачкаРезюме);
      var зТекстом = [];

      for (var g = 0; g < група.length; g++) {
        try {
          група[g].повне = await текстРезюме(група[g].посилання);
          зТекстом.push(група[g]);
        } catch (e) {
          // Резюме не відкрилось — людина лишається з чорновим балом,
          // вигадувати за неї нічого не будемо
          помилки.push('Резюме ' + група[g].номер + ': ' + e.message);
        }
        await пауза(н.паузаСторінки);
      }

      if (!зТекстом.length) continue;

      var точні = await оцінити(пошук, зТекстом, true);
      точні.forEach(function (о) { if (о) уточнені[о.номер] = о; });
      статус('Уточнено ' + Object.keys(уточнені).length + ' з ' + доУточнення.length);
    }

    // ── Складаємо в таблицю ────────────────────────────────────────
    var доЗапису = чорнові.map(function (о) {
      var фінальний = уточнені[о.номер] || о;
      return {
        номер:      фінальний.номер,
        посилання:  фінальний.посилання,
        бал:        фінальний.бал,
        чому:       фінальний.чому,
        посада:     фінальний.посада,
        місто:      фінальний.місто,
        вік:        фінальний.вік,
        досвід:     фінальний.досвід,
        зарплата:   фінальний.зарплата,
        записати:   фінальний.бал >= пошук.мінімальнийБал
      };
    });

    if (!доЗапису.length) return 0;

    var в = await доТаблиці('зберегти', { пошук: пошук.назва, кандидати: доЗапису });
    журнал('Записано ' + в.записано + (в.аркуш ? ' → аркуш «' + в.аркуш + '»' : ''));
    return в.записано;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Панель
  // ═══════════════════════════════════════════════════════════════════

  // work.ua має власні стилі для полів і галочок — вони перебивають наші
  // й роблять галочку невидимою. Ставимо захист саме для нашої панелі.
  var стилі = document.createElement('style');
  стилі.textContent =
    '#ар-панель, #ар-панель * { box-sizing:border-box; font-family:inherit; }' +
    '#ар-панель label { font-weight:400 !important; margin:0 !important; ' +
      'text-transform:none !important; letter-spacing:normal !important; }' +
    '#ар-панель input[type=checkbox] {' +
      '-webkit-appearance:checkbox !important; appearance:checkbox !important;' +
      'width:14px !important; height:14px !important; min-width:14px !important;' +
      'opacity:1 !important; position:static !important; display:inline-block !important;' +
      'margin:3px 0 0 0 !important; padding:0 !important; visibility:visible !important;' +
      'clip:auto !important; pointer-events:auto !important; }' +
    '#ар-панель button { font-family:inherit; line-height:normal; }';
  document.head.appendChild(стилі);

  var П = document.createElement('div');
  П.id = 'ар-панель';
  П.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483000;width:340px;' +
    'background:#111827;color:#f9fafb;border-radius:12px;padding:16px;' +
    'font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.45)';

  П.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<b style="font-size:15px;flex:1">Агент-рекрутер</b>' +
      '<span id="ар-шестерня" style="cursor:pointer;opacity:.6" title="Налаштування">⚙︎</span>' +
      '<span id="ар-згорнути" style="cursor:pointer;opacity:.6;font-size:17px;' +
        'line-height:1;user-select:none" title="Згорнути">–</span>' +
    '</div>' +
    '<div id="ар-міні" style="display:none;font-size:12px;opacity:.75;margin-top:6px"></div>' +
    '<div id="ар-тіло" style="margin-top:10px">' +
    '<div id="ар-робота">' +
      '<select id="ар-пошук" style="width:100%;padding:7px;border-radius:6px;border:1px solid #374151;background:#1f2937;color:#fff;margin-bottom:8px"></select>' +
      '<label style="display:block;opacity:.7;font-size:12px">Максимум сторінок за запуск (0 = усі)</label>' +
      '<input id="ар-сторінки" type="number" min="0" value="3" style="width:100%;padding:7px;border-radius:6px;border:1px solid #374151;background:#1f2937;color:#fff;margin:4px 0 8px">' +
      '<div id="ар-прогрес" style="font-size:12px;opacity:.7;margin-bottom:8px"></div>' +
      '<label style="display:flex;align-items:flex-start;gap:6px;font-size:12px;opacity:.75;margin-bottom:10px">' +
        '<input id="ар-спочатку" type="checkbox" style="margin-top:3px"><span id="ар-спочатку-підпис"></span>' +
      '</label>' +
      '<button id="ар-старт" style="width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Старт</button>' +
      '<button id="ар-стоп" style="width:100%;padding:7px;margin-top:6px;border:0;border-radius:8px;background:#374151;color:#fff;cursor:pointer;display:none">Зупинити</button>' +
      '<button id="ар-очистити" style="width:100%;padding:6px;margin-top:6px;border:1px solid #7f1d1d;border-radius:8px;background:transparent;color:#fca5a5;font-size:12px;cursor:pointer">Очистити історію по вакансії</button>' +
      '<div id="ар-статус" style="margin-top:10px;font-weight:600"></div>' +
      '<div id="ар-журнал" style="margin-top:8px;max-height:150px;overflow-y:auto;font-size:12px;opacity:.75;border-top:1px solid #374151;padding-top:8px"></div>' +
    '</div>' +
    '<div id="ар-налаштування" style="display:none"></div>' +
    '</div>';

  document.body.appendChild(П);

  var $ = function (id) { return П.querySelector('#' + id); };

  function статус(т) {
    $('ар-статус').textContent = т;
    $('ар-міні').textContent = т;   // щоб було видно й у згорнутому вигляді
  }

  function журнал(т) {
    var р = document.createElement('div');
    р.textContent = т;
    $('ар-журнал').appendChild(р);
    $('ар-журнал').scrollTop = $('ар-журнал').scrollHeight;
  }

  // ── Налаштування ─────────────────────────────────────────────────
  var ПОЛЯ = [
    ['адресаТаблиці',       'Адреса веб-застосунку таблиці', 'text'],
    ['ключТаблиці',         'Таємний ключ (як у Код.gs)',    'text'],
    ['ключGemini',          'Ключ Gemini з AI Studio',       'password'],
    ['відкриватиРезюмеВід', 'Відкривати повне резюме від балу', 'number'],
    ['пачкаКарток',         'Карток в одному запиті (чорнова оцінка)', 'number'],
    ['пачкаРезюме',         'Резюме в одному запиті (точна оцінка)',   'number'],
    ['паузаGeminiСек',      'Пауза між запитами до Gemini, секунд',    'number']
  ];

  var ПІДКАЗКИ_МОДЕЛЕЙ = {
    lite:  'найдешевша, найщедріші безкоштовні ліміти, оцінює грубіше',
    flash: 'золота середина — швидка й достатньо уважна',
    pro:   'найрозумніша, але ліміти найменші — на сотні сторінок не вистачить'
  };

  function підказкаПроМодель(назва) {
    if (назва.indexOf('lite') > -1)  return ПІДКАЗКИ_МОДЕЛЕЙ.lite;
    if (назва.indexOf('flash') > -1) return ПІДКАЗКИ_МОДЕЛЕЙ.flash;
    if (назва.indexOf('pro') > -1)   return ПІДКАЗКИ_МОДЕЛЕЙ.pro;
    return '';
  }

  function намалюватиНалаштування() {
    var н = налаштування();
    var html = '';

    ПОЛЯ.forEach(function (п) {
      html += '<label style="display:block;opacity:.7;font-size:12px;margin-top:8px">' + п[1] + '</label>' +
              '<input data-поле="' + п[0] + '" type="' + п[2] + '" value="' +
              String(н[п[0]]).replace(/"/g, '&quot;') +
              '" style="width:100%;padding:7px;border-radius:6px;border:1px solid #374151;background:#1f2937;color:#fff">';
    });

    html += '<label style="display:block;opacity:.7;font-size:12px;margin-top:8px">Модель Gemini</label>' +
            '<select id="ар-модель" style="width:100%;padding:7px;border-radius:6px;border:1px solid #374151;background:#1f2937;color:#fff">' +
              '<option value="' + String(н.модель).replace(/"/g, '&quot;') + '">' + н.модель + '</option>' +
            '</select>' +
            '<div id="ар-про-модель" style="font-size:11px;opacity:.6;margin-top:3px">' +
              підказкаПроМодель(н.модель) +
            '</div>' +
            '<button id="ар-моделі" style="width:100%;padding:6px;margin-top:6px;border:0;border-radius:6px;background:#374151;color:#fff;font-size:12px;cursor:pointer">Оновити список моделей</button>' +
            '<div id="ар-розрахунок" style="font-size:11px;opacity:.65;margin-top:10px;' +
              'line-height:1.45;border-top:1px solid #374151;padding-top:8px"></div>' +
            '<button id="ар-зберегти" style="width:100%;padding:9px;margin-top:12px;border:0;border-radius:8px;background:#10b981;color:#fff;font-weight:600;cursor:pointer">Зберегти</button>' +
            '<button id="ар-перевірити" style="width:100%;padding:7px;margin-top:6px;border:0;border-radius:8px;background:#374151;color:#fff;cursor:pointer">Перевірити звʼязок</button>' +
            '<div id="ар-перевірка" style="margin-top:8px;font-size:12px;opacity:.8"></div>';

    $('ар-налаштування').innerHTML = html;

    $('ар-модель').onchange = function () {
      $('ар-про-модель').textContent = підказкаПроМодель(this.value);
    };

    // Показує, у що виливаються обрані розміри пачок.
    // Безкоштовний тариф рахує запити, тож саме це визначає, скільки
    // кандидатів вдасться переглянути за день.
    function перерахувати() {
      var поле = function (імʼя) {
        var el = $('ар-налаштування').querySelector('[data-поле="' + імʼя + '"]');
        return Math.max(1, Number(el && el.value) || 1);
      };

      var карток = поле('пачкаКарток');
      var резюме = поле('пачкаРезюме');

      // приблизно 9 з 10 кандидатів проходять у другий прохід
      var запитівНаКандидата = 1 / карток + 0.9 / резюме;
      var наЗапит = 1 / запитівНаКандидата;

      $('ар-розрахунок').innerHTML =
        '≈ <b>' + наЗапит.toFixed(1) + '</b> кандидата на один запит до Gemini.<br>' +
        'При 20 безкоштовних запитах на добу це ≈ <b>' +
        Math.round(наЗапит * 20) + ' кандидатів на день</b>.';
    }

    ['пачкаКарток', 'пачкаРезюме'].forEach(function (імʼя) {
      var el = $('ар-налаштування').querySelector('[data-поле="' + імʼя + '"]');
      if (el) el.oninput = перерахувати;
    });
    перерахувати();

    $('ар-моделі').onclick = async function () {
      $('ар-перевірка').textContent = 'Питаю Google, які моделі тобі доступні…';
      try {
        // Ключ міг щойно змінитись і ще не бути збереженим
        var поле = $('ар-налаштування').querySelector('[data-поле="ключGemini"]');
        if (поле && поле.value.trim()) GM_setValue('ключGemini', поле.value.trim());

        var моделі = await списокМоделей();
        var поточна = $('ар-модель').value;
        if (моделі.indexOf(поточна) === -1) моделі.unshift(поточна);

        $('ар-модель').innerHTML = моделі.map(function (м) {
          return '<option value="' + м + '"' + (м === поточна ? ' selected' : '') + '>' + м + '</option>';
        }).join('');

        $('ар-про-модель').textContent = підказкаПроМодель(поточна);
        $('ар-перевірка').textContent = '✓ Доступно моделей: ' + моделі.length;
      } catch (e) {
        $('ар-перевірка').textContent = '✗ ' + e.message;
      }
    };

    $('ар-зберегти').onclick = function () {
      $('ар-налаштування').querySelectorAll('[data-поле]').forEach(function (inp) {
        var значення = inp.value.trim();
        GM_setValue(inp.getAttribute('data-поле'),
                    inp.type === 'number' ? Number(значення) : значення);
      });
      GM_setValue('модель', $('ар-модель').value);
      $('ар-перевірка').textContent = 'Збережено ✓';
      завантажитиПошуки();
    };

    $('ар-перевірити').onclick = async function () {
      $('ар-перевірка').textContent = 'Перевіряю…';
      try {
        var в = await доТаблиці('пошуки', {});
        $('ар-перевірка').textContent = '✓ Таблиця відповідає. Активних пошуків: ' + в.пошуки.length;
      } catch (e) {
        $('ар-перевірка').textContent = '✗ ' + e.message;
      }
    };
  }

  // ── Згортання панелі ─────────────────────────────────────────────
  function застосуватиЗгортання(згорнуто) {
    $('ар-тіло').style.display    = згорнуто ? 'none'  : 'block';
    $('ар-міні').style.display    = згорнуто ? 'block' : 'none';
    $('ар-шестерня').style.display = згорнуто ? 'none' : 'inline';
    $('ар-згорнути').textContent  = згорнуто ? '+' : '–';
    $('ар-згорнути').title        = згорнуто ? 'Розгорнути' : 'Згорнути';
    П.style.width   = згорнуто ? '210px' : '340px';
    П.style.padding = згорнуто ? '12px 14px' : '16px';
    GM_setValue('згорнуто', згорнуто);
  }

  $('ар-згорнути').onclick = function () {
    застосуватиЗгортання($('ар-тіло').style.display !== 'none');
  };

  $('ар-шестерня').onclick = function () {
    var відкрито = $('ар-налаштування').style.display !== 'none';
    $('ар-налаштування').style.display = відкрито ? 'none' : 'block';
    $('ар-робота').style.display = відкрито ? 'block' : 'none';
    if (!відкрито) намалюватиНалаштування();
  };

  // ── Список пошуків ───────────────────────────────────────────────
  var пошуки = [];

  /** Показує, де агент зупинився минулого разу для обраної вакансії */
  function оновитиПрогрес() {
    var пошук = пошуки[Number($('ар-пошук').value)];
    if (!пошук) {
      $('ар-прогрес').textContent = '';
      $('ар-спочатку-підпис').textContent = 'почати з першої сторінки';
      return;
    }

    var пройдено = GM_getValue('прогрес::' + пошук.назва, 0) || 0;

    if (пройдено > 0) {
      $('ар-прогрес').textContent = '↻ Минулого разу дійшли до сторінки ' + пройдено +
                                    '. Старт продовжить із ' + (пройдено + 1) + '-ї.';
      $('ар-спочатку-підпис').textContent =
        'забути це і почати з першої сторінки (тих, хто вже в «Історії», ' +
        'усе одно пропустимо — тож повторів не буде)';
    } else {
      $('ар-прогрес').textContent = '↻ Цей пошук ще не запускався — почнемо з першої сторінки.';
      $('ар-спочатку-підпис').textContent = 'почати з першої сторінки';
    }
  }

  async function завантажитиПошуки() {
    var н = налаштування();
    if (!н.адресаТаблиці) {
      статус('Спершу відкрий налаштування ⚙︎');
      return;
    }
    try {
      статус('Читаю завдання з таблиці…');
      пошуки = (await доТаблиці('пошуки', {})).пошуки || [];

      $('ар-пошук').innerHTML = пошуки.map(function (п, i) {
        return '<option value="' + i + '">' + п.назва + '</option>';
      }).join('');

      оновитиПрогрес();

      статус(пошуки.length
        ? 'Готова. Активних пошуків: ' + пошуки.length
        : 'В аркуші «Пошуки» немає рядків із «Активний = так»');
    } catch (e) {
      статус('✗ ' + e.message);
    }
  }

  $('ар-пошук').onchange = оновитиПрогрес;

  // ── Кнопки ───────────────────────────────────────────────────────
  $('ар-старт').onclick = function () {
    var пошук = пошуки[Number($('ар-пошук').value)];
    if (!пошук) { статус('Немає активного пошуку в таблиці'); return; }

    $('ар-старт').style.display = 'none';
    $('ар-стоп').style.display = 'block';
    $('ар-журнал').innerHTML = '';

    запустити(пошук, Number($('ар-сторінки').value) || 0, $('ар-спочатку').checked)
      .catch(function (e) {
        статус('✗ ' + e.message);
        журнал('✗ ' + e.message);
        доТаблиці('журнал', {
          рядок: { пошук: пошук.назва, помилки: e.message }
        }).catch(function () {});
      })
      .then(function () {
        $('ар-старт').style.display = 'block';
        $('ар-стоп').style.display = 'none';
        $('ар-спочатку').checked = false;
        оновитиПрогрес();
      });
  };

  $('ар-стоп').onclick = function () {
    зупинити = true;
    статус('Зупиняюсь після поточної сторінки…');
  };

  $('ар-очистити').onclick = async function () {
    var пошук = пошуки[Number($('ар-пошук').value)];
    if (!пошук) { статус('Спершу обери вакансію'); return; }

    var згода = confirm(
      'Очистити історію по вакансії «' + пошук.назва + '»?\n\n' +
      'Агент забуде, кого вже показував, і зможе оцінити цих людей заново — ' +
      'наприклад, за новим описом ідеального кандидата.\n\n' +
      'Закладка на сторінці теж скинеться: наступний запуск почнеться з першої.\n\n' +
      'Історія інших вакансій не постраждає.\n' +
      'Аркуш «Кандидати» НЕ чіпається — старі рядки з твоїми нотатками ' +
      'лишаться на місці, а нові додадуться поруч.'
    );
    if (!згода) return;

    this.disabled = true;
    статус('Чищу історію…');

    try {
      var в = await доТаблиці('очистити', { пошук: пошук.назва });
      GM_setValue('прогрес::' + пошук.назва, 0);
      оновитиПрогрес();

      var скільки = в.видалено;
      статус(скільки
        ? 'Історію очищено: забуто ' + скільки + ' кандидатів.'
        : 'В «Історії» по цій вакансії нічого не було.');
      журнал('Очищено історію по «' + пошук.назва + '»: ' + скільки);
    } catch (e) {
      статус('✗ ' + e.message);
    } finally {
      this.disabled = false;
    }
  };

  застосуватиЗгортання(GM_getValue('згорнуто', false) === true);
  завантажитиПошуки();
})();
