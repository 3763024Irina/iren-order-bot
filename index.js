import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import crypto from 'crypto';

const {
  BOT_TOKEN,            // токен бота от @BotFather
  ADMIN_CHAT_ID,        // ваш chat_id (число, куда бот шлёт заявки)
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) throw new Error('Set BOT_TOKEN env');

const bot = new Telegraf(BOT_TOKEN);

// ===== простое «хранилище» токенов (живет в памяти сервера) =====
const store = new Map(); // token -> {payload, exp}
const TTL_MS = 1000 * 60 * 30; // 30 минут

function putPayload(obj){
  const token = crypto.randomBytes(6).toString('base64url'); // короткий токен
  store.set(token, { payload: obj, exp: Date.now() + TTL_MS });
  return token;
}
function takePayload(token){
  const rec = store.get(token);
  if (!rec) return null;
  store.delete(token);
  if (rec.exp < Date.now()) return null;
  return rec.payload;
}
function esc(s=''){
  return String(s).replace(/[_*\\[\\]()`~>#+\\-=|{}.!]/g, '\\\\$&'); // MarkdownV2
}
function fmtOrder(p){
  return [
    '*Новая заявка*',
    `*Программа:* ${esc(p.program?.title||'')}${p.program?.id ? ` (${esc(p.program.id)})` : ''}`,
    `*Страница:* ${esc(p.program?.url||'')}`,
    `*Имя:* ${esc(p.name||'')}`,
    `*Контакт клиента:* ${esc(p.contact||'')}`,
    `*Дата:* ${esc(p.date||'')}`,
    `*Гостей:* ${esc(p.guests||'')}`,
    p.message ? `*Сообщение:* ${esc(p.message)}` : ''
  ].filter(Boolean).join('\n');
}

// старт бота
bot.start(async (ctx) => {
  const token = (ctx.startPayload || '').trim();
  if (!token){
    return ctx.reply('Здравствуйте! Нажмите кнопку «Заказать» на сайте — заявка придёт сюда автоматически.');
  }
  const p = takePayload(token);
  if (!p) return ctx.reply('⚠️ Срок действия ссылки истёк. Отправьте заявку ещё раз с сайта.');

  const text = fmtOrder(p);
  const adminId = Number(ADMIN_CHAT_ID || ctx.chat?.id);
  try{
    await ctx.telegram.sendMessage(adminId, text, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  }catch(e){
    console.error('Send to admin failed:', e);
  }
  await ctx.reply('Спасибо! Ваша заявка отправлена. Я свяжусь с вами в ближайшее время ✅');
});

bot.command('id', (ctx)=> ctx.reply(`chat_id: ${ctx.chat.id}`));

bot.catch((err)=> console.error('Bot error:', err));
bot.launch().then(()=> console.log('Bot started'));

// ===== HTTP-сервер для /prestart =====
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_,res)=> res.json({ok:true}));

app.post('/prestart', (req, res)=>{
  const b = req.body || {};
  const required = ['name','contact','date','guests','message','program'];
  for (const k of required) if (!b[k]) return res.status(400).json({ok:false, error:`Missing ${k}`});
  const token = putPayload(b);
  res.json({ ok:true, token });
});

setInterval(()=>{
  const now = Date.now();
  for (const [k, v] of store.entries()) if (v.exp < now) store.delete(k);
}, 60_000);

app.listen(PORT, ()=> console.log(`HTTP on :${PORT}`));
