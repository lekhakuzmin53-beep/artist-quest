const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'auth_required', message: 'Требуется авторизация.' });
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, email, username, tokens_balance, tokens_used, own_api_key, own_provider, own_model FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'user_not_found', message: 'Пользователь не найден.' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token', message: 'Недействительный токен. Войдите снова.' });
  }
};
