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

const iguales = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Revisa la contraseña de un usuario. Además del hash normal acepta la contraseña provisional:
// - si password_hash está vacío (usuario agregado a mano en la hoja), la contraseña es el nombre de usuario;
// - si password_hash tiene texto que no es un hash, ese texto es la contraseña.
// En ambos casos la persona debe cambiarla al entrar.
async function revisarPassword(password, user) {
  const guardado = user.password_hash == null ? '' : String(user.password_hash).trim();
  if (guardado.startsWith('scrypt$')) return { ok: await verifyPassword(password, guardado), provisional: !!user.debe_cambiar_password };
  const esperado = guardado === '' ? user.username : guardado;
  return { ok: iguales(password, esperado), provisional: true };
}

function validatePassword(p, username) {
  if (typeof p !== 'string' || p.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (username && p.toLowerCase() === String(username).toLowerCase()) return 'La contraseña no puede ser igual a tu usuario.';
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
    const row = await db.get(`SELECT u.id, u.username, u.nombre, u.rol, u.activo, u.debe_cambiar_password, s.expira_en
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, hashToken(token));
    if (row && row.expira_en > Date.now() && row.activo) {
      req.user = { id: row.id, username: row.username, nombre: row.nombre, rol: row.rol, debeCambiar: !!row.debe_cambiar_password };
      req.sessionToken = hashToken(token);
    }
  }
  next();
}

// Con contraseña provisional solo se permite ver el perfil propio, cambiar la contraseña y salir
const PERMITIDAS_PROVISIONAL = new Set(['GET /api/me', 'POST /api/me/password', 'POST /api/logout', 'GET /api/setup']);
function exigirCambioPassword(req, res, next) {
  if (req.user && req.user.debeCambiar && !PERMITIDAS_PROVISIONAL.has(`${req.method} ${req.baseUrl}${req.path}`)) {
    return res.status(403).json({ error: 'Primero cambia tu contraseña provisional.', debe_cambiar_password: true });
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
  hashPassword, verifyPassword, revisarPassword, validatePassword, exigirCambioPassword, createSession, setSessionCookie,
  clearSessionCookie, loadUser, requireAuth, requireAdmin, loginBloqueado, loginFallido, loginCorrecto,
};
