/**
 * Доказ того, чому Google Apps Script не може збирати дані з work.ua.
 *
 * Вставляється у Код.gs скрипта, прив'язаного до Google Таблиці
 * (Розширення → Apps Script), і запускається вручну.
 *
 * Результат обох функцій станом на вересень 2026:
 *   код 403 в обох спробах, а в тілі відповіді — сторінка Cloudflare
 *   «Перевірка надійності підключення до сайту … Enable JavaScript and
 *   cookies to continue … Ваша IP адреса: 34.116.22.3»
 *
 * 34.116.22.3 — адреса сервера Google. Cloudflare бачить запит із
 * дата-центру і вимагає виконати JavaScript. Apps Script цього не вміє:
 * він завантажує текст сторінки, але не виконує скрипти. Ні авторизація
 * як роботодавець, ні підміна User-Agent тут не допомагають — перевірка
 * стається до того, як work.ua взагалі дивиться, хто прийшов.
 *
 * Годиться як наочна демонстрація на воркшопі: дві хвилини, дві кнопки,
 * і сайт сам пояснює, чому «просто напиши скрипт» не працює.
 */

// Постав сюди своє посилання зі сторінки пошуку резюме на work.ua
var АДРЕСА = 'https://www.work.ua/resumes-kyiv-menedzher/';

var ЯК_БРАУЗЕР = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
};

/**
 * Спроба 1 — як Apps Script ходить за замовчуванням.
 * Спроба 2 — те саме, але прикидаємось браузером Chrome.
 * Якщо обидві дають 403 — справа не в тому, ким ми представляємось,
 * а в тому, звідки надходить запит.
 */
function testAccess() {
  var безМаскування = UrlFetchApp.fetch(АДРЕСА, {
    muteHttpExceptions: true,
    followRedirects: true
  });

  var якБраузер = UrlFetchApp.fetch(АДРЕСА, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: ЯК_БРАУЗЕР
  });

  Logger.log('Спроба 1 (без маскування): код ' + безМаскування.getResponseCode());
  Logger.log('Спроба 2 (як браузер):     код ' + якБраузер.getResponseCode());
  Logger.log('---');
  Logger.log('Що відповіли на спробу 2, перші 300 символів:');
  Logger.log(якБраузер.getContentText().substring(0, 300));
}

/**
 * Показує, що саме написано на сторінці, яку нам віддали замість резюме.
 * Прибирає розмітку і лишає живий текст — щоб було видно, що це
 * перевірка Cloudflare, а не пропозиція увійти як роботодавець.
 */
function testAccess2() {
  var відповідь = UrlFetchApp.fetch(АДРЕСА, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: ЯК_БРАУЗЕР
  });

  var html = відповідь.getContentText();

  var заголовок = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  Logger.log('Заголовок сторінки: ' + (заголовок ? заголовок[1].trim() : 'не знайдено'));
  Logger.log('---');

  var текст = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  Logger.log('Текст сторінки: ' + текст.substring(0, 600));
}
