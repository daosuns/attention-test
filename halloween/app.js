/*
 * «Погладь котика» — логіка сторінки.
 *
 * Подарунок обирає лише сервер (Google Apps Script). Сторінка надсилає контакти,
 * дає погладити котика й «відкриває» результат, який уже прийшов із сервера.
 */
(function () {
  'use strict';

  var T = window.TEXTS || {};
  var API_URL = (window.CONFIG && window.CONFIG.API_URL) || '';
  var STORAGE_KEY = 'hrme-halloween-2026';
  var CONSULTATION_ID = 'consultation';
  var REQUEST_TIMEOUT_MS = 20000;
  var WAIT_BEFORE_PETTING_MS = 2500; // якщо сервер думає довше — даємо гладити, поки чекаємо
  var NO_PROGRESS_MS = 6000;
  var PET_FACTOR_TOUCH = 4;          // скільки «ширин котика» треба провести пальцем
  var PET_FACTOR_MOUSE = 6;          // мишка рухається швидше, тож шлях довший

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function $(id) { return document.getElementById(id); }
  var body = document.body;
  var cat = $('cat');
  var zone = $('petZone');
  var fx = $('fx');
  var bubble = $('bubble');
  var hand = $('hand');
  var form = $('form');
  var submitBtn = $('submitBtn');
  var claimBtn = $('claimBtn');
  var modal = $('modal');

  var flow = 0;          // номер поточного сценарію; старі таймери перевіряють його й зупиняються
  var draw = null;       // { promise, result } — поточний запит draw
  var current = null;    // { token, prize, claimed } — показаний подарунок

  /* ------------------------------------------------------------ Тексти */

  function applyTexts() {
    each('[data-t]', function (el) {
      var key = el.getAttribute('data-t');
      if (typeof T[key] === 'string') el.textContent = T[key];
    });
    each('[data-ph]', function (el) {
      var key = el.getAttribute('data-ph');
      if (typeof T[key] === 'string') el.placeholder = T[key];
    });
    if (T.closedLinkUrl) $('closedLink').href = T.closedLinkUrl;
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  /* ------------------------------------------------- Пам'ять у браузері */

  function loadSaved() {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (data && data.token && data.prize && data.prize.title) return data;
    } catch (e) { /* інкогніто або вбудований браузер — працюємо без пам'яті */ }
    return null;
  }

  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* див. вище */ }
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* див. вище */ }
  }

  /* --------------------------------------------------------------- API */

  function api(payload) {
    if (!/^https:\/\//.test(API_URL)) {
      console.error('config.js: вставте адресу вебзастосунку Apps Script у API_URL');
      return Promise.reject(new Error('API_URL is not configured'));
    }
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    // text/plain — «простий» запит без CORS preflight, Apps Script його приймає.
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function isPrizeResult(res) {
    return res && (res.status === 'new' || res.status === 'existing') &&
      res.token && res.prize && res.prize.title;
  }

  /* ------------------------------------------------------------ Екрани */

  function setView(name) {
    body.setAttribute('data-view', name);
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }

  var CAT_STATES = ['is-waiting', 'is-petting', 'is-purring', 'is-arching', 'is-glowing', 'has-scroll', 'is-asleep', 'is-gold'];

  function setCat(states) {
    CAT_STATES.forEach(function (s) {
      cat.classList.toggle(s, states.indexOf(s) >= 0);
    });
  }

  function say(text) {
    bubble.textContent = text || '';
    bubble.classList.toggle('show', !!text);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function motion(ms) { return reduceMotion ? Math.min(ms, 250) : ms; }

  /* ------------------------------------------------------------- Форма */

  var EMAIL_RE = /^[^\s@=+\-][^\s@]*@[^\s@]+\.[^\s@.]{2,}$/;

  function normalizePhone(raw) {
    if (!raw || raw.length > 30 || !/^\+?[\d\s().\-]+$/.test(raw)) return '';
    var digits = raw.replace(/\D/g, '');
    if (/^0\d{9}$/.test(digits)) digits = '38' + digits;
    else if (/^80\d{9}$/.test(digits)) digits = '3' + digits;
    return digits.length >= 10 && digits.length <= 15 ? digits : '';
  }

  function readForm() {
    var channel = form.querySelector('input[name="channel"]:checked');
    return {
      email: $('email').value.trim().toLowerCase(),
      phone: $('phone').value.trim(),
      channel: channel ? channel.value : '',
      consent: $('consent').checked,
      hp: $('website').value
    };
  }

  function validate(d) {
    var errors = [];
    if (!EMAIL_RE.test(d.email) || d.email.length > 254) errors.push('email');
    if (!normalizePhone(d.phone)) errors.push('phone');
    if (!d.channel) errors.push('channel');
    if (!d.consent) errors.push('consent');
    return errors;
  }

  var FIELD_ERRORS = {
    email: { el: 'email', text: 'errorEmail' },
    phone: { el: 'phone', text: 'errorPhone' },
    channel: { el: 'channel', text: 'errorChannel' },
    consent: { el: 'consent', text: 'errorConsent' }
  };

  function showFieldErrors(list) {
    Object.keys(FIELD_ERRORS).forEach(function (name) {
      setFieldError(name, list.indexOf(name) >= 0);
    });
    if (list.length) {
      var first = $(FIELD_ERRORS[list[0]].el);
      var focusable = first.tagName === 'FIELDSET' ? first.querySelector('input') : first;
      if (focusable) focusable.focus({ preventScroll: true });
      first.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    }
  }

  function setFieldError(name, on) {
    var cfg = FIELD_ERRORS[name];
    $(name + '-err').textContent = on ? T[cfg.text] : '';
    $(cfg.el).setAttribute('aria-invalid', on ? 'true' : 'false');
  }

  // Помилка поля зникає, щойно людина почала її виправляти.
  form.addEventListener('input', function (e) {
    var name = e.target.name;
    if (name === 'website') return;
    if (FIELD_ERRORS[name]) setFieldError(name, false);
    $('formError').textContent = '';
  });
  form.addEventListener('change', function (e) {
    if (FIELD_ERRORS[e.target.name]) setFieldError(e.target.name, false);
  });

  function setBusy(btn, busy, labelKey) {
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    btn.querySelector('.btn-label').textContent = T[labelKey] || '';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitBtn.disabled) return;
    var d = readForm();
    var errors = validate(d);
    showFieldErrors(errors);
    if (errors.length) return;
    startDraw(d);
  });

  /* ----------------------------------------------------------- Розіграш */

  function startDraw(d) {
    var myFlow = ++flow;
    $('formError').textContent = '';
    setBusy(submitBtn, true, 'submitWaiting');
    setCat(['is-waiting']);

    var payload = {
      action: 'draw', email: d.email, phone: d.phone,
      channel: d.channel, consent: d.consent, hp: d.hp
    };
    draw = { result: null };
    draw.promise = api(payload).then(null, function (err) {
      console.error(err);
      return { status: 'error' };
    }).then(function (res) {
      draw.result = res || { status: 'error' };
      if (isPrizeResult(res)) save({ token: res.token, prize: res.prize, claimed: !!res.claimed });
      return draw.result;
    });

    // Швидка відповідь — одразу переходимо далі. Повільна — даємо гладити, поки чекаємо.
    var timer = setTimeout(function () {
      if (myFlow === flow && body.getAttribute('data-view') === 'form') startPetting();
    }, WAIT_BEFORE_PETTING_MS);

    draw.promise.then(function (res) {
      if (myFlow !== flow) return;
      clearTimeout(timer);
      var view = body.getAttribute('data-view');
      if (view === 'effect') return; // ефект сам дочекається відповіді
      if (res.status === 'new' && isPrizeResult(res)) {
        if (view === 'form') startPetting();
      } else if (res.status === 'existing' && isPrizeResult(res)) {
        stopPetting();
        showPrize(res, res.claimed ? 'claimed' : 'returning', true);
      } else {
        stopPetting();
        handleFailure(res);
      }
    });
  }

  function handleFailure(res) {
    flow++;
    setBusy(submitBtn, false, 'submit');
    if (res && res.status === 'closed') {
      showClosed();
      return;
    }
    setView('form');
    setCat([]);
    say('');
    if (res && res.status === 'invalid' && res.fields && res.fields.length) {
      showFieldErrors(res.fields.filter(function (f) { return FIELD_ERRORS[f]; }));
    } else {
      $('formError').textContent = T.errorServer || '';
    }
  }

  /* ------------------------------------------------------------ Гладження */

  var pet = {
    active: false, progress: 0, last: null,
    noProgressTimer: 0, pettingTimer: 0, lastSparkAt: 0
  };

  function startPetting() {
    setBusy(submitBtn, false, 'submit');
    setView('pet');
    setCat([]);
    say('');
    pet.active = true;
    pet.progress = 0;
    pet.last = null;
    updateMeter();
    $('fallbackBtn').hidden = true;
    armNoProgressTimer();
  }

  function stopPetting() {
    pet.active = false;
    pet.last = null;
    clearTimeout(pet.noProgressTimer);
    clearTimeout(pet.pettingTimer);
    hand.classList.remove('show');
  }

  function armNoProgressTimer() {
    clearTimeout(pet.noProgressTimer);
    if (!$('fallbackBtn').hidden) return;
    pet.noProgressTimer = setTimeout(function () {
      if (pet.active) $('fallbackBtn').hidden = false;
    }, NO_PROGRESS_MS);
  }

  function updateMeter() {
    var pct = Math.round(Math.min(pet.progress, 1) * 100);
    $('meterFill').style.width = pct + '%';
    $('meter').setAttribute('aria-valuenow', String(pct));
    each('#hearts .heart', function (h, i) {
      h.classList.toggle('on', pet.progress >= (i + 1) / 5 - 0.001);
    });
  }

  function localPoint(clientX, clientY) {
    var r = zone.getBoundingClientRect();
    var x = clientX - r.left;
    var y = clientY - r.top;
    return { x: x, y: y, w: r.width, inside: x >= 0 && y >= 0 && x <= r.width && y <= r.height };
  }

  function onPetMove(clientX, clientY, kind, id) {
    if (!pet.active) return;
    var p = localPoint(clientX, clientY);
    if (kind !== 'mouse') moveHand(p);
    if (!p.inside) { pet.last = null; return; }

    if (pet.last && pet.last.id === id) {
      var dist = Math.sqrt(Math.pow(p.x - pet.last.x, 2) + Math.pow(p.y - pet.last.y, 2));
      // Великі стрибки (палець перескочив) не рахуємо.
      if (dist > 0.5 && dist < 120) {
        var factor = kind === 'mouse' ? PET_FACTOR_MOUSE : PET_FACTOR_TOUCH;
        addProgress(dist / (p.w * factor), p);
      }
    }
    pet.last = { x: p.x, y: p.y, id: id };
  }

  function addProgress(delta, p) {
    pet.progress = Math.min(1, pet.progress + delta);
    updateMeter();
    armNoProgressTimer();

    cat.classList.add('is-petting');
    say(T.petting);
    clearTimeout(pet.pettingTimer);
    pet.pettingTimer = setTimeout(function () {
      cat.classList.remove('is-petting');
      if (pet.active) say('');
    }, 450);

    var now = Date.now();
    if (!reduceMotion && now - pet.lastSparkAt > 90) {
      pet.lastSparkAt = now;
      spark(p.x, p.y, {
        dx: rand(-30, 30), dy: rand(-70, -35), size: rand(5, 10),
        color: pick(['#ffd51e', '#d9cdff', '#ffffff']), time: 0.9
      });
    }

    if (pet.progress >= 1) finishPetting();
  }

  function moveHand(p) {
    hand.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
  }

  function finishPetting() {
    if (!pet.active) return;
    stopPetting();
    pet.progress = 1;
    updateMeter();
    runEffect();
  }

  if (window.PointerEvent) {
    zone.addEventListener('pointerdown', function (e) {
      if (!pet.active || e.pointerType === 'mouse') return;
      var p = localPoint(e.clientX, e.clientY);
      moveHand(p);
      hand.classList.add('show');
      pet.last = { x: p.x, y: p.y, id: e.pointerId };
    });
    zone.addEventListener('pointermove', function (e) {
      var events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (!events || !events.length) events = [e];
      for (var i = 0; i < events.length; i++) {
        onPetMove(events[i].clientX, events[i].clientY, e.pointerType, e.pointerId);
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
      zone.addEventListener(type, function () {
        hand.classList.remove('show');
        pet.last = null;
      });
    });
  } else {
    // Старі браузери без Pointer Events.
    zone.addEventListener('touchstart', function (e) {
      if (!pet.active) return;
      var t = e.touches[0];
      var p = localPoint(t.clientX, t.clientY);
      moveHand(p);
      hand.classList.add('show');
      pet.last = { x: p.x, y: p.y, id: 'touch' };
    }, { passive: true });
    zone.addEventListener('touchmove', function (e) {
      if (!pet.active) return;
      e.preventDefault();
      var t = e.touches[0];
      onPetMove(t.clientX, t.clientY, 'touch', 'touch');
    }, { passive: false });
    zone.addEventListener('touchend', function () { hand.classList.remove('show'); pet.last = null; });
    zone.addEventListener('mousemove', function (e) { onPetMove(e.clientX, e.clientY, 'mouse', 'mouse'); });
    zone.addEventListener('mouseleave', function () { pet.last = null; });
  }

  $('fallbackBtn').addEventListener('click', finishPetting);

  /* ---------------------------------------------------------------- Ефект */

  function runEffect() {
    var myFlow = flow;
    setView('effect');
    setCat(['is-purring']);
    say(T.purring);
    $('effectText').textContent = '';

    // Котик муркоче щонайменше трохи — і доти, доки не прийде відповідь сервера.
    Promise.all([draw.promise, wait(motion(1400))]).then(function (r) {
      if (myFlow !== flow) return;
      var res = r[0];
      if (!isPrizeResult(res)) { handleFailure(res); return; }

      var gold = res.prize.id === CONSULTATION_ID;
      setCat(['is-arching', 'is-glowing'].concat(gold ? ['is-gold'] : []));
      say('');
      $('effectText').textContent = T.scrollComing || '';
      burst(gold);

      wait(motion(1100)).then(function () {
        if (myFlow !== flow) return;
        setCat(['is-glowing', 'has-scroll'].concat(gold ? ['is-gold'] : []));
        return wait(motion(1000));
      }).then(function () {
        if (myFlow !== flow) return;
        var mode = res.status === 'new' ? 'new' : (res.claimed ? 'claimed' : 'returning');
        showPrize(res, mode, true);
      });
    });
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function spark(x, y, o) {
    if (fx.childElementCount > 80) return;
    var s = document.createElement('span');
    s.className = 'spark' + (o.star ? ' star' : '');
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.setProperty('--dx', o.dx + 'px');
    s.style.setProperty('--dy', o.dy + 'px');
    s.style.setProperty('--s', o.size + 'px');
    s.style.setProperty('--c', o.color);
    s.style.setProperty('--t', o.time + 's');
    s.style.setProperty('--delay', (o.delay || 0) + 's');
    s.style.setProperty('--r', rand(-180, 180) + 'deg');
    var remove = function () { if (s.parentNode) s.parentNode.removeChild(s); };
    s.addEventListener('animationend', remove);
    setTimeout(remove, (o.time + (o.delay || 0)) * 1000 + 400);
    fx.appendChild(s);
  }

  function burst(gold) {
    if (reduceMotion) return;
    var w = zone.clientWidth;
    var h = zone.clientHeight;
    var colors = gold
      ? ['#ffd51e', '#ffc61a', '#fff3b0', '#ffe066', '#ffffff']
      : ['#ffd51e', '#d9cdff', '#ffffff', '#7b5be1'];
    var count = gold ? 56 : 30;
    for (var i = 0; i < count; i++) {
      var angle = rand(0, Math.PI * 2);
      var dist = rand(w * 0.3, w * (gold ? 0.75 : 0.55));
      var fromEyes = i % 2 === 0;
      spark(w * (fromEyes ? 0.5 : rand(0.3, 0.7)), h * (fromEyes ? 0.36 : 0.85), {
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        size: rand(gold ? 7 : 5, gold ? 16 : 11),
        color: pick(colors),
        star: gold ? i % 3 !== 0 : i % 4 === 0,
        time: rand(0.8, 1.3),
        delay: rand(0, 0.25)
      });
    }
  }

  /* ------------------------------------------------------------ Подарунок */

  function showPrize(data, mode, animate) {
    flow++;
    stopPetting();
    current = { token: data.token, prize: data.prize, claimed: !!data.claimed };
    var gold = data.prize.id === CONSULTATION_ID;

    $('prizeIntro').textContent = mode === 'returning' ? T.returningIntro : T.prizeIntro;
    $('prizeTitle').textContent = data.prize.title;
    $('prizeSubtitle').textContent = data.prize.subtitle || '';
    $('claimError').textContent = '';
    setBusy(claimBtn, false, 'claimButton');
    setClaimed(current.claimed);

    var scroll = $('scroll');
    scroll.classList.toggle('is-gold', gold);
    scroll.classList.remove('unfurl');

    setView('prize');
    setCat(gold ? ['is-gold'] : []);
    say('');

    if (animate && !reduceMotion) {
      var paper = scroll.querySelector('.paper');
      scroll.style.setProperty('--half', (paper.offsetHeight / 2) + 'px');
      void scroll.offsetWidth; // перезапуск анімації
      scroll.classList.add('unfurl');
      if (gold) setTimeout(function () { burst(true); }, 900);
    }
  }

  function setClaimed(claimed) {
    claimBtn.hidden = claimed;
    $('claimedNote').hidden = !claimed;
  }

  claimBtn.addEventListener('click', function () {
    if (!current || claimBtn.disabled) return;
    var data = current;
    $('claimError').textContent = '';
    setBusy(claimBtn, true, 'claimWaiting');

    api({ action: 'claim', token: data.token }).then(function (res) {
      if (res && res.status === 'ok') {
        data.claimed = true;
        save(data);
        openModal();
      } else if (res && res.status === 'not_found') {
        forget();
        current = null;
        flow++;
        setView('form');
        setCat([]);
        $('formError').textContent = T.notFound || '';
      } else {
        throw new Error('claim: ' + (res && res.status));
      }
    }).then(null, function (err) {
      console.error(err);
      setBusy(claimBtn, false, 'claimButton');
      $('claimError').textContent = T.errorServer || '';
    });
  });

  /* --------------------------------------------------------------- Поп-ап */

  function openModal() {
    modal.hidden = false;
    $('modalBtn').focus();
    document.addEventListener('keydown', onModalKey);
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    document.removeEventListener('keydown', onModalKey);
    setBusy(claimBtn, false, 'claimButton');
    setClaimed(true);
    $('claimedNote').setAttribute('tabindex', '-1');
    $('claimedNote').focus({ preventScroll: true });
  }

  function onModalKey(e) {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Tab') { e.preventDefault(); $('modalBtn').focus(); }
  }

  $('modalBtn').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  /* ------------------------------------------------- Розіграш завершено */

  function showClosed() {
    stopPetting();
    setView('closed');
    setCat(['is-asleep']);
    say(T.sleeping || 'Z-z-z…');
  }

  /* ---------------------------------------------------------------- Старт */

  applyTexts();
  var saved = loadSaved();
  if (saved) {
    showPrize(saved, saved.claimed ? 'claimed' : 'returning', false);
  } else {
    setView('form');
  }
})();
