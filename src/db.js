// Base de datos de la app. Tres modos, según las variables de entorno:
// - Google Sheets (GOOGLE_SHEET_ID): el archivo de Google Sheets es la base de datos. Es el modo de Vercel.
// - Turso (TURSO_DATABASE_URL): SQLite alojada en la nube.
// - Archivo local data/erp.db: para usar o probar la app en una computadora sin configurar nada.
const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@libsql/client');
const sheets = require('./sheets');

function modo() {
  if (process.env.GOOGLE_SHEET_ID) return 'sheets';
  if (process.env.TURSO_DATABASE_URL) return 'turso';
  if (process.env.VERCEL) throw new Error('Falta configurar la base de datos: define GOOGLE_SHEET_ID y GOOGLE_SERVICE_ACCOUNT_JSON en Vercel.');
  return 'local';
}

function crearCliente() {
  if (modo() === 'turso') return { client: createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }), local: false };
  const dir = process.env.ERP_DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  return { client: createClient({ url: 'file:' + path.join(dir, 'erp.db') }), local: true };
}


const ESQUEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL DEFAULT '',
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'empleado' CHECK (rol IN ('admin','empleado')),
  puesto TEXT DEFAULT '',
  departamento TEXT DEFAULT '',
  email TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  fecha_ingreso TEXT DEFAULT '',
  cumpleanos TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  debe_cambiar_password INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expira_en INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  clave TEXT PRIMARY KEY,
  intentos INTEGER NOT NULL,
  desde INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  prioridad TEXT NOT NULL DEFAULT 'media' CHECK (prioridad IN ('baja','media','alta')),
  fecha_limite TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_progreso','completada')),
  personal INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  accion TEXT NOT NULL,
  detalle TEXT DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fecha TEXT NOT NULL,
  horas REAL NOT NULL,
  nota TEXT DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  tipo TEXT NOT NULL DEFAULT 'actividad' CHECK (tipo IN ('actividad','reunion','entrega','festivo','vacaciones','otro')),
  fecha_inicio TEXT NOT NULL,
  fecha_fin TEXT DEFAULT '',
  hora TEXT DEFAULT '',
  general INTEGER NOT NULL DEFAULT 1,
  creado_por INTEGER NOT NULL REFERENCES users(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('home_office','permiso','ausencia','vacaciones','retardo','otra')),
  fecha_inicio TEXT NOT NULL,
  fecha_fin TEXT DEFAULT '',
  motivo TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada','cancelada')),
  revisado_por INTEGER REFERENCES users(id),
  comentario_revision TEXT DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  revisado_en TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (clave, valor) VALUES ('nombre_empresa', 'Mi Empresa');
INSERT OR IGNORE INTO settings (clave, valor) VALUES ('admin_ve_pendientes_personales', '0');
`;

let estado = null;
function conexion() {
  if (!estado) {
    const c = crearCliente();
    estado = {
      client: c.client,
      listo: (async () => {
        if (c.local) await c.client.execute('PRAGMA journal_mode = WAL');
        await c.client.executeMultiple(ESQUEMA);
        // Bases creadas con la versión anterior: agrega la columna nueva si falta
        const cols = (await c.client.execute('PRAGMA table_info(users)')).rows.map((r) => r[1]);
        if (!cols.includes('debe_cambiar_password')) {
          await c.client.execute('ALTER TABLE users ADD COLUMN debe_cambiar_password INTEGER NOT NULL DEFAULT 0');
        }
      })(),
    };
    estado.listo.catch(() => { estado = null; });
  }
  return estado;
}

// Convierte filas de libsql en objetos simples
const aObjeto = (rs, row) => Object.fromEntries(rs.columns.map((c, i) => [c, typeof row[i] === 'bigint' ? Number(row[i]) : row[i]]));

// Ayudantes de consulta sobre un ejecutor (cliente o transacción)
function ayudantes(ex) {
  return {
    async all(sql, ...args) { const rs = await ex.execute({ sql, args }); return rs.rows.map((r) => aObjeto(rs, r)); },
    async get(sql, ...args) { const rs = await ex.execute({ sql, args }); return rs.rows.length ? aObjeto(rs, rs.rows[0]) : undefined; },
    async run(sql, ...args) {
      const rs = await ex.execute({ sql, args });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid === undefined ? undefined : Number(rs.lastInsertRowid) };
    },
  };
}

const contexto = new AsyncLocalStorage();
let apiSheets = null;
let apiSheetsOpciones = {};

// Cliente de la solicitud actual: en modo Sheets, la copia en memoria de esa solicitud
function cliente() {
  const ctx = contexto.getStore();
  if (ctx) return ctx.client;
  if (modo() === 'sheets') throw new Error('Consulta fuera de una solicitud en modo Google Sheets.');
  return conexion().client;
}

const db = {
  modo,
  all: (...a) => ayudantes(cliente()).all(...a),
  get: (...a) => ayudantes(cliente()).get(...a),
  run: (...a) => ayudantes(cliente()).run(...a),
  // Ejecuta fn dentro de una transacción de escritura
  async transaccion(fn) {
    if (contexto.getStore()) {
      // En modo Sheets la solicitud entera ya es atómica: si algo falla, no se escribe nada en el archivo
      return fn(ayudantes(cliente()));
    }
    const tx = await conexion().client.transaction('write');
    try {
      const r = await fn(ayudantes(tx));
      await tx.commit();
      return r;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  },
  // Para pruebas: permite usar un servidor falso de Google Sheets
  configurarSheets(opciones) { apiSheetsOpciones = opciones; apiSheets = null; },
  // Middleware de Express para las rutas /api
  middleware() {
    return async (req, res, next) => {
      if (modo() !== 'sheets') { await conexion().listo; return next(); }
      apiSheets ||= sheets.crearApi(apiSheetsOpciones);
      let ctx;
      try {
        ctx = await sheets.cargar(apiSheets, ESQUEMA);
      } catch (e) {
        console.error(e);
        throw Object.assign(new Error(`No se pudo leer el archivo de Google Sheets. ${e.message}`), { status: 503, expose: true });
      }
      res.locals.dbctx = ctx;
      const json = res.json.bind(res);
      res.json = (cuerpo) => {
        res.json = json;
        const fin = () => ctx.client.close();
        if (ctx.abortado) { fin(); return json(cuerpo); }
        sheets.guardar(apiSheets, ctx).then(() => json(cuerpo), (err) => {
          console.error(err);
          res.status(500);
          json({ error: 'No se pudieron guardar los cambios en Google Sheets. Inténtalo de nuevo.' });
        }).finally(fin);
        return res;
      };
      contexto.run(ctx, next);
    };
  },
};

async function setting(clave) {
  const r = await db.get('SELECT valor FROM settings WHERE clave = ?', clave);
  return r ? r.valor : null;
}

module.exports = { db, setting };
