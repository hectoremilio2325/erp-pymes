// Google Sheets como base de datos.
//
// En cada solicitud a la API se leen las hojas del archivo, se cargan en una base SQLite en memoria
// (para reutilizar las mismas consultas de la app) y, al terminar, solo las filas que cambiaron se
// escriben de vuelta en el archivo: filas nuevas se agregan al final, las modificadas se actualizan
// en su lugar y las borradas se eliminan. Así el archivo de Google Sheets es la única fuente de datos.
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

// Tabla de la app -> hoja del archivo. Las tareas se reparten en dos hojas según sean personales o no.
const TABLAS = {
  users: { hojas: ['Usuarios'], clave: ['id'] },
  tasks: { hojas: ['Tareas', 'Pendientes'], clave: ['id'], hojaDe: (fila) => (Number(fila.personal) === 1 ? 'Pendientes' : 'Tareas') },
  task_assignees: { hojas: ['Responsables'], clave: ['task_id', 'user_id'] },
  task_history: { hojas: ['Historial_Tareas'], clave: ['id'] },
  events: { hojas: ['Calendario'], clave: ['id'] },
  incidents: { hojas: ['Incidencias'], clave: ['id'] },
  settings: { hojas: ['Configuracion'], clave: ['clave'] },
  sessions: { hojas: ['Sesiones'], clave: ['token'] },
  login_attempts: { hojas: ['Intentos_Login'], clave: ['clave'] },
};
const COLUMNAS_FECHA = new Set(['fecha_limite', 'fecha_inicio', 'fecha_fin', 'fecha_ingreso', 'cumpleanos']);

// ---------- autenticación con cuenta de servicio ----------
function credenciales() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(raw);
    return { email: j.client_email, key: j.private_key };
  }
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return { email: process.env.GOOGLE_CLIENT_EMAIL, key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }
  throw new Error('Faltan las credenciales de Google: define GOOGLE_SERVICE_ACCOUNT_JSON.');
}

let tokenCache = null;
async function tokenGoogle(fetchImpl) {
  if (tokenCache && tokenCache.expira > Date.now() + 60e3) return tokenCache.token;
  const { email, key } = credenciales();
  const ahora = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sinFirma = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
  })}`;
  const firma = crypto.sign('RSA-SHA256', Buffer.from(sinFirma), key).toString('base64url');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${sinFirma}.${firma}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google rechazó la cuenta de servicio: ${data.error_description || data.error || res.status}`);
  tokenCache = { token: data.access_token, expira: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// ---------- cliente REST mínimo de Google Sheets ----------
function crearApi(opciones = {}) {
  const fetchImpl = opciones.fetch || fetch;
  const base = opciones.base || 'https://sheets.googleapis.com';
  const id = opciones.spreadsheetId || process.env.GOOGLE_SHEET_ID;
  const token = opciones.token || (() => tokenGoogle(fetchImpl));
  let idsHojas = null;

  async function llamar(metodo, ruta, cuerpo) {
    const res = await fetchImpl(`${base}/v4/spreadsheets/${encodeURIComponent(id)}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await token()}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      throw new Error(`Google Sheets: ${msg}`);
    }
    return data;
  }
  const rango = (hoja) => `'${hoja.replace(/'/g, "''")}'`;

  return {
    async leer(hojas) {
      const qs = hojas.map((h) => `ranges=${encodeURIComponent(rango(h))}`).join('&');
      const data = await llamar('GET', `/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
      const out = {};
      hojas.forEach((h, i) => { out[h] = (data.valueRanges[i] && data.valueRanges[i].values) || []; });
      return out;
    },
    async idsDeHojas() {
      if (!idsHojas) {
        const data = await llamar('GET', '?fields=sheets.properties.sheetId,sheets.properties.title');
        idsHojas = Object.fromEntries(data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
      }
      return idsHojas;
    },
    actualizar: (datos) => llamar('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: datos }),
    agregar: (hoja, filas) => llamar('POST', `/values/${encodeURIComponent(rango(hoja))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: filas }),
    lote: (requests) => llamar('POST', ':batchUpdate', { requests }),
  };
}

// ---------- conversión de valores ----------
function serialAFecha(n) {
  const d = new Date(Math.round((n - 25569) * 864e5));
  return d.toISOString().slice(0, 10);
}
function serialAHora(n) {
  const min = Math.round((n % 1) * 1440);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
// Valor de una celda -> valor para SQLite (undefined = celda vacía)
const COLUMNAS_SI_NO = new Set(['activo', 'personal', 'general', 'debe_cambiar_password']);
const COLUMNAS_OPCION = new Set(['rol', 'prioridad', 'estado', 'tipo']);
const sinAcentos = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function deCelda(col, v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  // Valores escritos a mano: "sí"/"no", "Admin", "En progreso", "Home Office"...
  if (COLUMNAS_SI_NO.has(col) && typeof v === 'string') {
    const t = sinAcentos(v.trim().toLowerCase());
    if (['si', 's', 'yes', 'true', 'verdadero', 'x', '1', 'activo'].includes(t)) return 1;
    if (['no', 'n', 'false', 'falso', '0', 'inactivo'].includes(t)) return 0;
  }
  if (COLUMNAS_OPCION.has(col) && typeof v === 'string') {
    const t = sinAcentos(v.trim().toLowerCase()).replace(/\s+/g, '_');
    if (col === 'rol') return t.startsWith('admin') || t === 'jefe' ? 'admin' : 'empleado';
    return t;
  }
  if (typeof v === 'number' && COLUMNAS_FECHA.has(col)) return serialAFecha(v);
  if (typeof v === 'number' && col === 'hora') return serialAHora(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'string' ? v.trim() : v;
}
// Valor de SQLite -> valor para escribir en la hoja
const aCelda = (v) => (v === null || v === undefined ? '' : typeof v === 'bigint' ? Number(v) : v);

// ---------- carga y guardado ----------
function letraColumna(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

async function columnasDe(client, tabla) {
  const rs = await client.execute(`PRAGMA table_info(${tabla})`);
  return rs.rows.map((r) => r[1]);
}
const claveDe = (def, fila) => JSON.stringify(def.clave.map((c) => (fila[c] === undefined || fila[c] === null ? '' : String(fila[c]))));

async function todasLasFilas(client, tabla) {
  const rs = await client.execute(`SELECT * FROM ${tabla}`);
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, aCelda(r[i])])));
}

// Lee el archivo y prepara la base en memoria para una solicitud
async function cargar(api, esquema) {
  const hojas = Object.values(TABLAS).flatMap((t) => t.hojas);
  const datos = await api.leer(hojas);
  const client = createClient({ url: ':memory:' });
  // En memoria se quitan las restricciones CHECK para que un dato escrito a mano no impida cargar el archivo
  await client.executeMultiple(esquema.replace(/CHECK \(\w+ IN \([^)]*\)\)/g, ''));
  await client.execute("DELETE FROM settings");

  const columnas = {};
  const base = {};
  const idsNuevos = [];
  for (const [tabla, def] of Object.entries(TABLAS)) {
    const cols = await columnasDe(client, tabla);
    columnas[tabla] = cols;
    // Primera pasada: leer las filas y encontrar el id más alto del archivo
    let maxId = 0;
    const pendientes = [];
    for (const hoja of def.hojas) {
      const filas = datos[hoja];
      if (!filas.length) throw new Error(`La hoja "${hoja}" no tiene encabezados en la fila 1.`);
      const enc = filas[0].map((h) => String(h).trim());
      const faltan = cols.filter((c) => !enc.includes(c));
      if (faltan.length) throw new Error(`A la hoja "${hoja}" le faltan las columnas: ${faltan.join(', ')}.`);
      for (let i = 1; i < filas.length; i++) {
        const valores = {};
        enc.forEach((h, j) => { if (cols.includes(h)) { const v = deCelda(h, filas[i][j]); if (v !== undefined) valores[h] = v; } });
        if (!Object.keys(valores).length) continue; // fila vacía
        if (cols.includes('id') && Number(valores.id) > maxId) maxId = Number(valores.id);
        if (tabla === 'tasks') valores.personal = hoja === 'Pendientes' ? 1 : 0;
        pendientes.push({ hoja, fila: i + 1, valores, colId: enc.indexOf('id') });
      }
    }
    // Segunda pasada: insertar. Una fila agregada a mano sin id recibe uno nuevo, que se escribe en la hoja al guardar.
    for (const p of pendientes) {
      if (cols.includes('id') && p.valores.id === undefined) {
        p.valores.id = ++maxId;
        idsNuevos.push({ hoja: p.hoja, fila: p.fila, colId: p.colId, id: p.valores.id });
      }
      const nombres = Object.keys(p.valores);
      try {
        await client.execute({ sql: `INSERT INTO ${tabla} (${nombres.join(', ')}) VALUES (${nombres.map(() => '?').join(', ')})`, args: nombres.map((n) => p.valores[n]) });
      } catch (e) {
        console.warn(`Fila ${p.fila} de la hoja "${p.hoja}" ignorada: ${e.message}`);
      }
    }
    if (tabla === 'settings') {
      // Valores por defecto para las claves que no estén en la hoja
      for (const ins of esquema.match(/INSERT OR IGNORE INTO settings[^;]*;/g) || []) await client.execute(ins);
    }
    // Los nuevos id siguen al mayor del archivo, aunque alguna fila se haya ignorado
    if (cols.includes('id') && maxId > 0) {
      await client.execute({ sql: 'DELETE FROM sqlite_sequence WHERE name = ?', args: [tabla] });
      await client.execute({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', args: [tabla, maxId] });
    }
    base[tabla] = new Map((await todasLasFilas(client, tabla)).map((f) => [claveDe(def, f), f]));
  }
  return { client, base, columnas, idsNuevos };
}

// Escribe en el archivo solo lo que cambió durante la solicitud
async function guardar(api, ctx) {
  const porHoja = {}; // hoja -> { nuevas: [], cambiadas: [], borradas: [] }
  const de = (hoja) => (porHoja[hoja] ||= { nuevas: [], cambiadas: [], borradas: [] });
  for (const [tabla, def] of Object.entries(TABLAS)) {
    const antes = ctx.base[tabla];
    const despues = new Map((await todasLasFilas(ctx.client, tabla)).map((f) => [claveDe(def, f), f]));
    const hojaDe = (f) => (def.hojaDe ? def.hojaDe(f) : def.hojas[0]);
    for (const [k, f] of despues) {
      const previa = antes.get(k);
      if (!previa) de(hojaDe(f)).nuevas.push({ tabla, k, f });
      else if (JSON.stringify(previa) !== JSON.stringify(f)) de(hojaDe(f)).cambiadas.push({ tabla, k, f });
    }
    for (const [k, f] of antes) if (!despues.has(k)) de(hojaDe(f)).borradas.push({ tabla, k, f });
  }
  const hojas = Object.keys(porHoja).filter((h) => porHoja[h].cambiadas.length || porHoja[h].borradas.length || porHoja[h].nuevas.length);
  const hojasIds = [...new Set(ctx.idsNuevos.map((x) => x.hoja))];
  if (!hojas.length && !hojasIds.length) return;

  // Vuelve a leer las hojas afectadas para ubicar cada fila por su clave justo antes de escribir
  const actuales = await api.leer([...new Set([...hojas, ...hojasIds])]);
  const actualizaciones = [];
  const borrados = [];
  // Escribe el id asignado a las filas que se agregaron a mano sin id (si la fila sigue en su lugar y sin id)
  for (const x of ctx.idsNuevos) {
    const f = actuales[x.hoja][x.fila - 1];
    if (f && deCelda('id', f[x.colId]) === undefined && f.some((v) => v !== '' && v !== null && v !== undefined)) {
      actualizaciones.push({ range: `'${x.hoja.replace(/'/g, "''")}'!${letraColumna(x.colId)}${x.fila}`, values: [[x.id]] });
    }
  }
  for (const hoja of hojas) {
    const filas = actuales[hoja];
    const enc = filas[0].map((h) => String(h).trim());
    const { cambiadas, borradas, nuevas } = porHoja[hoja];
    const tabla = (cambiadas[0] || borradas[0] || nuevas[0]).tabla;
    const def = TABLAS[tabla];
    const posicion = new Map();
    for (let i = 1; i < filas.length; i++) {
      const f = {};
      enc.forEach((h, j) => { f[h] = deCelda(h, filas[i][j]); });
      if (f.id === undefined) { const x = ctx.idsNuevos.find((n) => n.hoja === hoja && n.fila === i + 1); if (x) f.id = x.id; }
      if (def.clave.every((c) => f[c] !== undefined)) posicion.set(claveDe(def, f), i + 1);
    }
    // Las columnas que no son de la app (si el usuario agregó alguna) no se tocan: null = no escribir
    const aFila = (f) => enc.map((h) => (h in f ? f[h] : null));
    for (const c of cambiadas) {
      const r = posicion.get(c.k);
      if (r) actualizaciones.push({ range: `'${hoja.replace(/'/g, "''")}'!A${r}`, values: [aFila(c.f)] });
      else nuevas.push(c); // la fila ya no está en la hoja: se vuelve a agregar
    }
    for (const b of borradas) {
      const r = posicion.get(b.k);
      if (r) borrados.push({ hoja, r });
    }
  }
  if (actualizaciones.length) await api.actualizar(actualizaciones);
  if (borrados.length) {
    const ids = await api.idsDeHojas();
    borrados.sort((a, b) => b.r - a.r); // de abajo hacia arriba para que no se recorran las posiciones
    await api.lote(borrados.map(({ hoja, r }) => ({
      deleteDimension: { range: { sheetId: ids[hoja], dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
    })));
  }
  for (const hoja of hojas) {
    const { nuevas } = porHoja[hoja];
    if (!nuevas.length) continue;
    const enc = actuales[hoja][0].map((h) => String(h).trim());
    await api.agregar(hoja, nuevas.map(({ f }) => enc.map((h) => (h in f ? f[h] : ''))));
  }
}

module.exports = { crearApi, cargar, guardar, TABLAS };
