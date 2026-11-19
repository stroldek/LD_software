import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { json, error, readJson } from './http.js';

const STATE_KEY = 'telegram_auth_state';
const encoder = new TextEncoder();

function credentials(env) {
  const apiId = Number(env.API_ID);
  const apiHash = String(env.API_HASH || '');
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error('Не настроены секреты API_ID и API_HASH в Cloudflare Worker.');
  }
  if (!env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN не настроен.');
  return { apiId, apiHash };
}

async function encryptionKey(env) {
  const { apiHash } = credentials(env);
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(env.ADMIN_TOKEN) + ':' + apiHash),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('ZAMOVO/telegram-session/v1'),
      info: encoder.encode('D1 encrypted MTProto session'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptState(state, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(state))
  );
  return JSON.stringify({ version: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) });
}

async function decryptState(value, env) {
  const stored = JSON.parse(value);
  if (stored?.version !== 1 || !stored.iv || !stored.data) throw new Error('Неизвестный формат Telegram-сессии.');
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(stored.iv) },
    key,
    fromBase64(stored.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function loadState(db, env) {
  const row = await db.prepare('SELECT value_json FROM app_settings WHERE key=?').bind(STATE_KEY).first();
  if (!row) return null;
  return decryptState(row.value_json, env);
}

async function saveState(db, env, state) {
  const encrypted = await encryptState(state, env);
  await db.prepare(
    "INSERT INTO app_settings(key, value_json, updated_at) VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at"
  ).bind(STATE_KEY, encrypted).run();
}

async function clearState(db) {
  await db.prepare('DELETE FROM app_settings WHERE key=?').bind(STATE_KEY).run();
}

function makeClient(env, session = '') {
  const { apiId, apiHash } = credentials(env);
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 1,
    reconnectRetries: 0,
    autoReconnect: false,
    timeout: 15000,
    requestRetries: 1,
  });
}

async function closeClient(client) {
  if (!client) return;
  try { await client.disconnect(); } catch { /* connection may not have opened */ }
}

function publicUser(user) {
  return {
    userId: user?.id == null ? null : String(user.id),
    username: user?.username || null,
    firstName: user?.firstName || user?.first_name || null,
    lastName: user?.lastName || user?.last_name || null,
  };
}

function telegramError(err) {
  const code = String(err?.errorMessage || err?.message || '');
  if (code.includes('PHONE_CODE_INVALID')) return 'Неверный код Telegram. Проверь код и попробуй ещё раз.';
  if (code.includes('PHONE_CODE_EXPIRED')) return 'Срок действия кода истёк. Запроси новый код.';
  if (code.includes('PHONE_NUMBER_INVALID')) return 'Telegram отклонил номер. Укажи номер в международном формате, например +380...';
  if (code.includes('PHONE_NUMBER_BANNED')) return 'Telegram не разрешил авторизацию для этого номера.';
  if (code.includes('PASSWORD_HASH_INVALID')) return 'Неверный пароль двухэтапной проверки Telegram.';
  if (code.includes('SESSION_PASSWORD_NEEDED')) return 'Для аккаунта требуется пароль двухэтапной проверки.';
  if (code.includes('API_ID_INVALID')) return 'Telegram отклонил API_ID. Проверь секреты API_ID и API_HASH в Cloudflare.';
  if (code.includes('API_ID_PUBLISHED_FLOOD')) return 'Telegram заблокировал этот API ID из-за публикации. Проверь настройки приложения на my.telegram.org.';
  if (code.includes('FLOOD_WAIT')) return 'Telegram временно ограничил попытки входа. Подожди указанное Telegram время и повтори попытку.';
  if (code.includes('AUTH_KEY_UNREGISTERED') || code.includes('SESSION_REVOKED')) return 'Telegram-сессия больше не действительна. Отключи аккаунт и пройди авторизацию заново.';
  if (code.includes('AUTH_USER_CANCEL')) return 'Авторизация не завершена.';
  return 'Ошибка Telegram: ' + (code || 'не удалось выполнить запрос').slice(0, 180);
}

function requirePending(state, expected) {
  if (!state || state.status !== expected) throw new Error(expected === 'awaiting_code'
    ? 'Сначала запроси код авторизации.'
    : 'Сначала подтверди код Telegram.');
  if (state.expiresAt && Date.now() > state.expiresAt) throw new Error('Срок ожидания авторизации истёк. Запроси новый код.');
}

export async function handleTelegramApi(request, env, path) {
  if (!path.startsWith('/api/telegram/')) return null;
  if (!env.DB) return error('D1 binding DB is not configured', 503);

  if (path === '/api/telegram/status' && request.method === 'GET') {
    try {
      credentials(env);
      const state = await loadState(env.DB, env);
      if (!state) return json({ configured: true, status: 'disconnected' });
      if (state.status !== 'connected' && state.expiresAt && Date.now() > state.expiresAt) {
        return json({ configured: true, status: 'expired' });
      }
      return json({
        configured: true,
        status: state.status,
        phoneNumber: state.phoneNumber || null,
        codeViaApp: state.codeViaApp ?? null,
        emailCodeSent: Boolean(state.emailCodeSent),
        user: state.user || null,
        connectedAt: state.connectedAt || null,
      });
    } catch (err) {
      return error(err.message || 'Telegram не настроен', 503);
    }
  }

  if (path === '/api/telegram/send-code' && request.method === 'POST') {
    let client;
    try {
      credentials(env);
      const body = await readJson(request);
      const phoneNumber = String(body?.phone_number || '').trim();
      if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) {
        return error('Укажи номер в международном формате: +380XXXXXXXXX');
      }
      const oldState = await loadState(env.DB, env);
      if (oldState?.status === 'connected') return error('Сначала отключи текущий Telegram-аккаунт.', 409);
      client = makeClient(env, oldState?.session || '');
      await client.connect();
      const sent = await client.sendCode(credentials(env), phoneNumber);
      const state = {
        session: client.session.save(),
        status: sent.emailRequired || sent.emailCodeSent ? 'email_required' : 'awaiting_code',
        phoneNumber,
        phoneCodeHash: sent.phoneCodeHash,
        codeViaApp: Boolean(sent.isCodeViaApp),
        emailCodeSent: Boolean(sent.emailCodeSent),
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      await saveState(env.DB, env, state);
      if (state.status === 'email_required') {
        return json({
          status: state.status,
          message: 'Telegram запросил дополнительное подтверждение через email. Этот вариант авторизации пока не включён в интерфейс ZAMOVO.',
          emailCodeSent: state.emailCodeSent,
        });
      }
      return json({
        status: state.status,
        codeViaApp: state.codeViaApp,
        message: state.codeViaApp
          ? 'Код отправлен в приложение Telegram на одном из твоих устройств.'
          : 'Telegram отправил код выбранным им способом.',
      });
    } catch (err) {
      console.error('Telegram send-code failed:', err?.errorMessage || err?.message || 'unknown');
      return error(telegramError(err), 400);
    } finally {
      await closeClient(client);
    }
  }

  if (path === '/api/telegram/sign-in' && request.method === 'POST') {
    let client;
    try {
      const state = await loadState(env.DB, env);
      requirePending(state, 'awaiting_code');
      const body = await readJson(request);
      const phoneCode = String(body?.code || '').trim();
      if (!/^[0-9]{3,12}$/.test(phoneCode)) return error('Введи код из Telegram.');
      client = makeClient(env, state.session);
      await client.connect();
      let authorization;
      try {
        authorization = await client.invoke(new Api.auth.SignIn({
          phoneNumber: state.phoneNumber,
          phoneCodeHash: state.phoneCodeHash,
          phoneCode,
        }));
      } catch (err) {
        if (String(err?.errorMessage || '').includes('SESSION_PASSWORD_NEEDED')) {
          state.session = client.session.save();
          state.status = 'awaiting_password';
          state.phoneCodeHash = null;
          state.expiresAt = Date.now() + 10 * 60 * 1000;
          await saveState(env.DB, env, state);
          return json({ status: 'awaiting_password', message: 'Код принят. Теперь введи пароль двухэтапной проверки Telegram.' });
        }
        throw err;
      }
      if (authorization instanceof Api.auth.AuthorizationSignUpRequired) {
        return error('Этот номер не завершил обычный вход в существующий аккаунт. Создание нового аккаунта из ZAMOVO отключено.', 409);
      }
      if (!(authorization instanceof Api.auth.Authorization)) {
        throw new Error('Telegram вернул неожиданный результат авторизации.');
      }
      state.session = client.session.save();
      state.status = 'connected';
      state.phoneCodeHash = null;
      state.expiresAt = null;
      state.user = publicUser(authorization.user);
      state.connectedAt = new Date().toISOString();
      await saveState(env.DB, env, state);
      return json({ status: 'connected', user: state.user, connectedAt: state.connectedAt });
    } catch (err) {
      console.error('Telegram sign-in failed:', err?.errorMessage || err?.message || 'unknown');
      return error(telegramError(err), 400);
    } finally {
      await closeClient(client);
    }
  }

  if (path === '/api/telegram/password' && request.method === 'POST') {
    let client;
    try {
      const state = await loadState(env.DB, env);
      requirePending(state, 'awaiting_password');
      const body = await readJson(request);
      const password = String(body?.password || '');
      if (!password || password.length > 512) return error('Введи пароль двухэтапной проверки Telegram.');
      client = makeClient(env, state.session);
      await client.connect();
      let lastTelegramError = null;
      let user;
      try {
        user = await client.signInWithPassword(credentials(env), {
          password: async () => password,
          onError: async (err) => {
            lastTelegramError = err;
            return true;
          },
        });
      } catch (err) {
        throw lastTelegramError || err;
      }
      state.session = client.session.save();
      state.status = 'connected';
      state.expiresAt = null;
      state.user = publicUser(user);
      state.connectedAt = new Date().toISOString();
      await saveState(env.DB, env, state);
      return json({ status: 'connected', user: state.user, connectedAt: state.connectedAt });
    } catch (err) {
      console.error('Telegram 2FA failed:', err?.errorMessage || err?.message || 'unknown');
      return error(telegramError(err), 400);
    } finally {
      await closeClient(client);
    }
  }

  if (path === '/api/telegram/disconnect' && request.method === 'POST') {
    let client;
    try {
      const state = await loadState(env.DB, env);
      if (state?.session) {
        client = makeClient(env, state.session);
        await client.connect();
        try { await client.invoke(new Api.auth.LogOut()); } catch (err) {
          console.warn('Telegram logout could not be confirmed:', err?.errorMessage || err?.message || 'unknown');
        }
      }
      await clearState(env.DB);
      return json({ status: 'disconnected' });
    } catch (err) {
      return error(telegramError(err), 400);
    } finally {
      await closeClient(client);
    }
  }

  return error('Not found', 404);
}
