// ==UserScript==
// @name         Помічник рекрутера — крок 3, збирач
// @namespace    workua-helper
// @version      0.3
// @description  Обходить сторінки пошуку резюме на work.ua і збирає кандидатів
// @match        https://www.work.ua/resumes*
// @match        https://work.ua/resumes*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // На сторінці окремого резюме панель не потрібна — тільки на списку
  if (/\/resumes\/\d+/.test(location.pathname)) return;

  var ПАУЗА_МС = 1200;   // пауза між сторінками, щоб не навантажувати work.ua
  var зупинити = false;
  var кандидати = [];    // сюди накопичуємо знайдених

  // ---------------------------------------------------------------
  // Допоміжні функції
  // ---------------------------------------------------------------

  function чекати(мс) {
    return new Promise(function (r) { setTimeout(r, мс); });
  }

  // Будує адресу потрібної сторінки пошуку
  function адресаСторінки(n) {
    var u = new URL(location.href);
    u.searchParams.set('page', n);
    return u.toString();
  }

  // Скільки всього сторінок — беремо найбільший номер із блоку пагінації
  function скількиСторінок(doc) {
    var max = 1;
    var посилання = doc.querySelectorAll('a[href*="page="]');
    for (var i = 0; i < посилання.length; i++) {
      var m = (посилання[i].getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  }

  // Витягує кандидатів зі сторінки списку
  function розібратиСторінку(doc) {
    var знайдені = [];
    var вжеБули = {};
    var посилання = doc.querySelectorAll('a[href*="/resumes/"]');

    for (var i = 0; i < посилання.length; i++) {
      var href = посилання[i].getAttribute('href') || '';
      var m = href.match(/\/resumes\/(\d+)/);
      if (!m) continue;

      var id = m[1];
      if (вжеБули[id]) continue;   // те саме резюме може бути кілька разів на сторінці
      вжеБули[id] = true;

      // Піднімаємось від посилання вгору, поки не дійдемо до всієї картки
      var el = посилання[i];
      for (var k = 0; k < 6 && el.parentElement; k++) {
        el = el.parentElement;
        if (el.textContent && el.textContent.trim().length > 120) break;
      }

      var текст = (el.textContent || '').replace(/\s+/g, ' ').trim();

      знайдені.push({
        id: id,
        url: 'https://www.work.ua/resumes/' + id + '/',
        картка: текст.slice(0, 700)
      });
    }
    return знайдені;
  }

  // ---------------------------------------------------------------
  // Головний цикл
  // ---------------------------------------------------------------

  async function зібрати(скількиБрати) {
    зупинити = false;
    кандидати = [];
    var вжеБачили = {};

    статус('Читаю першу сторінку…');

    var перша = await fetch(адресаСторінки(1), { credentials: 'include' });
    var html = await перша.text();

    if (/Перевірка надійності підключення|Enable JavaScript and cookies/.test(html)) {
      статус('⛔️ work.ua попросив перевірку. Відкрий сайт у вкладці, пройди її та спробуй ще раз.');
      return;
    }

    var doc = new DOMParser().parseFromString(html, 'text/html');
    var всього = скількиСторінок(doc);
    var межа = Math.min(скількиБрати, всього);

    журнал('Усього сторінок у цьому пошуку: ' + всього + '. Беру ' + межа + '.');

    for (var с = 1; с <= межа; с++) {
      if (зупинити) { статус('Зупинено на сторінці ' + с + '.'); break; }

      var сторінкаDoc;
      if (с === 1) {
        сторінкаDoc = doc;
      } else {
        await чекати(ПАУЗА_МС);
        var відповідь = await fetch(адресаСторінки(с), { credentials: 'include' });
        var т = await відповідь.text();

        if (/Перевірка надійності підключення|Enable JavaScript and cookies/.test(т)) {
          статус('⛔️ work.ua попросив перевірку на сторінці ' + с + '. Зупиняюсь.');
          break;
        }
        сторінкаDoc = new DOMParser().parseFromString(т, 'text/html');
      }

      var зі_сторінки = розібратиСторінку(сторінкаDoc);
      var нових = 0;

      for (var j = 0; j < зі_сторінки.length; j++) {
        var к = зі_сторінки[j];
        if (вжеБачили[к.id]) continue;
        вжеБачили[к.id] = true;
        кандидати.push(к);
        нових++;
      }

      if (зі_сторінки.length === 0) {
        журнал('Сторінка ' + с + ': порожньо. Схоже, змінилась верстка або сторінки закінчились.');
      } else {
        журнал('Сторінка ' + с + ': +' + нових + ' (всього ' + кандидати.length + ')');
      }

      статус('Сторінка ' + с + ' з ' + межа + ' · зібрано ' + кандидати.length);
    }

    статус('Готово. Зібрано кандидатів: ' + кандидати.length);
    кнопкаКопіювати.style.display = 'block';
    console.log('Зібрані кандидати:', кандидати);
  }

  // ---------------------------------------------------------------
  // Панель
  // ---------------------------------------------------------------

  var панель = document.createElement('div');
  панель.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:999999;width:320px;' +
    'background:#1f2937;color:#fff;border-radius:12px;padding:16px;' +
    'font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.4)';

  панель.innerHTML =
    '<div style="font-weight:600;font-size:15px;margin-bottom:10px">Збирач кандидатів</div>' +
    '<label style="display:block;opacity:.8;margin-bottom:4px">Скільки сторінок пройти</label>';

  var поле = document.createElement('input');
  поле.type = 'number';
  поле.value = '3';
  поле.min = '1';
  поле.style.cssText =
    'width:100%;padding:7px 9px;border-radius:6px;border:1px solid #4b5563;' +
    'background:#111827;color:#fff;font-size:13px;margin-bottom:10px';
  панель.appendChild(поле);

  var кнопкаСтарт = document.createElement('button');
  кнопкаСтарт.textContent = 'Старт';
  кнопкаСтарт.style.cssText =
    'width:100%;padding:9px;border:0;border-radius:7px;background:#3b82f6;' +
    'color:#fff;font-size:14px;font-weight:600;cursor:pointer';
  панель.appendChild(кнопкаСтарт);

  var кнопкаСтоп = document.createElement('button');
  кнопкаСтоп.textContent = 'Зупинити';
  кнопкаСтоп.style.cssText =
    'width:100%;padding:7px;margin-top:6px;border:0;border-radius:7px;' +
    'background:#374151;color:#fff;font-size:13px;cursor:pointer;display:none';
  панель.appendChild(кнопкаСтоп);

  var рядокСтатусу = document.createElement('div');
  рядокСтатусу.style.cssText = 'margin-top:10px;font-weight:600';
  панель.appendChild(рядокСтатусу);

  var вікноЖурналу = document.createElement('div');
  вікноЖурналу.style.cssText =
    'margin-top:8px;max-height:140px;overflow-y:auto;font-size:12px;' +
    'opacity:.75;border-top:1px solid #374151;padding-top:8px';
  панель.appendChild(вікноЖурналу);

  var кнопкаКопіювати = document.createElement('button');
  кнопкаКопіювати.textContent = 'Скопіювати для таблиці';
  кнопкаКопіювати.style.cssText =
    'width:100%;padding:8px;margin-top:10px;border:0;border-radius:7px;' +
    'background:#10b981;color:#fff;font-size:13px;font-weight:600;' +
    'cursor:pointer;display:none';
  панель.appendChild(кнопкаКопіювати);

  document.body.appendChild(панель);

  function статус(т) { рядокСтатусу.textContent = т; }

  function журнал(т) {
    var р = document.createElement('div');
    р.textContent = т;
    вікноЖурналу.appendChild(р);
    вікноЖурналу.scrollTop = вікноЖурналу.scrollHeight;
  }

  кнопкаСтарт.onclick = function () {
    кнопкаСтарт.style.display = 'none';
    кнопкаСтоп.style.display = 'block';
    кнопкаКопіювати.style.display = 'none';
    вікноЖурналу.innerHTML = '';

    зібрати(parseInt(поле.value, 10) || 1).catch(function (e) {
      статус('Помилка: ' + e.message);
      console.error(e);
    }).then(function () {
      кнопкаСтарт.style.display = 'block';
      кнопкаСтоп.style.display = 'none';
    });
  };

  кнопкаСтоп.onclick = function () {
    зупинити = true;
    статус('Зупиняюсь після поточної сторінки…');
  };

  кнопкаКопіювати.onclick = function () {
    var рядки = кандидати.map(function (к) {
      return к.id + '\t' + к.url + '\t' + к.картка;
    });
    var текст = 'ID\tПосилання\tКартка\n' + рядки.join('\n');

    navigator.clipboard.writeText(текст).then(
      function () { кнопкаКопіювати.textContent = 'Скопійовано ✓'; },
      function () { кнопкаКопіювати.textContent = 'Не вийшло, дивись консоль'; }
    );
  };

  статус('Готова до роботи.');
})();
