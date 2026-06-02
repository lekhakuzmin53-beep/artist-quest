// src/index.js — точка входа
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app = express();

// ─── Безопасность ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_URL || '*' }));
app.use(express.json({ limit: '512kb' }));

// Rate limit — общий
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }));

// Rate limit — для AI (жёстче)
const aiLimit = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Слишком много запросов' } });

// ─── Маршруты API ────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/ai',      aiLimit, require('./routes/ai'));
app.use('/api/saves',   require('./routes/saves'));

// Healthcheck для Railway
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Статика (SPA) ───────────────────────────────────────────
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));

// Все остальные GET → index.html (SPA)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

// ─── Запуск ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`\n🌍 Dungeon AI SaaS`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API key: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ не задан'}`);
  console.log(`   DB:      ${process.env.DATABASE_URL ? '✅' : '❌ не задан'}`);
  console.log(`   ЮКасса:  ${process.env.YOOKASSA_SHOP_ID ? '✅' : '⚠️  не задан (оплата отключена)'}\n`);
});
