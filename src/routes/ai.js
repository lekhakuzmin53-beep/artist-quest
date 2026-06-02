// src/routes/ai.js — прокси к Claude с подсчётом токенов
const express = require('express');
const axios   = require('axios');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const SERVER_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// Стоимость токенов Claude Sonnet ($/1M токенов)
const COST_IN  = 3.0;   // $3 per 1M input tokens
const COST_OUT = 15.0;  // $15 per 1M output tokens

// Базовая валидация формата ключа Anthropic
function isValidAnthropicKey(key) {
  return typeof key === 'string' && /^sk-ant-[a-zA-Z0-9\-_]{20,}$/.test(key.trim());
}

// POST /api/ai/chat
router.post('/chat', auth, async (req, res) => {
  try {
    const user = req.user;

    // Определяем какой ключ использовать
    const useOwnKey = !!user.own_api_key;
    const apiKey = useOwnKey ? user.own_api_key : SERVER_ANTHROPIC_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'no_api_key', message: 'API ключ не настроен' });
    }

    // Проверка баланса — только если используется серверный ключ
    if (!useOwnKey && user.tokens_balance < 500) {
      return res.status(402).json({
        error: 'insufficient_tokens',
        message: 'Недостаточно токенов. Пополните баланс или добавьте свой API ключ.',
        balance: user.tokens_balance
      });
    }

    const { messages, system, max_tokens = 800 } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Неверный формат запроса' });
    }

    // Лимит max_tokens
    const safeMaxTokens = useOwnKey
      ? Math.min(max_tokens, 2000) // со своим ключом — просто ограничиваем разумно
      : Math.min(max_tokens, Math.min(2000, user.tokens_balance));

    const ykRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: MODEL, max_tokens: safeMaxTokens, system, messages },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const data = ykRes.data;
    const tokensIn  = data.usage?.input_tokens  || 0;
    const tokensOut = data.usage?.output_tokens || 0;
    const total     = tokensIn + tokensOut;

    if (useOwnKey) {
      // Только логируем использование, токены не списываем
      await pool.query(
        'UPDATE users SET tokens_used = tokens_used + $1, updated_at = NOW() WHERE id = $2',
        [total, user.id]
      );
      await pool.query(
        'INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)',
        [user.id, tokensIn, tokensOut, MODEL]
      ).catch(() => {});

      return res.json({
        ...data,
        _meta: {
          tokens_used: total,
          tokens_balance: null, // нет баланса — свой ключ
          own_key: true,
        }
      });
    }

    // Серверный ключ: списываем токены атомарно
    const upd = await pool.query(
      `UPDATE users
       SET tokens_balance = tokens_balance - $1,
           tokens_used    = tokens_used    + $1,
           updated_at     = NOW()
       WHERE id = $2 AND tokens_balance >= $1
       RETURNING tokens_balance`,
      [total, user.id]
    );

    if (!upd.rows.length) {
      return res.status(402).json({ error: 'insufficient_tokens', message: 'Недостаточно токенов' });
    }

    await pool.query(
      'INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)',
      [user.id, tokensIn, tokensOut, MODEL]
    ).catch(() => {});

    res.json({
      ...data,
      _meta: {
        tokens_used: total,
        tokens_balance: upd.rows[0].tokens_balance,
        own_key: false,
      }
    });

  } catch (e) {
    if (e.response?.status === 401) {
      return res.status(401).json({ error: 'invalid_api_key', message: 'Недействительный API ключ. Проверьте ключ в настройках.' });
    }
    if (e.response?.status === 529 || e.response?.status === 503) {
      return res.status(503).json({ error: 'ai_overloaded', message: 'Claude перегружен, попробуйте снова' });
    }
    console.error('AI error:', e.response?.data || e.message);
    res.status(500).json({ error: 'ai_error', message: 'Ошибка нейросети' });
  }
});

// GET /api/ai/usage — статистика пользователя
router.get('/usage', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) as requests,
       SUM(tokens_in + tokens_out) as total_tokens,
       DATE_TRUNC('day', created_at) as day
     FROM token_log
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY day ORDER BY day DESC`,
    [req.user.id]
  );
  res.json({ usage: rows, balance: req.user.tokens_balance, used: req.user.tokens_used, own_key: !!req.user.own_api_key });
});

// PUT /api/ai/apikey — сохранить свой API ключ
router.put('/apikey', auth, async (req, res) => {
  try {
    const { api_key } = req.body;

    if (api_key === null || api_key === '') {
      // Удалить ключ
      await pool.query('UPDATE users SET own_api_key = NULL, updated_at = NOW() WHERE id = $1', [req.user.id]);
      return res.json({ ok: true, message: 'API ключ удалён. Теперь используется баланс токенов.' });
    }

    if (!isValidAnthropicKey(api_key)) {
      return res.status(400).json({ error: 'Неверный формат ключа. Ключ должен начинаться с sk-ant-' });
    }

    // Проверяем ключ живым запросом к Anthropic
    try {
      await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
        {
          headers: { 'x-api-key': api_key.trim(), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
    } catch (e) {
      if (e.response?.status === 401) {
        return res.status(400).json({ error: 'Ключ недействителен. Проверьте правильность.' });
      }
      // Другие ошибки (rate limit, overload) — ключ скорее всего валиден
    }

    await pool.query(
      'UPDATE users SET own_api_key = $1, updated_at = NOW() WHERE id = $2',
      [api_key.trim(), req.user.id]
    );

    res.json({ ok: true, message: 'API ключ сохранён. Теперь запросы идут через ваш ключ без списания баланса.' });
  } catch (e) {
    console.error('API key update error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
