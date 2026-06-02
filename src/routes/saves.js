// src/routes/saves.js — облачные сохранения
const express = require('express');
const pool    = require('../db/pool');
const auth    = require('../middleware/auth');
const router  = express.Router();

// GET /api/saves — список всех сохранений пользователя
router.get('/', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT slot, name, updated_at, data->>\'worldName\' as world_name, data->>\'hardcore\' as hardcore FROM saves WHERE user_id=$1 ORDER BY slot',
    [req.user.id]
  );
  res.json({ saves: rows });
});

// GET /api/saves/:slot — загрузить сохранение
router.get('/:slot', auth, async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (isNaN(slot) || slot < 0 || slot > 9) return res.status(400).json({ error: 'Неверный слот' });

  const { rows } = await pool.query(
    'SELECT data FROM saves WHERE user_id=$1 AND slot=$2',
    [req.user.id, slot]
  );
  if (!rows.length) return res.status(404).json({ error: 'Сохранение не найдено' });
  res.json({ save: rows[0].data });
});

// POST /api/saves/:slot — записать сохранение
router.post('/:slot', auth, async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (isNaN(slot) || slot < 0 || slot > 9) return res.status(400).json({ error: 'Неверный слот' });

  const { data, name } = req.body;
  if (!data) return res.status(400).json({ error: 'Нет данных сохранения' });

  await pool.query(
    `INSERT INTO saves (user_id, slot, name, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, slot) DO UPDATE
     SET name=$3, data=$4, updated_at=NOW()`,
    [req.user.id, slot, name || 'Безымянное', data]
  );
  res.json({ ok: true });
});

// DELETE /api/saves/:slot
router.delete('/:slot', auth, async (req, res) => {
  const slot = parseInt(req.params.slot);
  await pool.query('DELETE FROM saves WHERE user_id=$1 AND slot=$2', [req.user.id, slot]);
  res.json({ ok: true });
});

module.exports = router;
