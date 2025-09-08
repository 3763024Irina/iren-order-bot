// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import crypto from 'crypto';

const {
  BOT_TOKEN,             // токен бота (не публиковать)
  ADMIN_CHAT_ID,         // числовой chat_id админа (/id в боте)
  PORT = 3000,
  USE_WEBHOOK = '0',     // '1' чтобы включить webhook
  WEBHOOK_URL = ''       // базовый HTTPS URL сервера (без хвоста)
} = process.env;

if (!BOT_TOKEN) throw new Error('Set BOT_TOKEN env');

const bot = new Telegraf(BOT_TOKEN);

// ===== Команды бота (меню) =====
bot.telegram.setMyCommands([
  { command: 'start', description: 'Запустить бота' },
  { command: 'id',    description: 'Показать мой chat_id' }
]).catch(console.error);

// ===== Узнаём username бота для deep-link =====
let BOT_USER = '';
bot.telegram.getMe()
  .then(me => { BOT_USER = me.username; console.log('[getMe]', me.username); })
  .catch(err => console.error('[getMe] failed:', err));

// ===== In-memory store токенов =====
const store = new Map(); // token -> { payload, exp }
const TTL_MS = 1000 * 60 * 30; // 30 минут

function putPayload(obj) {
  const token = crypto.randomBytes(6).toString('base64url'); // короткий токен
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
  // экранирование под MarkdownV2
  return String(s).replace(/[_*\[\]()`~>#+\-=|{}.!\\]/g, '\\$&');
}
function fmtOrder(p) {
  return [
    '*Новая заявка*',
    `*Программа:* ${esc(p.program?.title || '')}${p.program?.id ? ` (${esc(p.program.id)})` : ''}`,
    `*Страница:* ${esc(p.program?.url || '')}`,
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
  console.log('[START]', { from: ctx.from?.id, token });

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

  const p = takePayload(token);
  console.log('[PAYLOAD]', p);
  if (!p) return ctx.reply('⚠️ Срок действия ссылки истёк. Отправьте заявку ещё раз с сайта.');

  const text = fmtOrder(p);
  const adminId = Number(ADMIN_CHAT_ID || ctx.chat?.id);
  console.log('[SEND->ADMIN]', adminId);

  try {
    await ctx.telegram.sendMessage(adminId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('Send to admin failed:', e);
  }

  await ctx.reply('Спасибо! Ваша заявка отправлена. Я свяжусь с вами в ближайшее время ✅');
});

bot.command('id', (ctx) => ctx.reply(`chat_id: ${ctx.chat.id}`));
bot.catch((err) => console.error('Bot error:', err));

// ===== HTTP-сервер =====
const app = express();

// Строгий CORS под GitHub Pages
app.use(cors({
  origin: [
    'https://3763024irina.github.io',
    'https://3763024irina.github.io/voyages-de-l-auteur'
  ],
  methods: ['GET', 'POST']
}));
app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/prestart', (req, res) => {
  const b = req.body || {};
  const required = ['name', 'contact', 'date', 'guests', 'message', 'program'];
  for (const k of required) {
    if (!b[k]) return res.status(400).json({ ok: false, error: `Missing ${k}` });
  }
  const token = putPayload(b);
  const url = BOT_USER ? `https://t.me/${BOT_USER}?start=${token}` : null;
  console.log('[PRESTART]', { token, hasUrl: Boolean(url) });
  res.json({ ok: true, token, url });
});

// Очистка просроченных токенов
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) if (v.exp < now) store.delete(k);
}, 60_000);

// ===== Запуск: webhook ИЛИ polling =====
async function start() {
  const server = app.listen(PORT, () => console.log(`HTTP on :${PORT}`));

  if (USE_WEBHOOK === '1') {
    if (!WEBHOOK_URL) {
      console.error('WEBHOOK_URL required when USE_WEBHOOK=1');
      process.exit(1);
    }
    const secretPath = `/telegraf/${crypto.randomBytes(8).toString('hex')}`;
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
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
