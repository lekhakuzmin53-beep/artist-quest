// src/middleware/auth.js
const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

    const { userId } = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      'SELECT id, email, username, tokens_balance, tokens_used, own_api_key FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });

    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Недействительный токен' });
  }
};
