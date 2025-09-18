const jwt = require('jsonwebtoken');
const { pool } = require('../db');

module.exports = async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ message: 'Nicht eingeloggt' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, is_admin FROM public.users WHERE id = $1 LIMIT 1',
      [payload.id]
    );
    if (rows.length === 0) return res.status(401).json({ message: 'User nicht gefunden' });

    req.user = { id: rows[0].id, is_admin: !!rows[0].is_admin };
    next();
  } catch (err) {
    console.error('Auth Fehler:', err.message);
    return res.status(401).json({ message: 'Session ungültig' });
  }
};
