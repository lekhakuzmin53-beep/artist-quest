// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const router  = express.Router();

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email))
      return res.status(400).json({ error: 'Неверный формат email' });

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email уже занят' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username, tokens_balance',
      [email.toLowerCase(), username.trim(), hash]
    );
    const user = rows[0];
    res.json({ token: makeToken(user.id), user: { id: user.id, email: user.email, username: user.username, tokens_balance: 0 } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const { rows } = await pool.query(
      'SELECT id, email, username, password_hash, tokens_balance, tokens_used FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Неверный email или пароль' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

    res.json({
      token: makeToken(user.id),
      user: { id: user.id, email: user.email, username: user.username, tokens_balance: user.tokens_balance, tokens_used: user.tokens_used }
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth'), (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password — смена пароля (нужен старый)
router.post('/change-password', require('../middleware/auth'), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Заполните оба поля' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Старый пароль неверен' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/admin-reset-password — сброс пароля админом по email
// Требует заголовок X-Admin-Secret === process.env.ADMIN_SECRET
router.post('/admin-reset-password', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'];
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET)
      return res.status(403).json({ error: 'Доступ запрещён' });
    const { email, newPassword } = req.body;
    if (!email || !newPassword) return res.status(400).json({ error: 'Нужны email и newPassword' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const hash = await bcrypt.hash(newPassword, 12);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2',
      [hash, email.toLowerCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'Email не найден' });
    res.json({ ok: true, message: 'Пароль обновлён' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
