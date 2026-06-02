// src/routes/ai.js — мультимодельный прокси
const express = require('express');
const axios   = require('axios');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const SERVER_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Поддерживаемые провайдеры
const PROVIDERS = {
  claude:  { name: 'Claude (Anthropic)',  models: ['claude-sonnet-4-20250514','claude-haiku-4-5-20251001'] },
  openai:  { name: 'OpenAI (GPT)',        models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo'] },
  gemini:  { name: 'Google Gemini',       models: ['gemini-1.5-pro','gemini-1.5-flash','gemini-2.0-flash'] },
  mistral: { name: 'Mistral AI',          models: ['mistral-large-latest','mistral-small-latest','open-mistral-7b'] },
};

function getProviderFromKey(key) {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'claude';
  if (key.startsWith('sk-') && !key.startsWith('sk-ant-')) return 'openai';
  if (key.startsWith('AI') || key.length === 39) return 'gemini';
  return 'mistral'; // fallback
}

function getProviderFromModel(model) {
  for (const [provider, info] of Object.entries(PROVIDERS)) {
    if (info.models.includes(model)) return provider;
  }
  return null;
}

function isValidKey(key) {
  return typeof key === 'string' && key.trim().length > 10;
}

// Вызов Claude API
async function callClaude(apiKey, model, system, messages, maxTokens) {
  const m = model || 'claude-sonnet-4-20250514';
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: m, max_tokens: maxTokens, system, messages },
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  const d = res.data;
  return {
    text: d.content?.map(c => c.text || '').join('') || '',
    tokensIn: d.usage?.input_tokens || 0,
    tokensOut: d.usage?.output_tokens || 0,
  };
}

// Вызов OpenAI API
async function callOpenAI(apiKey, model, system, messages, maxTokens) {
  const m = model || 'gpt-4o-mini';
  const oaiMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: m, max_tokens: maxTokens, messages: oaiMessages },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  const d = res.data;
  return {
    text: d.choices?.[0]?.message?.content || '',
    tokensIn: d.usage?.prompt_tokens || 0,
    tokensOut: d.usage?.completion_tokens || 0,
  };
}

// Вызов Gemini API
async function callGemini(apiKey, model, system, messages, maxTokens) {
  const m = model || 'gemini-1.5-flash';
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
    body,
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  const d = res.data;
  const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return {
    text,
    tokensIn: d.usageMetadata?.promptTokenCount || 0,
    tokensOut: d.usageMetadata?.candidatesTokenCount || 0,
  };
}

// Вызов Mistral API
async function callMistral(apiKey, model, system, messages, maxTokens) {
  const m = model || 'mistral-small-latest';
  const mistralMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const res = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    { model: m, max_tokens: maxTokens, messages: mistralMessages },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  const d = res.data;
  return {
    text: d.choices?.[0]?.message?.content || '',
    tokensIn: d.usage?.prompt_tokens || 0,
    tokensOut: d.usage?.completion_tokens || 0,
  };
}

async function callProvider(provider, apiKey, model, system, messages, maxTokens) {
  switch (provider) {
    case 'claude':  return callClaude(apiKey, model, system, messages, maxTokens);
    case 'openai':  return callOpenAI(apiKey, model, system, messages, maxTokens);
    case 'gemini':  return callGemini(apiKey, model, system, messages, maxTokens);
    case 'mistral': return callMistral(apiKey, model, system, messages, maxTokens);
    default: throw new Error('Неизвестный провайдер: ' + provider);
  }
}

function friendlyError(e, provider) {
  const status = e.response?.status;
  const body = e.response?.data;

  if (status === 401) return {
    error: 'invalid_api_key',
    message: `Ключ ${PROVIDERS[provider]?.name || provider} недействителен. Проверьте ключ в настройках — возможно, он устарел или введён с ошибкой.`,
    action: 'Перейдите в Настройки → Свои ключи и проверьте ключ.'
  };
  if (status === 403) return {
    error: 'forbidden',
    message: `Доступ запрещён. Возможно, у вашего ключа нет прав на эту модель.`,
    action: 'Попробуйте другую модель или проверьте тарифный план.'
  };
  if (status === 429) return {
    error: 'rate_limit',
    message: `Слишком много запросов к ${PROVIDERS[provider]?.name || provider}. Подождите немного.`,
    action: 'Подождите 30–60 секунд и попробуйте снова.'
  };
  if (status === 402 || (body?.error?.code === 'insufficient_quota')) return {
    error: 'no_credits',
    message: `На счёте ${PROVIDERS[provider]?.name || provider} закончились средства.`,
    action: 'Пополните баланс на сайте провайдера или используйте другой ключ.'
  };
  if (status === 529 || status === 503 || status === 502) return {
    error: 'ai_overloaded',
    message: `Серверы ${PROVIDERS[provider]?.name || provider} временно перегружены.`,
    action: 'Попробуйте снова через 1–2 минуты.'
  };
  if (e.code === 'ECONNABORTED') return {
    error: 'timeout',
    message: 'Нейросеть не ответила за 60 секунд.',
    action: 'Попробуйте снова или сократите запрос.'
  };
  return {
    error: 'ai_error',
    message: `Ошибка нейросети: ${body?.error?.message || e.message || 'неизвестная ошибка'}.`,
    action: 'Попробуйте ещё раз. Если ошибка повторяется — смените модель.'
  };
}

// POST /api/ai/chat
router.post('/chat', auth, async (req, res) => {
  try {
    const user = req.user;
    const { messages, system, max_tokens = 800, model: requestedModel } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'bad_request', message: 'Неверный формат запроса.' });
    }

    // Определяем провайдер и ключ
    let apiKey, provider, model;

    if (user.own_api_key) {
      apiKey = user.own_api_key;
      provider = user.own_provider || getProviderFromKey(apiKey);
      model = requestedModel || user.own_model || null;
    } else {
      // Серверный Claude
      if (!SERVER_ANTHROPIC_KEY) {
        return res.status(503).json({
          error: 'no_server_key',
          message: 'Серверный API ключ не настроен администратором.',
          action: 'Обратитесь к администратору или добавьте свой ключ в настройках.'
        });
      }
      if (user.tokens_balance < 500) {
        return res.status(402).json({
          error: 'insufficient_tokens',
          message: `Недостаточно токенов (у вас ${user.tokens_balance}, нужно минимум 500).`,
          action: 'Пополните баланс в личном кабинете или добавьте свой API ключ.'
        });
      }
      apiKey = SERVER_ANTHROPIC_KEY;
      provider = 'claude';
      model = 'claude-sonnet-4-20250514';
    }

    const safeMaxTokens = user.own_api_key
      ? Math.min(requestedModel || 2000, 2000)
      : Math.min(max_tokens, Math.min(2000, user.tokens_balance));

    let result;
    try {
      result = await callProvider(provider, apiKey, model, system, messages, safeMaxTokens);
    } catch (e) {
      const err = friendlyError(e, provider);
      return res.status(e.response?.status >= 500 ? 503 : 400).json(err);
    }

    const total = result.tokensIn + result.tokensOut;

    if (user.own_api_key) {
      await pool.query(
        'UPDATE users SET tokens_used = tokens_used + $1, updated_at = NOW() WHERE id = $2',
        [total, user.id]
      );
    } else {
      const upd = await pool.query(
        `UPDATE users SET tokens_balance = tokens_balance - $1, tokens_used = tokens_used + $1, updated_at = NOW()
         WHERE id = $2 AND tokens_balance >= $1 RETURNING tokens_balance`,
        [total, user.id]
      );
      if (!upd.rows.length) {
        return res.status(402).json({
          error: 'insufficient_tokens',
          message: 'Баланс токенов изменился во время запроса.',
          action: 'Пополните баланс.'
        });
      }
      await pool.query(
        'INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)',
        [user.id, result.tokensIn, result.tokensOut, model || provider]
      ).catch(() => {});

      return res.json({
        content: [{ type: 'text', text: result.text }],
        _meta: { tokens_used: total, tokens_balance: upd.rows[0].tokens_balance, own_key: false, provider }
      });
    }

    await pool.query(
      'INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)',
      [user.id, result.tokensIn, result.tokensOut, model || provider]
    ).catch(() => {});

    res.json({
      content: [{ type: 'text', text: result.text }],
      _meta: { tokens_used: total, tokens_balance: null, own_key: true, provider, model }
    });

  } catch (e) {
    console.error('AI route error:', e.message);
    res.status(500).json({ error: 'server_error', message: 'Внутренняя ошибка сервера.', action: 'Попробуйте ещё раз.' });
  }
});

// GET /api/ai/usage
router.get('/usage', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as requests, SUM(tokens_in + tokens_out) as total_tokens,
     DATE_TRUNC('day', created_at) as day
     FROM token_log WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY day ORDER BY day DESC`,
    [req.user.id]
  );
  res.json({ usage: rows, balance: req.user.tokens_balance, used: req.user.tokens_used, own_key: !!req.user.own_api_key, provider: req.user.own_provider });
});

// PUT /api/ai/apikey — сохранить ключ + провайдер + модель
router.put('/apikey', auth, async (req, res) => {
  try {
    const { api_key, provider, model } = req.body;

    if (api_key === null || api_key === '') {
      await pool.query('UPDATE users SET own_api_key = NULL, own_provider = NULL, own_model = NULL, updated_at = NOW() WHERE id = $1', [req.user.id]);
      return res.json({ ok: true, message: 'Ключ удалён. Теперь используется серверный баланс токенов.' });
    }

    if (!isValidKey(api_key)) {
      return res.status(400).json({ error: 'Неверный формат ключа. Ключ слишком короткий.' });
    }

    const detectedProvider = provider || getProviderFromKey(api_key);

    // Проверяем ключ живым запросом
    try {
      await callProvider(detectedProvider, api_key.trim(), model || null, null, [{ role: 'user', content: 'Hi' }], 5);
    } catch (e) {
      const err = friendlyError(e, detectedProvider);
      if (err.error === 'invalid_api_key' || err.error === 'forbidden') {
        return res.status(400).json({ error: err.message });
      }
      // rate_limit / overload — ключ скорее всего валиден
    }

    await pool.query(
      'UPDATE users SET own_api_key = $1, own_provider = $2, own_model = $3, updated_at = NOW() WHERE id = $4',
      [api_key.trim(), detectedProvider, model || null, req.user.id]
    );

    res.json({ ok: true, provider: detectedProvider, message: `Ключ ${PROVIDERS[detectedProvider]?.name || detectedProvider} сохранён.` });
  } catch (e) {
    console.error('API key update error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера при сохранении ключа.' });
  }
});

// GET /api/ai/providers — список провайдеров и моделей
router.get('/providers', (req, res) => {
  res.json({ providers: PROVIDERS });
});

module.exports = router;
