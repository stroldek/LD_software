/* ZAMOVO 1.5.1 — browser UI.
   Classic script (not a module) so the interface also opens from a local file; the Excel builder is loaded lazily. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var isLocalPreview = window.location.protocol === 'file:';
  var KEY_STORE = 'ldm_access_key';
  var PAGES = {
    overview: ['СИСТЕМА УПРАВЛЕНИЯ ЛИДАМИ', 'Обзор'],
    account: ['ПОДКЛЮЧЕНИЕ', 'Аккаунт Telegram'],
    monitor: ['ТЕСТОВЫЙ МОНИТОРИНГ', 'Мониторинг чатов'],
    leads: ['ТЕСТОВАЯ БАЗА', 'Найденные пользователи'],
    journal: ['ЖУРНАЛ СОБЫТИЙ', 'Журнал']
  };
  var current = 'overview';
  var timers = { login: null, search: null };
  var leadsState = { page: 1, total: 0, q: '' };
  var dialogsCache = [];

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function setPill(el, label, kind) { if (!el) return; el.textContent = label; el.className = ('status-pill ' + (kind || '')).trim(); }
  function toast(message) {
    var t = $('toast'); if (!t) return;
    t.textContent = message; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function num(n) { return Number(n || 0).toLocaleString('ru-RU'); }

  function confirmModal(title, text, okLabel) {
    return new Promise(function (resolve) {
      var m = $('modal');
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      $('modalOk').textContent = okLabel || 'Подтвердить';
      m.addEventListener('close', function once() { m.removeEventListener('close', once); resolve(m.returnValue === 'ok'); });
      if (typeof m.showModal === 'function') m.showModal(); else resolve(window.confirm(text));
    });
  }

  // ---------- API ----------
  function getKey() { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { if (v) sessionStorage.setItem(KEY_STORE, v); else sessionStorage.removeItem(KEY_STORE); } catch (e) { /* storage may be blocked */ } }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + getKey() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'Сервер вернул не-JSON ответ (' + res.status + ').' }; })
        .then(function (data) {
          if (res.status === 401 || res.status === 429) { lock(res.status === 429 ? 'Слишком много неверных попыток. Подождите 10 минут.' : 'Ключ не принят.'); }
          if (!res.ok || data.ok === false) { var err = new Error(data.error || ('Ошибка ' + res.status)); err.status = res.status; throw err; }
          return data.data;
        });
    });
  }
  function post(path, body) { return api(path, { method: 'POST', body: body || {} }); }

  // ---------- gate ----------
  function lock(message) {
    setKey('');
    stopLoginPolling();
    $('shell').hidden = true;
    $('gate').hidden = false;
    $('gateError').textContent = message || '';
    $('gateKey').value = '';
    $('gateKey').focus();
  }
  function unlock() {
    $('gate').hidden = true;
    $('shell').hidden = false;
    route();
  }
  function tryEnter(key) {
    setKey(key);
    return api('/api/auth/check').then(unlock);
  }

  // ---------- routing ----------
  function route() {
    var name = (location.hash || '#overview').slice(1);
    if (!PAGES[name]) name = 'overview';
    current = name;
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) { p.hidden = p.getAttribute('data-page') !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) { a.classList.toggle('active', a.getAttribute('data-nav') === name); });
    $('pageEyebrow').textContent = PAGES[name][0];
    $('pageTitle').textContent = PAGES[name][1];
    stopLoginPolling();
    refresh();
  }
  function refresh() {
    if (isLocalPreview) return;
    var job = { overview: loadOverview, account: loadAccount, monitor: loadMonitor, leads: loadLeads, journal: loadMonitor }[current];
    job().catch(function (e) { if (e.status !== 401) toast(e.message); });
    refreshSide();
  }
  function refreshSide() {
    api('/api/tg/status').then(function (s) {
      var ok = s.state === 'connected';
      $('sideStatus').textContent = ok ? 'Telegram подключён' : 'Telegram не подключён';
      $('sideSub').textContent = ok && s.me ? ((s.me.firstName || '') + (s.me.username ? ' @' + s.me.username : '')).trim() : 'Технический прототип';
    }).catch(function () { /* side status is optional */ });
  }

  // ---------- overview ----------
  function loadOverview() {
    return api('/api/monitor/state').then(function (m) {
      var run = m.runStats || {}, periods = m.leadPeriods || {}, resources = m.resourceTotals || {}, running = !!m.settings.running;
      setPill($('dashRunPill'), running ? 'Работает' : 'Остановлен', running ? 'ok' : 'preview');
      $('dashDuration').textContent = run.started_at ? duration(run.started_at, running ? null : run.stopped_at) : '—';
      $('dashCycles').textContent = num(run.cycles); $('dashChats').textContent = num(run.chats_processed); $('dashMessages').textContent = num(run.messages_processed);
      $('dashLeadsToday').textContent = num(periods.today); $('dashLeadsWeek').textContent = num(periods.week); $('dashLeadsMonth').textContent = num(periods.month);
      var conversion = run.messages_processed ? Math.round((run.leads_generated / run.messages_processed) * 1000) / 10 : 0;
      $('dashConversion').textContent = run.messages_processed ? num(run.leads_generated) + ' / ' + num(run.messages_processed) + ' (' + conversion + '%)' : 'Нет данных за запуск';
      var today = resources.today || {}, week = resources.week || {};
      $('resourceToday').textContent = num(today.cycles || 0) + ' циклов · ' + num(today.messages || 0) + ' сообщений';
      $('resourceWeek').textContent = num(week.cycles || 0) + ' циклов · ' + num(week.messages || 0) + ' сообщений';
      $('resourceEstimate').textContent = 'AI tokens: 0 — AI-модуль не подключён. Для точных rows_read / rows_written и CPU сверяйтесь с Cloudflare Analytics; бесплатный потолок лидов оценочный, фактический ниже из-за служебных запросов и индексов.';
      populatePlan(m); populateTemplateSelects(m.templates || []);
      $('contactAccount').value = m.planGoal ? (m.planGoal.contact_username || '') : '';
    });
  }
  function duration(start, end) { var ms = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()); var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return h + 'ч ' + m + 'м ' + sec + 'с'; }
  function populateTemplateSelects(list) { var monitor = $('templateSelect'), plan = $('planTemplate'); if (!monitor || !plan) return; var selected = monitor.value, planSelected = plan.value; clear(monitor); clear(plan); monitor.appendChild(h('option', { value: '', text: 'Текущие условия' })); plan.appendChild(h('option', { value: '', text: 'Все фильтры' })); (list || []).forEach(function (t) { monitor.appendChild(h('option', { value: t.id, text: t.name })); plan.appendChild(h('option', { value: t.id, text: t.name })); }); monitor.value = selected; plan.value = planSelected; }
  function populatePlan(m) { var goal = m.planGoal || {}; if ($('planTarget') && goal.target_leads != null) $('planTarget').value = goal.target_leads || ''; if ($('planStatus')) $('planStatus').textContent = goal.enabled ? 'Цель: ' + num(goal.target_leads) + ' лидов' : 'Цель не задана'; var src = $('planSource'), selected = src.value; clear(src); src.appendChild(h('option', { value: '', text: 'Все источники' })); (m.sources || []).forEach(function (source) { src.appendChild(h('option', { value: source.id, text: source.title })); }); src.value = goal.source_id || selected || ''; if (goal.template_id) $('planTemplate').value = goal.template_id; }

  // ---------- account ----------
  function stopLoginPolling() { if (timers.login) { clearInterval(timers.login); timers.login = null; } }
  function startLoginPolling() {
    if (timers.login || current !== 'account') return;
    timers.login = setInterval(function () { api('/api/tg/status').then(renderAccount).catch(function () { /* next tick */ }); }, 2000);
  }

  function loadAccount() { return Promise.all([api('/api/tg/status'),api('/api/plan').catch(function(){return null;})]).then(function(r){if(r[1]&&r[1].goal)$('contactAccount').value=r[1].goal.contact_username||'';return renderAccount(r[0]);}); }

  function renderAccount(s) {
    if (current !== 'account') return;
    var credsPill = $('credsPill');
    if (s.hasCredentials) setPill(credsPill, s.credentialsSource === 'env' ? 'Ключи приложения · Cloudflare' : 'Ключи приложения сохранены', 'ok'); else setPill(credsPill, 'Нужны ключи приложения', 'error');
    $('credsForm').hidden = s.credentialsSource === 'env';

    var pillMap = { connected: ['Подключён', 'ok'], qr_pending: ['Ждём сканирования', 'preview'], code_pending: ['Ждём код', 'preview'], password_needed: ['Нужен пароль', 'preview'], connecting: ['Соединяемся…', 'preview'], error: ['Ошибка', 'error'], disconnected: ['Сессия сохранена', 'preview'], logged_out: ['Не подключён', 'error'] };
    var p = pillMap[s.state] || ['—', 'preview'];
    setPill($('loginPill'), p[0], p[1]);

    var body = $('loginBody');
    // Do not rebuild while the user is typing into a field of the same state.
    var sig = [s.state, s.stage, s.qr && s.qr.url, s.notice, s.error, s.passwordHint, s.hasCredentials].join('|');
    if (body.getAttribute('data-sig') === sig) { if (s.state !== 'connected' && s.state !== 'logged_out' && s.state !== 'error') startLoginPolling(); return; }
    body.setAttribute('data-sig', sig);
    clear(body);

    if (s.notice) body.appendChild(h('div', { class: 'result-message', text: s.notice }));
    if (s.error && (s.state === 'error' || s.state === 'logged_out' || s.state === 'disconnected')) body.appendChild(h('div', { class: 'result-message error', text: s.error }));

    if (s.state === 'connected' || s.state === 'disconnected') {
      var me = s.me || {};
      body.appendChild(h('div', { class: 'account-card' },
        h('div', { class: 'avatar', 'aria-hidden': 'true', text: (me.firstName || '?').slice(0, 1).toUpperCase() }),
        h('div', { class: 'account-info' },
          h('strong', { text: ((me.firstName || '') + ' ' + (me.lastName || '')).trim() || 'Аккаунт' }),
          h('span', { text: [me.username ? '@' + me.username : null, me.phoneMasked].filter(Boolean).join(' · ') || '—' }),
          h('small', { text: s.state === 'connected' ? 'Соединение активно' : 'Сессия сохранена — соединение откроется автоматически' })),
        h('button', { class: 'button button-danger', type: 'button', onclick: doLogout, text: 'Выйти из аккаунта' })));
      body.appendChild(h('p', { class: 'panel-text', text: 'Сессия хранится в зашифрованном виде на сервере. Мониторинг читает выбранные вами чаты. Отправка сообщений предусмотрена только для единичного уведомления о закрытии заданного плана на указанный контакт. Удаление аккаунта этим подключением не предусмотрено.' }));
      stopLoginPolling();
      return;
    }

    if (s.state === 'qr_pending' && s.qr) {
      var holder = h('div', { class: 'qr-box' });
      holder.innerHTML = window.QR ? window.QR.svg(s.qr.url, { fg: '#10151a', bg: '#ffffff', quiet: 3 }) : '';
      body.appendChild(h('div', { class: 'qr-layout' }, holder,
        h('ol', { class: 'qr-steps' },
          h('li', { text: 'Откройте Telegram на телефоне.' }),
          h('li', { text: 'Настройки → Устройства → Подключить устройство.' }),
          h('li', { text: 'Наведите камеру на этот QR-код.' }),
          h('li', { text: 'Если включена двухэтапная проверка, программа попросит пароль.' }),
          h('li', { class: 'muted', text: 'Код обновляется сам примерно раз в 30 секунд.' }))));
      body.appendChild(h('div', { class: 'form-row tight' },
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' }),
        h('button', { class: 'link-button', type: 'button', onclick: doStartPhoneForm, text: 'Войти вручную (по номеру телефона)' })));
      startLoginPolling();
      return;
    }

    if (s.state === 'code_pending') {
      var codeInput = h('input', { id: 'codeInput', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '12345', maxlength: '8' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Telegram отправил код входа в приложение Telegram на другом вашем устройстве (или SMS). Введите его:' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) { e.preventDefault(); doSend('/api/tg/login/code', { code: codeInput.value }); } },
        h('div', { class: 'field' }, h('label', { for: 'codeInput', text: 'Код' }), codeInput),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Подтвердить' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' })));
      setTimeout(function () { codeInput.focus(); }, 0);
      startLoginPolling();
      return;
    }

    if (s.state === 'password_needed') {
      var pw = h('input', { id: 'pwInput', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Включена двухэтапная проверка.' + (s.passwordHint ? ' Подсказка: ' + s.passwordHint + '.' : '') + ' Введите облачный пароль Telegram. Он передаётся только на ваш сервер и не сохраняется.' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) { e.preventDefault(); var v = pw.value; pw.value = ''; doSend('/api/tg/login/password', { password: v }); } },
        h('div', { class: 'field grow' }, h('label', { for: 'pwInput', text: 'Пароль' }), pw),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Войти' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' })));
      setTimeout(function () { pw.focus(); }, 0);
      startLoginPolling();
      return;
    }

    if (s.state === 'connecting') {
      var stageText = { connect: 'Устанавливаем шифрованное соединение с Telegram…', qr: 'Соединение есть, запрашиваем QR-код…', code: 'Соединение есть, запрашиваем код…' }[s.stage] || 'Соединяемся с Telegram…';
      body.appendChild(h('div', { class: 'result-message', text: stageText + ' Если это длится дольше минуты — нажмите «Отмена» и запустите «Диагностику».' }));
      body.appendChild(h('div', { class: 'form-row tight' }, h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' })));
      startLoginPolling();
      return;
    }

    // logged_out / error: offer both ways
    body.appendChild(h('p', { class: 'panel-text', text: 'Основной способ — QR-код: быстро и без SMS. Если QR не подходит, рядом есть вход по номеру телефона.' }));
    body.appendChild(h('div', { class: 'form-row tight' },
      h('button', { class: 'button button-primary', type: 'button', disabled: !s.hasCredentials, onclick: doStartQr, text: 'Показать QR-код' }),
      h('button', { class: 'link-button', type: 'button', disabled: !s.hasCredentials, onclick: doStartPhoneForm, text: 'Войти вручную (по номеру телефона)' })));
    if (!s.hasCredentials) body.appendChild(h('small', { class: 'hint', text: 'Сначала сохраните ключи на шаге 1.' }));
    stopLoginPolling();
  }

  function guard(fn) { return fn().catch(function (e) { if (e.status !== 401) toast(e.message); }); }
  function doSend(path, body) { return guard(function () { return post(path, body).then(renderAccount).then(refreshSide); }); }
  /** Shows the "connecting" view at once and polls the real status while the (slow) request is still running. */
  function showConnecting() { renderAccount({ state: 'connecting', stage: 'connect', hasCredentials: true }); startLoginPolling(); }
  function doStartQr() {
    showConnecting();
    return post('/api/tg/login/qr').then(renderAccount).catch(function (e) { if (e.status !== 401) { toast(e.message); guard(loadAccount); } });
  }
  function doCancel() { return guard(function () { return post('/api/tg/login/cancel').then(function (s) { $('loginBody').removeAttribute('data-sig'); return renderAccount(s); }); }); }
  function doStartPhoneForm() {
    // Cancel a running QR flow first, then ask for the number.
    guard(function () { return post('/api/tg/login/cancel'); }).then(function () {
      stopLoginPolling();
      var body = clear($('loginBody'));
      body.setAttribute('data-sig', 'phone-form');
      var phone = h('input', { id: 'phoneInput', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+380501234567' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Введите номер аккаунта в международном формате. Код придёт в Telegram на другом вашем устройстве (или SMS).' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) {
          e.preventDefault();
          var v = phone.value, digits = v.replace(/\D/g, '');
          if (digits.length < 7 || digits.length > 15) { toast('Введите номер в международном формате, например +380501234567.'); return; }
          showConnecting(); doSend('/api/tg/login/phone', { phone: v });
        } },
        h('div', { class: 'field grow' }, h('label', { for: 'phoneInput', text: 'Номер телефона' }), phone),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Получить код' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: function () { body.removeAttribute('data-sig'); guard(loadAccount); }, text: 'Назад' })));
      phone.focus();
    });
  }
  function doLogout() {
    confirmModal('Выйти из аккаунта?', 'Сессия будет закрыта в Telegram и удалена с сервера. Мониторинг остановится. Войти можно будет снова.', 'Выйти').then(function (ok) {
      if (!ok) return;
      guard(function () { return post('/api/tg/logout', { confirm: 'LOGOUT' }).then(function (s) { $('loginBody').removeAttribute('data-sig'); renderAccount(s); refreshSide(); }); });
    });
  }

  function runDiagnostics() {
    var btn = $('diagButton'), list = clear($('diagList'));
    btn.disabled = true; btn.textContent = 'Проверяем…';
    guard(function () { return api('/api/tg/diagnostics').then(function (d) {
      d.steps.forEach(function (st) {
        list.appendChild(h('li', { class: st.ok ? 'ok' : 'fail' }, h('span', { class: 'tick', 'aria-hidden': 'true', text: st.ok ? '✓' : '✕' }),
          h('span', { class: 'diag-title', text: st.title || st.name }), st.detail ? h('small', { text: st.detail }) : null, st.ms ? h('em', { text: st.ms + ' мс' }) : null));
      });
      if (d.steps.every(function (s) { return s.ok; })) list.appendChild(h('li', { class: 'ok summary' }, 'Все проверки пройдены: можно входить в аккаунт.'));
    }); }).then(function () { btn.disabled = false; btn.textContent = 'Запустить проверку'; });
  }

  // ---------- monitor ----------
  function loadMonitor() {
    return api('/api/monitor/state').then(function (m) { var active={}; (m.sources||[]).forEach(function(s){active[String(s.id)]=true;}); dialogsCache.forEach(function(d){d.monitored=!!active[String(d.id)];}); renderMonitor(m, true); populateTemplateSelects(m.templates||[]); if(m.planGoal)$('contactAccount').value=m.planGoal.contact_username||''; if(!$('dialogPicker').hidden)renderDialogs(); });
  }
  function renderMonitor(m, fillForm) {
    if (fillForm) {
      $('keywords').value = m.settings.keywords || '';
      $('phrases').value = m.settings.phrases || '';
      $('matchMode').value = m.settings.matchMode || 'keywords';
      $('interval').value = m.settings.intervalSeconds;
      $('templateSelect').value = m.settings.activeTemplateId || '';
    }
    var running = m.settings.running;
    $('runToggle').textContent = running ? 'Остановить мониторинг' : 'Запустить мониторинг';
    $('runToggle').className = 'button ' + (running ? 'button-danger' : 'button-primary');
    $('runToggle').setAttribute('data-running', running ? '1' : '0');
    $('runState').textContent = running ? 'Работает: проверка каждые ' + m.settings.intervalSeconds + ' с. Лидов в базе: ' + num(m.leadsCount) + '.' : 'Остановлен. Лидов в базе: ' + num(m.leadsCount) + '.';
    if (m.pausedUntil) $('runState').textContent += ' Telegram поставил паузу до ' + new Date(m.pausedUntil).toLocaleTimeString('ru-RU') + '.';
    var tb = clear($('sourcesBody'));
    if (!m.sources.length) tb.appendChild(h('tr', {}, h('td', { colspan: '6', class: 'empty-cell', text: 'Пока нет источников. Выберите потенциальные источники из доступных диалогов.' })));
    m.sources.forEach(function (s) {
      var kind = { group: 'Чат', supergroup: 'Группа', channel: 'Канал · комментарии' }[s.kind] || s.kind;
      var remove = h('button', { class: 'button button-quiet small', type: 'button', text: 'Убрать' });
      remove.addEventListener('click', function () { guard(function () { return post('/api/monitor/sources/remove', { id: s.id }).then(loadMonitor); }); });
      tb.appendChild(h('tr', {},
        h('td', {}, h('strong', { text: s.title }), s.last_error ? h('small', { class: 'cell-error', text: s.last_error }) : null),
        h('td', { text: kind }),
        h('td', { text: s.target_title && s.target_title !== s.title ? s.target_title : 'сам чат' }),
        h('td', { text: num(s.messages_seen) }),
        h('td', { text: s.baseline_done ? fmtDate(s.last_checked_at) : 'ожидает первого цикла' }),
        h('td', {}, remove)));
    });
    var log = clear($('logList'));
    if (!m.log || !m.log.length) log.appendChild(h('li', { class: 'muted', text: 'Событий пока нет.' }));
    (m.log || []).forEach(function (e) { var row = h('li', { class: e.level }, h('time', { text: fmtDate(e.at) }), h('span', { text: e.message })); log.appendChild(row); });
    populateTemplateSelects(m.templates || []);
    populatePlan(m);
  }

  /** Saves keywords / interval. Resolves true on success so callers can chain. */
  function saveRules(e) {
    if (e && e.preventDefault) e.preventDefault();
    return post('/api/monitor/settings', { keywords: $('keywords').value, phrases: $('phrases').value, matchMode: $('matchMode').value, activeTemplateId: $('templateSelect').value || null, intervalSeconds: Number($('interval').value) })
      .then(function () { if (e) toast('Условия сохранены.'); return true; })
      .catch(function (err) { if (err.status !== 401) toast(err.message); return false; });
  }
  function toggleRun() {
    var starting = $('runToggle').getAttribute('data-running') !== '1';
    return saveRules().then(function (ok) {
      if (!ok) return null;
      return guard(function () { return post('/api/monitor/settings', { running: starting }).then(function () { toast(starting ? 'Мониторинг запущен.' : 'Мониторинг остановлен.'); }); });
    }).then(function () { return guard(loadMonitor); });
  }
  function checkNow() {
    var btn = $('checkNow'), box = $('checkResult');
    btn.disabled = true; btn.textContent = 'Проверяем…'; box.textContent = '';
    box.className = 'result-box';
    saveRules().then(function (ok) {
      if (!ok) throw Object.assign(new Error('Условия не сохранены — исправьте их и повторите.'), { status: 0 });
      return post('/api/monitor/check', { backfill: Number($('backfill').value) });
    }).then(function (r) {
      box.className = 'result-box show';
      clear(box);
      box.appendChild(h('div', { class: 'result-line' }, h('strong', { text: 'Прочитано сообщений: ' + num(r.checked) }), ' · совпало: ' + num(r.matched) + ' · новых пользователей: ' + num(r.newLeads) + ' · уже были в базе: ' + num(r.knownLeads + r.repeated)));
      (r.perSource || []).forEach(function (p) {
        box.appendChild(h('div', { class: 'result-sub' + (p.error ? ' error' : '') }, p.error ? p.title + ': ' + p.error : p.title + ': прочитано ' + num(p.read) + ', совпало ' + num(p.matched) + ', новых ' + num(p.newLeads)));
      });
      if (r.checked > 0 && r.matched === 0) box.appendChild(h('div', { class: 'result-sub', text: 'Сообщения читаются, но ни одно не содержит ваших слов. Проверьте ключевые слова и фразы в настройках фильтра.' }));
      return guard(loadMonitor);
    }).catch(function (e) { if (e.status !== 401) { box.className = 'result-box show error'; box.textContent = e.message; } })
      .then(function () { btn.disabled = false; btn.textContent = 'Проверить'; });
  }

  function openDialogs() {
    var picker = $('dialogPicker'), list = clear($('dialogList'));
    picker.hidden = false;
    list.appendChild(h('li', { class: 'muted', text: 'Загружаем чаты…' }));
    api('/api/tg/dialogs').then(function (d) { dialogsCache = d; renderDialogs(); })
      .catch(function (e) { dialogsCache = []; clear(list).appendChild(h('li', { class: 'muted', text: e.message })); });
  }
  function renderDialogs() {
    var q=$('dialogFilter').value.trim().toLowerCase(),cat=$('potentialCategory').value,list=clear($('dialogList'));
    var matches=dialogsCache.filter(function(d){return !q||d.title.toLowerCase().includes(q);});
    if(cat==='group')matches=matches.filter(function(d){return d.kind==='group';});else if(cat==='supergroup')matches=matches.filter(function(d){return d.kind==='supergroup';});else if(cat==='channel')matches=matches.filter(function(d){return d.kind==='channel';});
    // Interleave types according to the intended discovery mix 40/40/20. This is only a local-dialog shortlist, not Telegram global search.
    if(cat==='all'){var buckets={group:matches.filter(d=>d.kind==='group'),supergroup:matches.filter(d=>d.kind==='supergroup'),channel:matches.filter(d=>d.kind==='channel')};var order=[];while(buckets.group.length||buckets.supergroup.length||buckets.channel.length){if(buckets.group.length)order.push(buckets.group.shift());if(buckets.supergroup.length)order.push(buckets.supergroup.shift());if(buckets.group.length)order.push(buckets.group.shift());if(buckets.supergroup.length)order.push(buckets.supergroup.shift());if(buckets.channel.length)order.push(buckets.channel.shift());matches=order;}}
    if(!matches.length){list.appendChild(h('li',{class:'muted',text:dialogsCache.length?'Ничего не найдено.':'Чаты не найдены.'}));return;}
    matches.forEach(function(d){var kind={group:'Чат',supergroup:'Группа',channel:'Канал'}[d.kind]||d.kind;var check=h('input',{type:'checkbox',class:'potential-check',value:d.id,disabled:d.monitored,'aria-label':'Выбрать '+d.title});var title=h('span',{class:'picker-title',text:d.title});var meta=h('span',{class:'potential-meta',text:kind+(d.members?' · '+num(d.members)+' уч.':'')});var addBtn=h('button',{class:'button small'+(d.monitored?' button-quiet':''),type:'button',disabled:d.monitored,text:d.monitored?'В мониторинге':'Добавить'});addBtn.addEventListener('click',function(){addDialogSource(d,addBtn);});var choice=h('label',{class:'potential-check-wrap'},check,h('span',{class:'sr-only',text:'Выбрать источник'}));list.appendChild(h('li',{class:'potential-source-row'+(d.monitored?' is-monitored':'')},choice,title,meta,addBtn));});
    updateSelectAllLabel();
  }
  function addDialogSource(d,btn){btn.disabled=true;btn.textContent='…';post('/api/monitor/sources',{id:d.id}).then(function(){d.monitored=true;toast('Добавлен источник: '+d.title);renderDialogs();return loadMonitor();}).catch(function(e){btn.disabled=false;btn.textContent='Добавить';if(e.status!==401)toast(e.message);});}
  function getVisibleSourceCheckboxes(){return Array.prototype.slice.call(document.querySelectorAll('#dialogList .potential-check:not(:disabled)'));}
  function toggleSelectAllSources(){var boxes=getVisibleSourceCheckboxes();if(!boxes.length){toast('Нет доступных для выбора источников.');return;}var allChecked=boxes.every(function(box){return box.checked;});boxes.forEach(function(box){box.checked=!allChecked;});var btn=$('selectAllSources');if(btn)btn.textContent=allChecked?'Выбрать все':'Снять выбор';}
  function updateSelectAllLabel(){var boxes=getVisibleSourceCheckboxes(),btn=$('selectAllSources');if(!btn)return;btn.textContent=boxes.length&&boxes.every(function(box){return box.checked;})?'Снять выбор':'Выбрать все';}
  function addSelectedSources(){var ids=Array.prototype.map.call(document.querySelectorAll('#dialogList .potential-check:checked:not(:disabled)'),function(c){return c.value;});if(!ids.length){toast('Отметьте источники для добавления.');return;}var button=$('addSelectedSources');button.disabled=true;var done=0;ids.reduce(function(p,id){return p.then(function(){return post('/api/monitor/sources',{id:id}).then(function(){done++;});});},Promise.resolve()).then(function(){toast('Добавлено источников: '+done);return loadMonitor();}).catch(function(e){toast('Добавлено '+done+' из '+ids.length+'. Ошибка: '+e.message);}).finally(function(){button.disabled=false;renderDialogs();});}

  // ---------- leads ----------
  function loadLeads() {
    var size = Number($('pageSize').value) || 25;
    var qs = '?limit=' + size + '&page=' + leadsState.page + (leadsState.q ? '&q=' + encodeURIComponent(leadsState.q) : '');
    return api('/api/leads' + qs).then(function (d) {
      leadsState.total = d.total;
      $('leadsTotal').textContent = num(d.total);
      var tb = clear($('leadsBody'));
      d.rows.forEach(function (l) {
        var name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
        tb.appendChild(h('tr', {},
          h('td', {}, name, l.hits_count > 1 ? h('span', { class: 'hits', title: 'Сообщений, подошедших под условия', text: '×' + l.hits_count }) : null),
          h('td', { text: l.username ? '@' + l.username : '—' }),
          h('td', { text: l.phone || 'Nope' }),
          h('td', { text: l.source_title || '—' }),
          h('td', { text: fmtDate(l.trigger_message_date || l.created_at) }),
          h('td', { text: fmtDate(l.created_at) }),
          h('td', { class: 'trigger', title: l.trigger_text || '' }, l.trigger_keyword ? h('span', { class: 'kw', text: l.trigger_keyword === '*' ? 'любое' : l.trigger_keyword }) : null, ' ' + (l.trigger_text || ''))));
      });
      var empty = $('leadsEmpty');
      empty.hidden = d.rows.length > 0;
      empty.textContent = leadsState.q ? 'По запросу ничего не найдено.' : 'База пока пуста. Подключите аккаунт, добавьте чат и запустите проверку на вкладке «Мониторинг».';
      var pages = Math.max(Math.ceil(d.total / size), 1);
      $('pageInfo').textContent = 'Страница ' + d.page + ' из ' + pages;
      $('prevPage').disabled = d.page <= 1;
      $('nextPage').disabled = d.page >= pages;
    });
  }

  function exportExcel() {
    var btn = $('exportButton');
    btn.disabled = true; btn.textContent = 'Готовим файл…';
    var headers = null, rows = [];
    function step(after) {
      return api('/api/export/leads?after=' + after).then(function (d) {
        headers = d.headers;
        for (var i = 0; i < d.rows.length; i++) rows.push(d.rows[i]);
        btn.textContent = 'Готовим файл… ' + num(rows.length) + (d.total ? ' из ' + num(d.total) : '');
        return d.next ? step(d.next) : null;
      });
    }
    step(0).then(function () { return import('./lib/xlsx.js'); }).then(function (mod) {
      if (!rows.length) { toast('В базе пока нет записей для выгрузки.'); return; }
      var bytes = mod.buildXlsx(headers, rows, { sheetName: 'Лиды', widths: [24, 18, 18, 32, 20, 70] });
      var blob = new Blob([bytes], { type: mod.XLSX_MIME });
      var a = document.createElement('a');
      var d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = 'leads_' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('Файл скачан: ' + a.download + ' (' + num(rows.length) + ' строк).');
    }).catch(function (e) { if (e.status !== 401) toast(e.message || 'Не удалось собрать файл.'); })
      .then(function () { btn.disabled = false; btn.textContent = '⇩ Скачать Excel'; });
  }

  function clearLeads() {
    var dialog=$('clearPasswordModal'),input=$('clearPasswordInput');input.value='';
    dialog.addEventListener('close',function once(){dialog.removeEventListener('close',once);if(dialog.returnValue!=='ok')return;var password=input.value;input.value='';if(!password){toast('Введите пароль панели.');return;}guard(function(){return post('/api/leads/clear',{confirmPassword:password}).then(function(result){var d=result&&result.data||{};toast('D1 очищена: удалено лидов '+num(d.deletedLeads||0)+', совпадений '+num(d.deletedHits||0)+'.');leadsState.page=1;return loadLeads();});});});
    if(dialog.showModal)dialog.showModal();else {var p=window.prompt('Введите пароль панели для очистки базы');if(p)guard(function(){return post('/api/leads/clear',{confirmPassword:p}).then(function(){toast('База очищена.');leadsState.page=1;return loadLeads();});});}
  }

  // ---------- init ----------
  function saveCreds(e) {
    e.preventDefault();
    var btn = $('credsButton'); btn.disabled = true;
    post('/api/tg/credentials', { api_id: $('apiId').value, api_hash: $('apiHash').value })
      .then(function (s) { $('apiHash').value = ''; $('apiId').value = ''; $('loginBody').removeAttribute('data-sig'); toast('Ключи сохранены.'); renderAccount(s); })
      .catch(function (err) { if (err.status !== 401) toast(err.message); })
      .then(function () { btn.disabled = false; });
  }

  function init() {
    $('gateForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('gateButton'); btn.disabled = true; $('gateError').textContent = '';
      tryEnter($('gateKey').value.trim()).catch(function (err) {
        if (err.status === 503) { setKey(''); $('gateError').textContent = 'Сервер не настроен: ' + err.message; }
      }).then(function () { btn.disabled = false; });
    });
    $('lockButton').addEventListener('click', function () { lock(''); });
    $('refreshButton').addEventListener('click', refresh);
    $('credsForm').addEventListener('submit', saveCreds);
    $('diagButton').addEventListener('click', runDiagnostics);
    $('rulesForm').addEventListener('submit', saveRules);
    $('runToggle').addEventListener('click', toggleRun);
    $('checkNow').addEventListener('click', checkNow);
    $('loadDialogs').addEventListener('click', openDialogs);
    $('dialogFilter').addEventListener('input', renderDialogs);
    $('exportButton').addEventListener('click', exportExcel);
    $('clearButton').addEventListener('click', clearLeads);
    $('saveContactButton').addEventListener('click', function () {
      var v = $('contactAccount').value.trim();
      if (v && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) { toast('Нужен Telegram username в формате @username.'); return; }
      guard(function () { return post('/api/plan/contact', { username: v }).then(function () { toast('Контакт уведомлений сохранён.'); }); });
    });
    $('savePlanButton').addEventListener('click', function () {
      guard(function () { return post('/api/plan', { targetLeads: Number($('planTarget').value || 0), templateId: $('planTemplate').value || null, sourceId: $('planSource').value || null }).then(function (g) { $('planStatus').textContent = g.enabled ? 'Цель: ' + num(g.target_leads) + ' лидов' : 'Цель не задана'; toast('Цель сохранена.'); }); });
    });
    $('saveTemplateButton').addEventListener('click', function () {
      var name = $('templateName').value.trim();
      if (!name) { toast('Введите имя шаблона.'); return; }
      saveRules().then(function (ok) {
        if (!ok) return;
        guard(function () { return post('/api/monitor/templates', {
          name: name, keywords: $('keywords').value, phrases: $('phrases').value,
          matchMode: $('matchMode').value, matchAny: $('matchAny').checked,
          intervalSeconds: Number($('interval').value)
        }).then(function (list) { populateTemplateSelects(list); $('templateName').value = ''; toast('Шаблон сохранён.'); }); });
      });
    });
    $('templateSelect').addEventListener('change', function () {
      if (!this.value) return;
      var id = this.value;
      guard(function () { return post('/api/monitor/templates/apply', { id: id }).then(function () { toast('Шаблон применён.'); return loadMonitor(); }); });
    });
    $('deleteTemplateButton').addEventListener('click', function () {
      var id = $('templateSelect').value;
      if (!id) { toast('Выберите шаблон.'); return; }
      guard(function () { return post('/api/monitor/templates/delete', { id: id }).then(function (list) { populateTemplateSelects(list); toast('Шаблон удалён.'); }); });
    });
    $('addSelectedSources').addEventListener('click', addSelectedSources);
    $('potentialCategory').addEventListener('change', renderDialogs);
    $('pageSize').addEventListener('change', function () { leadsState.page = 1; guard(loadLeads); });
    $('prevPage').addEventListener('click', function () { leadsState.page = Math.max(1, leadsState.page - 1); guard(loadLeads); });
    $('nextPage').addEventListener('click', function () { leadsState.page += 1; guard(loadLeads); });
    $('leadSearch').addEventListener('input', function () {
      clearTimeout(timers.search);
      timers.search = setTimeout(function () { leadsState.q = $('leadSearch').value.trim(); leadsState.page = 1; guard(loadLeads); }, 300);
    });
    window.addEventListener('hashchange', function () { if (!$('shell').hidden) route(); });

    if (isLocalPreview) {
      $('gate').hidden = true; $('shell').hidden = false; $('previewBanner').hidden = false;
      $('sideStatus').textContent = 'Локальный предпросмотр';
      route();
      return;
    }
    if (!getKey()) { lock(''); return; }
    api('/api/auth/check').then(unlock).catch(function (err) {
      if (err.status === 503) { setKey(''); $('gate').hidden = false; $('gateError').textContent = 'Сервер не настроен: ' + err.message; }
    });
  }

  init();
})();
