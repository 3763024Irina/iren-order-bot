// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import crypto from 'crypto';

const {
  BOT_TOKEN,              // обязательный
  ADMIN_CHAT_ID,          // chat_id админа (число). Если не задан, дублируем в ответ пользователю
  PORT = 3000,
  USE_WEBHOOK = '0',      // '1' => webhook, иначе polling
  WEBHOOK_URL = '',       // https://your-domain.tld (без хвоста, НО с https)
  WEBHOOK_SECRET = ''     // опционально: секрет для X-Telegram-Bot-Api-Secret-Token
} = process.env;

if (!BOT_TOKEN) throw new Error('Set BOT_TOKEN in .env');

const bot = new Telegraf(BOT_TOKEN);

// ===== Меню бота =====
bot.telegram.setMyCommands([
  { command: 'start', description: 'Запустить бота' },
  { command: 'id',    description: 'Показать мой chat_id' }
]).catch(console.error);

// ===== username бота (ленивая загрузка, чтобы не было гонок) =====
let BOT_USER = '';
async function ensureBotUsername() {
  if (BOT_USER) return BOT_USER;
  const me = await bot.telegram.getMe();
  BOT_USER = me?.username || '';
  return BOT_USER;
}

// ===== In-memory store токенов =====
const store = new Map(); // token -> { payload, exp }
const TTL_MS = 1000 * 60 * 30; // 30 минут

function putPayload(obj) {
  const token = crypto.randomBytes(6).toString('base64url'); // короткий
  store.set(token, { payload: obj, exp: Date.now() + TTL_MS });
  return token;
}
function takePayload(token) {
  const rec = store.get(token);
  if (!rec) return null;
  store.delete(token);
  if (rec.exp < Date.now()) return null;
  return rec.payload;
}

function esc(s = '') {
  // экранирование для MarkdownV2
  return String(s).replace(/[_*\[\]()`~>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtOrder(p) {
  const pr = p.program || {};
  return [
    '*Новая заявка*',
    (pr.title || pr.id) ? `*Программа:* ${esc(pr.title || '')}${pr.id ? ` (${esc(pr.id)})` : ''}` : '',
    pr.url ? `*Страница:* ${esc(pr.url)}` : '',
    `*Имя:* ${esc(p.name || '')}`,
    `*Контакт клиента:* ${esc(p.contact || '')}`,
    `*Дата:* ${esc(p.date || '')}`,
    `*Гостей:* ${esc(p.guests || '')}`,
    p.message ? `*Сообщение:* ${esc(p.message)}` : ''
  ].filter(Boolean).join('\n');
}

// ===== Хэндлеры бота =====
bot.start(async (ctx) => {
  const token = (ctx.startPayload || '').trim();
  console.log('[START]', { from: ctx.from?.id, tokenPresent: Boolean(token) });

  if (!token) {
    return ctx.reply(
      'Здравствуйте! Нажмите «Заказать» на сайте — заявка придёт сюда автоматически.\n' +
      'Или напишите имя/даты здесь, и я отвечу.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Открыть сайт', url: 'https://3763024irina.github.io/voyages-de-l-auteur/' }
          ]]
        }
      }
    );
  }

  const payload = takePayload(token);
  if (!payload) {
    return ctx.reply('⚠️ Срок действия ссылки истёк. Отправьте заявку ещё раз с сайта.');
  }

  const text = fmtOrder(payload);
  const adminId = Number(ADMIN_CHAT_ID || ctx.chat?.id);

  try {
    await ctx.telegram.sendMessage(adminId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('[SEND->ADMIN] failed:', e);
  }

  await ctx.reply('Спасибо! Ваша заявка отправлена. Я свяжусь с вами в ближайшее время ✅');
});

bot.command('id', (ctx) => ctx.reply(`chat_id: ${ctx.chat.id}`));
bot.catch((err) => console.error('Bot error:', err));

// ===== HTTP-сервер =====
const app = express();

// Если за прокси (Render/Heroku/Nginx) — нужно для корректной схемы HTTPS и доверия к заголовкам
app.set('trust proxy', 1);

// CORS: GitHub Pages + локалка
const CORS_WHITELIST = [
  'https://3763024irina.github.io',
  'https://3763024irina.github.io/voyages-de-l-auteur',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',    // vite
  'http://127.0.0.1:5173'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / сервер-сервер
    if (CORS_WHITELIST.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

// Обязателен обработчик preflight
app.options('*', (req, res) => res.sendStatus(204));

// JSON парсер (с запасом размера)
app.use(express.json({ limit: '200kb' }));

app.get('/health', (_, res) => res.json({ ok: true }));

// Простой пинг для проверки CORS/методов
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/prestart', async (req, res) => {
  try {
    const b = req.body || {};
    // Разрешим как объект, так и «плоские» поля для program
    const program = b.program && typeof b.program === 'object'
      ? b.program
      : {
          id: b.program_id || b.programId || '',
          title: b.program_title || b.programTitle || '',
          url: b.program_url || b.programUrl || ''
        };

    const payload = {
      name: String(b.name || '').trim(),
      contact: String(b.contact || '').trim(),
      date: String(b.date || '').trim(),
      guests: String(b.guests || '').trim(),
      message: String(b.message || '').trim(),
      program: {
        id: String(program.id || '').trim(),
        title: String(program.title || '').trim(),
        url: String(program.url || '').trim()
      }
    };

    // Строгая валидация (как у тебя), но с нормальными ошибками
    const required = ['name', 'contact', 'date', 'guests', 'message'];
    for (const k of required) {
      if (!payload[k]) {
        return res.status(400).json({ ok: false, error: `Missing ${k}` });
      }
    }
    // program можно не делать строго обязательным, но если есть — красиво отображаем
    // если хочешь строго: раскомментируй следующую строку
    // if (!(payload.program.title || payload.program.id || payload.program.url)) return res.status(400).json({ ok: false, error: 'Missing program' });

    const token = putPayload(payload);

    // Получим username лениво, чтобы не было гонок
    let username = BOT_USER;
    if (!username) {
      try { username = await ensureBotUsername(); } catch (e) { console.error('[getMe lazy] failed:', e); }
    }

    const url = username ? `https://t.me/${username}?start=${token}` : null;
    console.log('[PRESTART]', { token, hasUrl: Boolean(url) });

    return res.json({ ok: true, token, url });
  } catch (e) {
    console.error('[PRESTART] error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// Очистка просроченных токенов
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) if (v.exp < now) store.delete(k);
}, 60_000);

// ===== Запуск: webhook ИЛИ polling =====
async function start() {
  const server = app.listen(Number(PORT), () => console.log(`HTTP on :${PORT}`));

  if (USE_WEBHOOK === '1') {
    if (!WEBHOOK_URL) {
      console.error('WEBHOOK_URL required when USE_WEBHOOK=1');
      process.exit(1);
    }
    const secretPath = `/telegraf/${crypto.randomBytes(8).toString('hex')}`;

    // Включим секретный заголовок (рекомендуется Телеграмом)
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`, {
      secret_token: WEBHOOK_SECRET || undefined
    });

    app.use((req, res, next) => {
      // Валидируем секрет (если задан)
      if (WEBHOOK_SECRET && req.path.startsWith(secretPath)) {
        const token = req.get('X-Telegram-Bot-Api-Secret-Token');
        if (token !== WEBHOOK_SECRET) return res.sendStatus(401);
      }
      next();
    });

    app.use(bot.webhookCallback(secretPath));
    console.log('Webhook set:', `${WEBHOOK_URL}${secretPath}`);
  } else {
    await bot.launch();
    console.log('Bot started (polling)');
  }

  const shutdown = (sig) => () => {
    console.log(`${sig} received`);
    bot.stop(sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));
}

start().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
