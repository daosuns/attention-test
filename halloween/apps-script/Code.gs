/**
 * Сервер розіграшу «Погладь котика» (HRme School, Хелоуїн).
 *
 * Скрипт прив'язаний до Google Таблиці з двома аркушами:
 *   «Учасники»     — хто і що отримав;
 *   «Налаштування» — призи, ваги та параметри розіграшу.
 *
 * Точка входу — doPost. Сторінка надсилає JSON з полем action:
 *   draw  — участь у розіграші (email, phone, channel, consent, hp);
 *   claim — натискання «Отримати подарунок» (token).
 *
 * Подарунок обирає ТІЛЬКИ цей скрипт. Сторінка лише показує результат.
 *
 * Корисні функції для запуску вручну (обрати у списку зверху → Run):
 *   setup()    — створює аркуші, заголовки та заповнює «Налаштування»;
 *   simulate() — розігрує 200 призів без запису й показує розподіл у журналі.
 */

var TZ = 'Europe/Kyiv';
var SHEET_PARTICIPANTS = 'Учасники';
var SHEET_SETTINGS = 'Налаштування';
var CONSULTATION_ID = 'consultation';
var YES = 'так';
var NO = 'ні';
var DATE_FORMAT = 'dd.MM.yyyy HH:mm:ss';

var PARTICIPANT_HEADERS = [
  '№', 'Дата і час', 'Email', 'Телефон', 'Телефон (нормалізований)', 'Канал',
  'ID подарунка', 'Подарунок', 'Забрав', 'Час «Отримати»', 'Токен'
];
// Номери колонок (з нуля) на аркуші «Учасники».
var COL = {
  NUM: 0, DATE: 1, EMAIL: 2, PHONE: 3, PHONE_NORM: 4, CHANNEL: 5,
  PRIZE_ID: 6, PRIZE: 7, CLAIMED: 8, CLAIMED_AT: 9, TOKEN: 10
};
// Формати комірок нового рядка: '@' — простий текст, щоб «+380…» не перетворився на число.
var ROW_FORMATS = ['0', DATE_FORMAT, '@', '@', '@', '@', '@', '@', '@', DATE_FORMAT, '@'];

var PRIZE_HEADERS = ['ID', 'Великий напис', 'Підпис', 'Вага', 'Активний'];
var DEFAULT_PRIZES = [
  ['discount_hunger', 'Знижка 20%', 'на курс «Рекрутинг в умовах кадрового голоду»', 30, YES],
  ['discount_agency', 'Знижка 20%', 'на курс «Своя рекрутингова агенція»', 30, YES],
  ['lesson_ads', 'Урок у записі', '«Таргетована реклама в рекрутингу»', 10, YES],
  ['lesson_owner', 'Урок у записі', '«Чи вам по дорозі з власником бізнесу»', 10, YES],
  ['lesson_negotiations', 'Урок у записі', '«Переговори з наймаючими менеджерами»', 10, YES],
  ['lesson_referral', 'Урок у записі', '«Приведи друга: як отримати більше кандидатів»', 10, YES],
  [CONSULTATION_ID, 'Золотий котик!', '30 хвилин особистої консультації з Ольгою Тарасевич', 0, YES]
];

// Параметри стоять на аркуші «Налаштування» в колонках H–J, окремо від таблиці призів,
// щоб нові рядки призів ніколи їх не зачепили.
var PARAMS_FIRST_COL = 8; // H
var PARAM_HEADERS = ['Параметр', 'Значення', 'Пояснення'];

var CHANNELS = { telegram: 'Telegram', viber: 'Viber', email: 'Email' };
var EMAIL_RE = /^[\p{L}\p{N}_][^\s@]*@[^\s@]+\.[^\s@.]{2,}$/u;
var TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var LOCK_WAIT_MS = 25000;


/* ============================== Вебзастосунок ============================== */

function doPost(e) {
  var result;
  try {
    var data = parseBody_(e);
    if (!data) {
      result = { status: 'invalid' };
    } else if (data.action === 'draw') {
      result = draw_(data);
    } else if (data.action === 'claim') {
      result = claim_(data);
    } else {
      result = { status: 'invalid' };
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = { status: 'error' };
  }
  return json_(result);
}

/** Відкрийте адресу вебзастосунку в браузері: якщо бачите {"status":"ok"} — скрипт працює. */
function doGet() {
  return json_({ status: 'ok', service: 'halloween-draw' });
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try {
    var data = JSON.parse(e.postData.contents);
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    return null;
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ================================== draw ================================== */

function draw_(d) {
  var form = validateForm_(d);
  if (form.errors.length) return { status: 'invalid', fields: form.errors };

  var ss = SpreadsheetApp.getActive();

  // Пастка для ботів: відповідаємо як зазвичай, але нічого не записуємо.
  if (String(d.hp || '').trim() !== '') {
    var fake = pickWeighted_(readSettings_(ss).prizes);
    if (!fake) throw new Error('Немає активних призів з вагою більше 0');
    return { status: 'new', prize: publicPrize_(fake), claimed: false, token: Utilities.getUuid() };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { status: 'error' };
  try {
    var settings = readSettings_(ss);
    var sheet = getParticipantsSheet_(ss);
    var rows = readParticipants_(sheet);

    var existing = findExisting_(rows, form.email, form.phoneNorm);
    if (existing) return existingResponse_(existing.values, settings);

    if (settings.endDate && new Date().getTime() > settings.endDate.getTime()) {
      return { status: 'closed' };
    }

    // Номер нового учасника = кількість унікальних учасників + 1.
    var number = rows.length + 1;
    var consultation = settings.byId[CONSULTATION_ID];
    var prize;
    if (number === settings.luckyNumber && !settings.consultationGiven &&
        consultation && consultation.active) {
      prize = consultation;
    } else {
      prize = pickWeighted_(settings.prizes);
    }
    if (!prize) throw new Error('Немає активних призів з вагою більше 0');

    var token = Utilities.getUuid();
    var row = [];
    row[COL.NUM] = number;
    row[COL.DATE] = new Date();
    row[COL.EMAIL] = form.email;
    row[COL.PHONE] = form.phone;
    row[COL.PHONE_NORM] = form.phoneNorm;
    row[COL.CHANNEL] = CHANNELS[form.channel];
    row[COL.PRIZE_ID] = prize.id;
    row[COL.PRIZE] = prize.title + ' — ' + prize.subtitle;
    row[COL.CLAIMED] = NO;
    row[COL.CLAIMED_AT] = '';
    row[COL.TOKEN] = token;

    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length)
      .setNumberFormats([ROW_FORMATS])
      .setValues([row]);
    // Позначку ставимо після запису рядка: якщо запис впаде, консультація не згорить.
    if (prize.id === CONSULTATION_ID) setParam_(ss, 'consultation_given', YES);
    SpreadsheetApp.flush();

    return { status: 'new', prize: publicPrize_(prize), claimed: false, token: token };
  } finally {
    lock.releaseLock();
  }
}

/** Перевіряє поля форми. Повертає нормалізовані значення та список полів з помилками. */
function validateForm_(d) {
  var errors = [];
  var email = String(d.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) errors.push('email');

  var phone = String(d.phone || '').trim();
  var phoneNorm = normalizePhone_(phone);
  if (!phoneNorm) errors.push('phone');

  var channel = String(d.channel || '').trim().toLowerCase();
  if (!CHANNELS.hasOwnProperty(channel)) errors.push('channel');

  if (d.consent !== true) errors.push('consent');

  return { errors: errors, email: email, phone: phone, phoneNorm: phoneNorm, channel: channel };
}

/**
 * Лише цифри; 0XXXXXXXXX → 380XXXXXXXXX (і 80XXXXXXXXX → 380XXXXXXXXX).
 * Іноземні номери приймаються як є. Від 10 до 15 цифр, інакше порожній рядок.
 */
function normalizePhone_(raw) {
  if (!raw || raw.length > 30) return '';
  if (!/^\+?[\d\s().\-]+$/.test(raw)) return '';
  var digits = raw.replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) digits = '38' + digits;
  else if (/^80\d{9}$/.test(digits)) digits = '3' + digits;
  if (digits.length < 10 || digits.length > 15) return '';
  return digits;
}

function findExisting_(rows, email, phoneNorm) {
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i].values;
    if (String(v[COL.EMAIL]).trim().toLowerCase() === email ||
        String(v[COL.PHONE_NORM]).trim() === phoneNorm) {
      return rows[i];
    }
  }
  return null;
}

function existingResponse_(v, settings) {
  var id = String(v[COL.PRIZE_ID]).trim();
  var prize = settings.byId[id];
  if (!prize) {
    // Приз прибрали з «Налаштувань» — беремо текст, збережений у рядку учасника.
    var text = String(v[COL.PRIZE]);
    var sep = text.indexOf(' — ');
    prize = sep >= 0
      ? { id: id, title: text.slice(0, sep), subtitle: text.slice(sep + 3) }
      : { id: id, title: text, subtitle: '' };
  }
  return {
    status: 'existing',
    prize: publicPrize_(prize),
    claimed: isYes_(v[COL.CLAIMED]),
    token: String(v[COL.TOKEN])
  };
}

/** Зважений випадковий вибір серед активних призів з вагою > 0. Консультація сюди не потрапляє ніколи. */
function pickWeighted_(prizes) {
  var pool = prizes.filter(function (p) {
    return p.active && p.weight > 0 && p.id !== CONSULTATION_ID;
  });
  var total = pool.reduce(function (sum, p) { return sum + p.weight; }, 0);
  if (!pool.length || total <= 0) return null;
  var r = Math.random() * total;
  for (var i = 0; i < pool.length; i++) {
    r -= pool[i].weight;
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function publicPrize_(p) {
  return { id: p.id, title: p.title, subtitle: p.subtitle };
}


/* ================================== claim ================================= */

function claim_(d) {
  var token = String(d.token || '').trim();
  if (!TOKEN_RE.test(token)) return { status: 'not_found' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { status: 'error' };
  try {
    var sheet = getParticipantsSheet_(SpreadsheetApp.getActive());
    var cell = sheet.getRange(1, COL.TOKEN + 1, Math.max(sheet.getLastRow(), 1), 1)
      .createTextFinder(token).matchEntireCell(true).findNext();
    if (!cell || cell.getRow() < 2) return { status: 'not_found' };

    var row = cell.getRow();
    var claimedCell = sheet.getRange(row, COL.CLAIMED + 1);
    if (!isYes_(claimedCell.getValue())) {
      claimedCell.setValue(YES);
      sheet.getRange(row, COL.CLAIMED_AT + 1).setNumberFormat(DATE_FORMAT).setValue(new Date());
      SpreadsheetApp.flush();
    }
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}


/* ============================ Робота з таблицею ============================ */

function getParticipantsSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_PARTICIPANTS);
  if (!sheet) throw new Error('Немає аркуша «' + SHEET_PARTICIPANTS + '». Запустіть setup().');
  return sheet;
}

/** Рядки учасників без заголовка і без порожніх рядків. */
function readParticipants_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, PARTICIPANT_HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (String(v[COL.EMAIL]).trim() === '' && String(v[COL.TOKEN]).trim() === '') continue;
    rows.push({ row: i + 2, values: v });
  }
  return rows;
}

function readSettings_(ss) {
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) throw new Error('Немає аркуша «' + SHEET_SETTINGS + '». Запустіть setup().');
  var last = Math.max(sheet.getLastRow(), 2);

  var prizes = [];
  var byId = {};
  sheet.getRange(2, 1, last - 1, PRIZE_HEADERS.length).getValues().forEach(function (r) {
    var id = String(r[0]).trim();
    if (!id) return;
    var p = {
      id: id,
      title: String(r[1]).trim(),
      subtitle: String(r[2]).trim(),
      weight: toNumber_(r[3]),
      active: isYes_(r[4])
    };
    prizes.push(p);
    byId[id] = p;
  });

  var params = {};
  sheet.getRange(2, PARAMS_FIRST_COL, last - 1, 2).getValues().forEach(function (r) {
    var key = String(r[0]).trim();
    if (key) params[key] = r[1];
  });

  return {
    prizes: prizes,
    byId: byId,
    luckyNumber: Math.round(toNumber_(params.lucky_number)),
    endDate: toDate_(params.end_date),
    consultationGiven: isYes_(params.consultation_given)
  };
}

function setParam_(ss, key, value) {
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  var last = Math.max(sheet.getLastRow(), 2);
  var keys = sheet.getRange(2, PARAMS_FIRST_COL, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sheet.getRange(i + 2, PARAMS_FIRST_COL + 1).setValue(value);
      return;
    }
  }
  throw new Error('На аркуші «' + SHEET_SETTINGS + '» немає параметра ' + key);
}

function isYes_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'так' || s === 'yes' || s === 'true' || s === '1' || s === 'да';
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(',', '.').trim());
  return isFinite(n) ? n : 0;
}

/** Дата з комірки: справжня дата або текст у форматі 31.10.2026 23:59. */
function toDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = String(v || '').trim();
  if (!s) return null;
  var formats = ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd.MM.yyyy'];
  for (var i = 0; i < formats.length; i++) {
    try {
      var d = Utilities.parseDate(s, TZ, formats[i]);
      if (d && !isNaN(d.getTime())) return d;
    } catch (err) { /* пробуємо наступний формат */ }
  }
  console.warn('Не вдалося прочитати end_date: ' + s + '. Розіграш не буде закрито автоматично.');
  return null;
}


/* ================================== setup ================================= */

/**
 * Створює обидва аркуші та заголовки, заповнює «Налаштування» призами й параметрами.
 * Безпечно запускати повторно: наявні дані не перезаписуються.
 */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  // Аркуш «Учасники»
  var p = ss.getSheetByName(SHEET_PARTICIPANTS) || ss.insertSheet(SHEET_PARTICIPANTS, 0);
  p.getRange(1, 1, 1, PARTICIPANT_HEADERS.length).setValues([PARTICIPANT_HEADERS])
    .setFontWeight('bold').setBackground('#d9cdff').setWrap(true).setVerticalAlignment('middle');
  p.setFrozenRows(1);
  var widths = [50, 150, 220, 150, 170, 90, 140, 360, 70, 150, 290];
  widths.forEach(function (w, i) { p.setColumnWidth(i + 1, w); });
  var maxRows = p.getMaxRows();
  if (maxRows > 1) {
    p.getRange(2, COL.PHONE + 1, maxRows - 1, 2).setNumberFormat('@');
    p.getRange(2, COL.TOKEN + 1, maxRows - 1, 1).setNumberFormat('@');
    p.getRange(2, COL.CLAIMED + 1, maxRows - 1, 1).setDataValidation(yesNoRule_());
  }

  // Аркуш «Налаштування»
  var s = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS, 1);
  s.getRange(1, 1, 1, PRIZE_HEADERS.length).setValues([PRIZE_HEADERS]);
  if (String(s.getRange(2, 1).getValue()).trim() === '') {
    s.getRange(2, 1, DEFAULT_PRIZES.length, PRIZE_HEADERS.length).setValues(DEFAULT_PRIZES);
  }
  s.getRange(2, 5, 50, 1).setDataValidation(yesNoRule_());

  s.getRange(1, PARAMS_FIRST_COL, 1, PARAM_HEADERS.length).setValues([PARAM_HEADERS]);
  if (String(s.getRange(2, PARAMS_FIRST_COL).getValue()).trim() === '') {
    var endDate = Utilities.parseDate('31.10.2026 23:59', TZ, 'dd.MM.yyyy HH:mm');
    s.getRange(2, PARAMS_FIRST_COL, 3, PARAM_HEADERS.length).setValues([
      ['lucky_number', 77, 'Номер учасника, який отримає консультацію'],
      ['end_date', endDate, 'Після цієї дати й часу (Київ) розіграш закривається'],
      ['consultation_given', NO, 'Сервер сам ставить «так», коли видасть консультацію']
    ]);
  }
  s.getRange(3, PARAMS_FIRST_COL + 1).setNumberFormat('dd.MM.yyyy HH:mm');
  s.getRange(4, PARAMS_FIRST_COL + 1).setDataValidation(yesNoRule_());

  [s.getRange(1, 1, 1, PRIZE_HEADERS.length), s.getRange(1, PARAMS_FIRST_COL, 1, PARAM_HEADERS.length)]
    .forEach(function (r) { r.setFontWeight('bold').setBackground('#d9cdff'); });
  s.setFrozenRows(1);
  [160, 160, 420, 70, 90, 30, 30, 170, 160, 380].forEach(function (w, i) { s.setColumnWidth(i + 1, w); });

  // Прибираємо порожній аркуш, який Google створює за замовчуванням.
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name !== SHEET_PARTICIPANTS && name !== SHEET_SETTINGS &&
        sh.getLastRow() === 0 && ss.getSheets().length > 2) {
      ss.deleteSheet(sh);
    }
  });

  console.log('Готово: аркуші «' + SHEET_PARTICIPANTS + '» і «' + SHEET_SETTINGS + '» на місці.');
  if (Session.getScriptTimeZone() !== TZ) {
    console.warn('Часовий пояс скрипта — ' + Session.getScriptTimeZone() +
      '. Змініть його на ' + TZ + ': Project Settings → Time zone.');
  }
}

function yesNoRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList([YES, NO], true)
    .setAllowInvalid(true).build();
}


/* ================================= simulate ================================ */

/**
 * Розігрує n призів (за замовчуванням 200) за поточними вагами з «Налаштувань».
 * Нічого не записує. Результат — у журналі виконання (Execution log).
 * Консультація тут не випадає: її отримує лише учасник з номером lucky_number.
 */
function simulate(n) {
  n = Number(n) > 0 ? Math.floor(Number(n)) : 200;
  var prizes = readSettings_(SpreadsheetApp.getActive()).prizes;
  var counts = {};
  prizes.forEach(function (p) { counts[p.id] = 0; });
  for (var i = 0; i < n; i++) {
    var p = pickWeighted_(prizes);
    if (!p) throw new Error('Немає активних призів з вагою більше 0');
    counts[p.id]++;
  }

  var pct = function (x) { return (Math.round(x / n * 1000) / 10) + '%'; };
  var discounts = 0;
  var lessons = 0;
  var lines = ['Симуляція: ' + n + ' розіграшів'];
  prizes.forEach(function (p) {
    var c = counts[p.id];
    if (p.id.indexOf('discount_') === 0) discounts += c;
    if (p.id.indexOf('lesson_') === 0) lessons += c;
    lines.push(p.id + ' (' + p.title + ' ' + p.subtitle + ', вага ' + p.weight + '): ' + c + ' — ' + pct(c));
  });
  lines.push('Разом знижок: ' + discounts + ' — ' + pct(discounts));
  lines.push('Разом уроків: ' + lessons + ' — ' + pct(lessons));
  console.log(lines.join('\n'));
  return counts;
}
