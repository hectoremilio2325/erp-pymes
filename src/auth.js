// Contraseñas con hash (scrypt + sal aleatoria) y sesiones guardadas en la base de datos
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db } = require('./db');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 7;
const COOKIE = 'erp_sesion';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60e3;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'La contraseña debe incluir letras y números.';
  return null;
}

// En la base solo se guarda el hash del token: quien vea la hoja Sesiones no puede usarlo para entrar
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = Date.now() + SESSION_DAYS * 864e5;
  await db.run('DELETE FROM sessions WHERE expira_en < ?', Date.now());
  await db.run('INSERT INTO sessions (token, user_id, expira_en) VALUES (?, ?, ?)', hashToken(token), userId, expira);
  return { token, expira };
}

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token, expira, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Expires=${new Date(expira).toUTCString()}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Middleware: carga el usuario de la sesión
async function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null;
  if (token) {
    const row = await db.get(`SELECT u.id, u.username, u.nombre, u.rol, u.activo, s.expira_en
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, hashToken(token));
    if (row && row.expira_en > Date.now() && row.activo) {
      req.user = { id: row.id, username: row.username, nombre: row.nombre, rol: row.rol };
      req.sessionToken = hashToken(token);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión.' });
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede hacer esto.' });
  next();
}

// Limita intentos fallidos de inicio de sesión (5 cada 15 minutos por IP y usuario).
// Se guarda en la base de datos para que funcione también en Vercel, donde no hay memoria compartida.
async function loginBloqueado(clave) {
  const r = await db.get('SELECT intentos, desde FROM login_attempts WHERE clave = ?', clave);
  return !!r && Date.now() - r.desde < VENTANA_MS && r.intentos >= MAX_INTENTOS;
}
async function loginFallido(clave) {
  const ahora = Date.now();
  await db.run(`INSERT INTO login_attempts (clave, intentos, desde) VALUES (?, 1, ?)
    ON CONFLICT(clave) DO UPDATE SET
      intentos = CASE WHEN ? - desde > ? THEN 1 ELSE intentos + 1 END,
      desde = CASE WHEN ? - desde > ? THEN ? ELSE desde END`, clave, ahora, ahora, VENTANA_MS, ahora, VENTANA_MS, ahora);
}
async function loginCorrecto(clave) {
  await db.run('DELETE FROM login_attempts WHERE clave = ? OR desde < ?', clave, Date.now() - VENTANA_MS);
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, createSession, setSessionCookie,
  clearSessionCookie, loadUser, requireAuth, requireAdmin, loginBloqueado, loginFallido, loginCorrecto,
};
