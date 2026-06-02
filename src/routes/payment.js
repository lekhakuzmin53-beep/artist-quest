// src/routes/payment.js
const express = require('express');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const SHOP_ID    = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const APP_URL    = process.env.APP_URL || 'http://localhost:3000';
const PRICE_PER_1K = parseFloat(process.env.PRICE_PER_1K_TOKENS || '2');
const MIN_TOPUP    = parseFloat(process.env.MIN_TOPUP || '100');

function rubToTokens(rub) {
  // сколько токенов даём за рубли
  return Math.floor((rub / PRICE_PER_1K) * 1000);
}

// POST /api/payment/create  — создать платёж
router.post('/create', auth, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < MIN_TOPUP)
      return res.status(400).json({ error: `Минимальная сумма ${MIN_TOPUP}₽` });

    const tokensGranted = rubToTokens(amount);
    const idempotencyKey = uuidv4();

    const ykRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: {
          type: 'redirect',
          return_url: `${APP_URL}/?payment=success`,
        },
        capture: true,
        description: `Dungeon AI — ${tokensGranted.toLocaleString('ru')} токенов`,
        metadata: { user_id: req.user.id, tokens: tokensGranted },
      },
      {
        auth: { username: SHOP_ID, password: SECRET_KEY },
        headers: { 'Idempotence-Key': idempotencyKey },
      }
    );

    const yk = ykRes.data;

    // Сохраняем платёж в БД
    await pool.query(
      'INSERT INTO payments (user_id, yookassa_id, amount_rub, tokens_granted, status) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, yk.id, amount, tokensGranted, 'pending']
    );

    res.json({ confirmation_url: yk.confirmation.confirmation_url, payment_id: yk.id, tokens: tokensGranted });
  } catch (e) {
    console.error('Payment create error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// POST /api/payment/webhook  — ЮКасса шлёт сюда уведомления
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;
    if (event.type !== 'payment.succeeded') return res.json({ ok: true });

    const ykId = event.object?.id;
    const meta = event.object?.metadata || {};
    const userId = meta.user_id;
    const tokens = parseInt(meta.tokens, 10);

    if (!ykId || !userId || !tokens) return res.json({ ok: true });

    // Идемпотентность — не начислять дважды
    const { rows } = await pool.query(
      'SELECT status FROM payments WHERE yookassa_id = $1', [ykId]
    );
    if (!rows.length || rows[0].status === 'succeeded') return res.json({ ok: true });

    // Начислить токены
    await pool.query('BEGIN');
    await pool.query(
      'UPDATE payments SET status=$1, paid_at=NOW() WHERE yookassa_id=$2',
      ['succeeded', ykId]
    );
    await pool.query(
      'UPDATE users SET tokens_balance = tokens_balance + $1, updated_at=NOW() WHERE id = $2',
      [tokens, userId]
    );
    await pool.query('COMMIT');

    console.log(`✅ Начислено ${tokens} токенов пользователю ${userId}`);
    res.json({ ok: true });
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: 'webhook_error' });
  }
});

// GET /api/payment/history
router.get('/history', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT amount_rub, tokens_granted, status, created_at, paid_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json({ payments: rows });
});

// GET /api/payment/prices
router.get('/prices', (req, res) => {
  res.json({
    price_per_1k: PRICE_PER_1K,
    min_topup: MIN_TOPUP,
    packages: [
      { rub: 100,  tokens: rubToTokens(100) },
      { rub: 300,  tokens: rubToTokens(300) },
      { rub: 500,  tokens: rubToTokens(500) },
      { rub: 1000, tokens: rubToTokens(1000) },
    ]
  });
});

module.exports = router;
