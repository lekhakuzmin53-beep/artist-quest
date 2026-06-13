// src/routes/ai.js — мультимодельный прокси
const express = require('express');
const axios   = require('axios');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

const SERVER_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PROVIDERS = {
  claude:   { name: 'Claude (Anthropic)',   models: ['claude-sonnet-4-20250514','claude-haiku-4-5-20251001'] },
  openai:   { name: 'OpenAI (GPT)',         models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'] },
  gemini:   { name: 'Google Gemini',        models: ['gemini-1.5-pro','gemini-1.5-flash','gemini-2.0-flash'] },
  mistral:  { name: 'Mistral AI',           models: ['mistral-large-latest','mistral-small-latest','open-mistral-7b'] },
  aitunnel: { name: 'AITunnel (РФ)',        models: ['claude-sonnet-4-20250514','claude-haiku-4-5-20251001','gpt-4o','gpt-4o-mini','gpt-3.5-turbo'] },
};

// Определяем провайдера по ключу
function detectProvider(key, hint) {
  if (hint && PROVIDERS[hint]) return hint;
  if (!key) return 'claude';
  const k = key.trim();
  if (k.startsWith('sk-aitunnel-')) return 'aitunnel';
  if (k.startsWith('sk-ant-'))      return 'claude';
  if (k.startsWith('sk-'))          return 'openai';
  if (k.startsWith('AIza'))         return 'gemini';
  // Всё остальное — пробуем как aitunnel (OpenAI-совместимый)
  return 'aitunnel';
}

// ── ПРОВАЙДЕРЫ ────────────────────────────────────────────

async function callClaude(apiKey, model, system, messages, maxTokens) {
  const m = model || 'claude-sonnet-4-20250514';
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: m, max_tokens: maxTokens, system, messages },
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return { text: r.data.content?.map(c=>c.text||'').join('')||'', tokensIn: r.data.usage?.input_tokens||0, tokensOut: r.data.usage?.output_tokens||0 };
}

// AITunnel — OpenAI-совместимый
async function callAITunnel(apiKey, model, system, messages, maxTokens) {
  const m = model || 'claude-sonnet-4-20250514';
  const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
  const r = await axios.post('https://api.aitunnel.ru/v1/chat/completions',
    { model: m, max_tokens: maxTokens, messages: msgs },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return { text: r.data.choices?.[0]?.message?.content||'', tokensIn: r.data.usage?.prompt_tokens||0, tokensOut: r.data.usage?.completion_tokens||0 };
}

async function callOpenAI(apiKey, model, system, messages, maxTokens) {
  const m = model || 'gpt-4o-mini';
  const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
  const r = await axios.post('https://api.openai.com/v1/chat/completions',
    { model: m, max_tokens: maxTokens, messages: msgs },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return { text: r.data.choices?.[0]?.message?.content||'', tokensIn: r.data.usage?.prompt_tokens||0, tokensOut: r.data.usage?.completion_tokens||0 };
}

async function callGemini(apiKey, model, system, messages, maxTokens) {
  const m = model || 'gemini-1.5-flash';
  const contents = messages.map(msg => ({ role: msg.role==='assistant'?'model':'user', parts:[{text:msg.content}] }));
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts:[{text:system}] };
  const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
    body, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return { text: r.data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'', tokensIn: r.data.usageMetadata?.promptTokenCount||0, tokensOut: r.data.usageMetadata?.candidatesTokenCount||0 };
}

async function callMistral(apiKey, model, system, messages, maxTokens) {
  const m = model || 'mistral-small-latest';
  const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
  const r = await axios.post('https://api.mistral.ai/v1/chat/completions',
    { model: m, max_tokens: maxTokens, messages: msgs },
    { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return { text: r.data.choices?.[0]?.message?.content||'', tokensIn: r.data.usage?.prompt_tokens||0, tokensOut: r.data.usage?.completion_tokens||0 };
}

async function callProvider(provider, apiKey, model, system, messages, maxTokens) {
  switch (provider) {
    case 'claude':   return callClaude(apiKey, model, system, messages, maxTokens);
    case 'openai':   return callOpenAI(apiKey, model, system, messages, maxTokens);
    case 'gemini':   return callGemini(apiKey, model, system, messages, maxTokens);
    case 'mistral':  return callMistral(apiKey, model, system, messages, maxTokens);
    case 'aitunnel':
    default:         return callAITunnel(apiKey, model, system, messages, maxTokens);
  }
}

function friendlyError(e, provider) {
  const status = e.response?.status;
  const body   = e.response?.data;
  const pName  = PROVIDERS[provider]?.name || provider;
  const raw    = body?.error?.message || body?.message || e.message || '';

  if (status === 401) return { error: 'invalid_api_key',
    message: `Ключ ${pName} недействителен.`,
    action:  'Проверьте ключ — возможно опечатка или ключ истёк. Скопируйте заново из личного кабинета провайдера.' };
  if (status === 403) return { error: 'forbidden',
    message: `Доступ запрещён. У ключа нет прав на модель "${provider}".`,
    action:  'Попробуйте другую модель или пополните баланс у провайдера.' };
  if (status === 429) return { error: 'rate_limit',
    message: `Слишком много запросов к ${pName}.`,
    action:  'Подождите 30–60 секунд и попробуйте снова.' };
  if (status === 402 || raw.includes('quota') || raw.includes('billing')) return { error: 'no_credits',
    message: `На счёте ${pName} закончились средства.`,
    action:  'Пополните баланс на сайте провайдера.' };
  if (status >= 500 || status === 503 || status === 529) return { error: 'ai_overloaded',
    message: `Серверы ${pName} временно недоступны (${status}).`,
    action:  'Попробуйте снова через 1–2 минуты.' };
  if (e.code === 'ECONNABORTED') return { error: 'timeout',
    message: 'Нейросеть не ответила за 60 секунд.',
    action:  'Попробуйте снова или выберите более быструю модель.' };
  return { error: 'ai_error',
    message: `Ошибка: ${raw || 'неизвестная ошибка'} (${status || 'нет ответа'}).`,
    action:  'Попробуйте ещё раз или смените модель в Настройках.' };
}

// ── МАРШРУТЫ ──────────────────────────────────────────────

// POST /api/ai/chat
router.post('/chat', auth, async (req, res) => {
  try {
    const user = req.user;
    const { messages, system, max_tokens = 800, model: reqModel } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: 'bad_request', message: 'Неверный формат запроса.' });

    let apiKey, provider, model;

    if (user.own_api_key) {
      apiKey   = user.own_api_key;
      provider = user.own_provider || detectProvider(apiKey, null);
      model    = reqModel || user.own_model || null;
    } else {
      if (!SERVER_ANTHROPIC_KEY)
        return res.status(503).json({ error: 'no_server_key', message: 'Серверный ключ не настроен.', action: 'Добавьте свой API ключ в Настройках.' });
      if (user.tokens_balance < 500)
        return res.status(402).json({ error: 'insufficient_tokens', message: `Недостаточно токенов (у вас ${user.tokens_balance}, нужно минимум 500).`, action: 'Пополните баланс (значок 💎 на главном экране) или добавьте свой API ключ в Настройках.' });
      apiKey   = SERVER_ANTHROPIC_KEY;
      provider = 'claude';
      // Тариф: клиент передаёт model — разрешаем только haiku или sonnet
      const allowed = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514'];
      model = allowed.includes(reqModel) ? reqModel : 'claude-haiku-4-5-20251001';
    }

    const safeMax = Math.min(max_tokens, user.own_api_key ? 2000 : Math.min(2000, user.tokens_balance));

    let result;
    try {
      result = await callProvider(provider, apiKey, model, system, messages, safeMax);
    } catch (e) {
      return res.status(e.response?.status >= 500 ? 503 : 400).json(friendlyError(e, provider));
    }

    const total = result.tokensIn + result.tokensOut;

    if (user.own_api_key) {
      await pool.query('UPDATE users SET tokens_used = tokens_used + $1, updated_at = NOW() WHERE id = $2', [total, user.id]);
      await pool.query('INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)', [user.id, result.tokensIn, result.tokensOut, model||provider]).catch(()=>{});
      return res.json({ content:[{type:'text',text:result.text}], _meta:{tokens_used:total,tokens_balance:null,own_key:true,provider} });
    }

    const upd = await pool.query(
      `UPDATE users SET tokens_balance=tokens_balance-$1, tokens_used=tokens_used+$1, updated_at=NOW()
       WHERE id=$2 AND tokens_balance>=$1 RETURNING tokens_balance`,
      [total, user.id]
    );
    if (!upd.rows.length)
      return res.status(402).json({ error:'insufficient_tokens', message:'Баланс изменился во время запроса.', action:'Пополните баланс.' });
    await pool.query('INSERT INTO token_log (user_id, tokens_in, tokens_out, model) VALUES ($1,$2,$3,$4)', [user.id, result.tokensIn, result.tokensOut, model||provider]).catch(()=>{});
    res.json({ content:[{type:'text',text:result.text}], _meta:{tokens_used:total,tokens_balance:upd.rows[0].tokens_balance,own_key:false,provider} });

  } catch (e) {
    console.error('AI route error:', e.message);
    res.status(500).json({ error:'server_error', message:'Внутренняя ошибка сервера.', action:'Попробуйте ещё раз.' });
  }
});

// PUT /api/ai/apikey — сохраняем БЕЗ проверки (проверка мешает AITunnel)
router.put('/apikey', auth, async (req, res) => {
  try {
    const { api_key, provider, model } = req.body;

    if (api_key === null || api_key === '') {
      await pool.query('UPDATE users SET own_api_key=NULL, own_provider=NULL, own_model=NULL, updated_at=NOW() WHERE id=$1', [req.user.id]);
      return res.json({ ok:true, message:'Ключ удалён. Теперь используется серверный баланс токенов.' });
    }

    if (!api_key || api_key.trim().length < 5)
      return res.status(400).json({ error:'Ключ слишком короткий.' });

    const detectedProvider = provider || detectProvider(api_key, null);

    await pool.query(
      'UPDATE users SET own_api_key=$1, own_provider=$2, own_model=$3, updated_at=NOW() WHERE id=$4',
      [api_key.trim(), detectedProvider, model||null, req.user.id]
    );

    const pName = PROVIDERS[detectedProvider]?.name || detectedProvider;
    res.json({ ok:true, provider:detectedProvider, providerName:pName, message:`Ключ сохранён (${pName}). Попробуйте начать игру — если ключ неверный, ошибка появится там.` });

  } catch (e) {
    console.error('API key error:', e.message);
    res.status(500).json({ error:'Ошибка сервера при сохранении ключа.' });
  }
});

router.get('/usage', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as requests, SUM(tokens_in+tokens_out) as total_tokens, DATE_TRUNC('day',created_at) as day
     FROM token_log WHERE user_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY day ORDER BY day DESC`,
    [req.user.id]
  );
  res.json({ usage:rows, balance:req.user.tokens_balance, used:req.user.tokens_used, own_key:!!req.user.own_api_key, provider:req.user.own_provider });
});

router.get('/providers', (_req, res) => res.json({ providers: PROVIDERS }));

module.exports = router;
