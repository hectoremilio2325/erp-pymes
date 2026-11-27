// ERP de control interno para PyMES: aplicación web y API
const path = require('node:path');
const express = require('express');
const { db, setting } = require('./db');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
if (process.env.VERCEL || process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
  next();
});
app.use('/api', db.middleware());
app.use('/api', auth.loadUser);
app.use('/api', auth.exigirCambioPassword);

// ---------- utilidades ----------
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const txt = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fecha = (v) => (typeof v === 'string' && FECHA.test(v) ? v : '');
const uno = (v, opciones, def) => (opciones.includes(v) ? v : def);
const isAdmin = (req) => req.user && req.user.rol === 'admin';
const hoy = () => new Date().toISOString().slice(0, 10);
const masDias = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const USUARIO = /^[A-Za-z0-9._-]{3,40}$/;
const MSG_USUARIO = 'El usuario solo puede tener letras, números, punto, guion y guion bajo (3 a 40).';
const errorCliente = (msg) => Object.assign(new Error(msg), { status: 400 });

const logTask = (q, taskId, userId, accion, detalle = '') =>
  q.run('INSERT INTO task_history (task_id, user_id, accion, detalle) VALUES (?, ?, ?, ?)', taskId, userId, accion, detalle);

// ---------- configuración inicial y sesión ----------
const userCount = async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n;

app.get('/api/setup', async (_req, res) => res.json({ necesario: (await userCount()) === 0, empresa: await setting('nombre_empresa') }));

app.post('/api/setup', async (req, res) => {
  const { username, password, nombre, empresa } = req.body || {};
  if (!txt(username, 40) || !txt(nombre, 120)) return bad(res, 'Nombre y usuario son obligatorios.');
  if (!USUARIO.test(username)) return bad(res, MSG_USUARIO);
  const err = auth.validatePassword(password, username);
  if (err) return bad(res, err);
  const hash = await auth.hashPassword(password);
  // Solo crea el administrador si todavía no existe ningún usuario (evita carreras entre dos solicitudes)
  const r = await db.run(`INSERT INTO users (username, password_hash, nombre, rol, puesto)
    SELECT ?, ?, ?, 'admin', 'Administrador' WHERE NOT EXISTS (SELECT 1 FROM users)`, username.trim(), hash, txt(nombre, 120));
  if (!r.changes) return bad(res, 'La aplicación ya está configurada.', 409);
  if (txt(empresa, 120)) await db.run("UPDATE settings SET valor = ? WHERE clave = 'nombre_empresa'", txt(empresa, 120));
  const s = await auth.createSession(r.lastInsertRowid);
  auth.setSessionCookie(res, s.token, s.expira, req.secure);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const clave = `${req.ip}|${String(username).toLowerCase().slice(0, 40)}`;
  if (await auth.loginBloqueado(clave)) return bad(res, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.', 429);
  const u = await db.get('SELECT id, username, password_hash, activo, debe_cambiar_password FROM users WHERE username = ?', txt(username, 40));
  const r = u ? await auth.revisarPassword(password || '', u) : { ok: false };
  if (!r.ok) {
    await auth.loginFallido(clave);
    return bad(res, 'Usuario o contraseña incorrectos.', 401);
  }
  if (!u.activo) return bad(res, 'Tu cuenta está desactivada. Habla con el administrador.', 403);
  await auth.loginCorrecto(clave);
  if (r.provisional && !u.debe_cambiar_password) await db.run('UPDATE users SET debe_cambiar_password = 1 WHERE id = ?', u.id);
  const s = await auth.createSession(u.id);
  auth.setSessionCookie(res, s.token, s.expira, req.secure);
  res.json({ ok: true, debe_cambiar_password: r.provisional });
});

app.post('/api/logout', async (req, res) => {
  if (req.sessionToken) await db.run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, async (req, res) => {
  const u = await db.get(`SELECT id, username, nombre, rol, puesto, departamento, email, telefono, fecha_ingreso, cumpleanos,
    debe_cambiar_password FROM users WHERE id = ?`, req.user.id);
  res.json({ ...u, empresa: await setting('nombre_empresa') });
});

app.put('/api/me', auth.requireAuth, async (req, res) => {
  const b = req.body || {};
  await db.run('UPDATE users SET email = ?, telefono = ?, cumpleanos = ? WHERE id = ?',
    txt(b.email, 120), txt(b.telefono, 40), fecha(b.cumpleanos), req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/password', auth.requireAuth, async (req, res) => {
  const { actual, nueva } = req.body || {};
  const u = await db.get('SELECT username, password_hash, debe_cambiar_password FROM users WHERE id = ?', req.user.id);
  // Con contraseña provisional ya se comprobó al iniciar sesión; no se vuelve a pedir
  if (!u.debe_cambiar_password && !(await auth.revisarPassword(actual || '', u)).ok) return bad(res, 'La contraseña actual no es correcta.');
  const err = auth.validatePassword(nueva, u.username);
  if (err) return bad(res, err);
  await db.run('UPDATE users SET password_hash = ?, debe_cambiar_password = 0 WHERE id = ?', await auth.hashPassword(nueva), req.user.id);
  // Cierra las demás sesiones del usuario
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// ---------- usuarios / directorio ----------
// El directorio de colaboradores solo lo ve el administrador
app.get('/api/users', auth.requireAdmin, async (_req, res) => {
  res.json(await db.all(`SELECT id, username, nombre, rol, puesto, departamento, email, telefono, fecha_ingreso, cumpleanos, activo
    FROM users ORDER BY activo DESC, nombre`));
});

function userFields(b) {
  return {
    nombre: txt(b.nombre, 120), rol: uno(b.rol, ['admin', 'empleado'], 'empleado'),
    puesto: txt(b.puesto, 120), departamento: txt(b.departamento, 120), email: txt(b.email, 120),
    telefono: txt(b.telefono, 40), fecha_ingreso: fecha(b.fecha_ingreso), cumpleanos: fecha(b.cumpleanos),
  };
}

app.post('/api/users', auth.requireAdmin, async (req, res) => {
  const b = req.body || {};
  const f = userFields(b);
  if (!f.nombre) return bad(res, 'El nombre es obligatorio.');
  if (!USUARIO.test(b.username || '')) return bad(res, MSG_USUARIO);
  if (await db.get('SELECT 1 FROM users WHERE username = ?', b.username)) return bad(res, 'Ese nombre de usuario ya existe.', 409);
  // La contraseña provisional es el mismo nombre de usuario; se pide cambiarla en el primer inicio de sesión
  const r = await db.run(`INSERT INTO users (username, password_hash, nombre, rol, puesto, departamento, email, telefono, fecha_ingreso, cumpleanos, debe_cambiar_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, b.username, await auth.hashPassword(b.username), f.nombre, f.rol, f.puesto,
  f.departamento, f.email, f.telefono, f.fecha_ingreso, f.cumpleanos);
  res.json({ id: r.lastInsertRowid });
});

const activeAdmins = async (exceptId) =>
  (await db.get("SELECT COUNT(*) AS n FROM users WHERE rol = 'admin' AND activo = 1 AND id <> ?", exceptId)).n;

app.put('/api/users/:id', auth.requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!cur) return bad(res, 'Usuario no encontrado.', 404);
  const b = req.body || {};
  const f = userFields(b);
  if (!f.nombre) return bad(res, 'El nombre es obligatorio.');
  const activo = b.activo === false || b.activo === 0 ? 0 : 1;
  if (cur.rol === 'admin' && (f.rol !== 'admin' || !activo) && (await activeAdmins(id)) === 0)
    return bad(res, 'Debe quedar al menos un administrador activo.');
  await db.run(`UPDATE users SET nombre = ?, rol = ?, puesto = ?, departamento = ?, email = ?, telefono = ?,
    fecha_ingreso = ?, cumpleanos = ?, activo = ? WHERE id = ?`, f.nombre, f.rol, f.puesto, f.departamento,
  f.email, f.telefono, f.fecha_ingreso, f.cumpleanos, activo, id);
  if (!activo) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
});

app.post('/api/users/:id/password', auth.requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT username FROM users WHERE id = ?', id);
  if (!u) return bad(res, 'Usuario no encontrado.', 404);
  // Restablecer = volver a la contraseña provisional (el nombre de usuario), que debe cambiar al entrar
  await db.run('UPDATE users SET password_hash = ?, debe_cambiar_password = 1 WHERE id = ?', await auth.hashPassword(u.username), id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
});

// ---------- configuración de la empresa ----------
app.get('/api/settings', auth.requireAdmin, async (_req, res) => {
  res.json(Object.fromEntries((await db.all('SELECT clave, valor FROM settings')).map((r) => [r.clave, r.valor])));
});
app.put('/api/settings', auth.requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (txt(b.nombre_empresa, 120)) await db.run("UPDATE settings SET valor = ? WHERE clave = 'nombre_empresa'", txt(b.nombre_empresa, 120));
  if (b.admin_ve_pendientes_personales !== undefined)
    await db.run("UPDATE settings SET valor = ? WHERE clave = 'admin_ve_pendientes_personales'", b.admin_ve_pendientes_personales ? '1' : '0');
  res.json({ ok: true });
});

// ---------- tareas y pendientes ----------
// Reglas de visibilidad (según el documento del proyecto):
// - Tarea asignada: la ven sus responsables, quien la creó y el administrador.
// - Pendiente personal: solo su dueño; el administrador solo si la empresa lo habilita en Configuración.
async function visibleTaskWhere(req) {
  if (isAdmin(req)) {
    return (await setting('admin_ve_pendientes_personales')) === '1' ? { sql: '1=1', params: [] }
      : { sql: '(t.personal = 0 OR t.creado_por = ?)', params: [req.user.id] };
  }
  return {
    sql: '(t.creado_por = ? OR (t.personal = 0 AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)))',
    params: [req.user.id, req.user.id],
  };
}

async function loadTask(req, id) {
  const w = await visibleTaskWhere(req);
  const t = await db.get(`SELECT t.*, u.nombre AS creado_por_nombre FROM tasks t JOIN users u ON u.id = t.creado_por
    WHERE t.id = ? AND ${w.sql}`, id, ...w.params);
  if (!t) return null;
  t.responsables = await db.all(`SELECT u.id, u.nombre FROM task_assignees a JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? ORDER BY u.nombre`, id);
  return t;
}

app.get('/api/tasks', auth.requireAuth, async (req, res) => {
  const w = await visibleTaskWhere(req);
  const cond = [w.sql];
  const params = [...w.params];
  const q = req.query;
  if (q.tipo === 'personal') cond.push('t.personal = 1');
  if (q.tipo === 'asignada') cond.push('t.personal = 0');
  if (['pendiente', 'en_progreso', 'completada'].includes(q.estado)) { cond.push('t.estado = ?'); params.push(q.estado); }
  if (q.estado === 'abiertas') cond.push("t.estado <> 'completada'");
  if (q.responsable && isAdmin(req)) {
    cond.push('EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)');
    params.push(Number(q.responsable));
  }
  const lista = await db.all(`SELECT t.*, u.nombre AS creado_por_nombre,
      (SELECT group_concat(us.nombre, ', ') FROM task_assignees a JOIN users us ON us.id = a.user_id WHERE a.task_id = t.id) AS responsables,
      (SELECT COALESCE(SUM(CAST(h.horas AS INTEGER) * 60 + ROUND((h.horas - CAST(h.horas AS INTEGER)) * 100)), 0)
        FROM time_logs h WHERE h.task_id = t.id) AS minutos_total
    FROM tasks t JOIN users u ON u.id = t.creado_por
    WHERE ${cond.join(' AND ')}
    ORDER BY (t.estado = 'completada'), CASE WHEN t.fecha_limite = '' THEN 1 ELSE 0 END, t.fecha_limite,
      CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, t.id DESC`, ...params);
  for (const t of lista) { t.horas_total = deMinutos(Number(t.minutos_total)); delete t.minutos_total; }
  res.json(lista);
});

app.get('/api/tasks/:id', auth.requireAuth, async (req, res) => {
  const t = await loadTask(req, Number(req.params.id));
  if (!t) return bad(res, 'Tarea no encontrada.', 404);
  t.historial = await db.all(`SELECT h.accion, h.detalle, h.creado_en, u.nombre FROM task_history h JOIN users u ON u.id = h.user_id
    WHERE h.task_id = ? ORDER BY h.id DESC`, t.id);
  t.horas = await db.all(`SELECT h.id, h.user_id, h.fecha, h.horas, h.nota, u.nombre FROM time_logs h JOIN users u ON u.id = h.user_id
    WHERE h.task_id = ? ORDER BY h.fecha DESC, h.id DESC`, t.id);
  t.horas_total = deMinutos(t.horas.reduce((s, h) => s + aMinutos(h.horas), 0));
  res.json(t);
});

async function validAssignees(ids) {
  if (!Array.isArray(ids)) return [];
  const uniq = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 200);
  const out = [];
  for (const id of uniq) if (await db.get('SELECT 1 FROM users WHERE id = ? AND activo = 1', id)) out.push(id);
  return out;
}

app.post('/api/tasks', auth.requireAuth, async (req, res) => {
  const b = req.body || {};
  const titulo = txt(b.titulo, 200);
  if (!titulo) return bad(res, 'El título es obligatorio.');
  // Solo el administrador asigna tareas; un empleado crea pendientes personales.
  const personal = isAdmin(req) ? (b.personal ? 1 : 0) : 1;
  const responsables = personal ? [req.user.id] : await validAssignees(b.responsables);
  if (!personal && responsables.length === 0) return bad(res, 'Elige al menos un responsable.');
  const id = await db.transaccion(async (q) => {
    const r = await q.run(`INSERT INTO tasks (titulo, descripcion, prioridad, fecha_limite, personal, creado_por)
      VALUES (?, ?, ?, ?, ?, ?)`, titulo, txt(b.descripcion), uno(b.prioridad, ['baja', 'media', 'alta'], 'media'),
    fecha(b.fecha_limite), personal, req.user.id);
    const tid = r.lastInsertRowid;
    for (const u of responsables) await q.run('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)', tid, u);
    await logTask(q, tid, req.user.id, 'creada', personal ? 'Pendiente personal' : `Asignada a ${responsables.length} persona(s)`);
    return tid;
  });
  res.json({ id });
});

const ESTADOS = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada' };

app.put('/api/tasks/:id', auth.requireAuth, async (req, res) => {
  const t = await loadTask(req, Number(req.params.id));
  if (!t) return bad(res, 'Tarea no encontrada.', 404);
  const b = req.body || {};
  const esDueno = t.creado_por === req.user.id;
  const puedeEditarTodo = t.personal ? esDueno : isAdmin(req);
  const esResponsable = t.responsables.some((r) => r.id === req.user.id);
  if (!puedeEditarTodo && !esResponsable) return bad(res, 'No tienes permiso para modificar esta tarea.', 403);
  const nuevos = puedeEditarTodo && !t.personal && Array.isArray(b.responsables) ? await validAssignees(b.responsables) : null;
  if (nuevos && nuevos.length === 0) return bad(res, 'Elige al menos un responsable.');

  await db.transaccion(async (q) => {
    if (b.estado && ESTADOS[b.estado] && b.estado !== t.estado) {
      await q.run("UPDATE tasks SET estado = ?, actualizado_en = datetime('now') WHERE id = ?", b.estado, t.id);
      await logTask(q, t.id, req.user.id, 'estado', `${ESTADOS[t.estado]} → ${ESTADOS[b.estado]}`);
    }
    if (puedeEditarTodo && b.titulo !== undefined) {
      const titulo = txt(b.titulo, 200) || t.titulo;
      const prioridad = uno(b.prioridad, ['baja', 'media', 'alta'], t.prioridad);
      const fl = b.fecha_limite === '' ? '' : fecha(b.fecha_limite) || t.fecha_limite;
      const cambios = [];
      if (titulo !== t.titulo) cambios.push('título');
      if (txt(b.descripcion) !== t.descripcion) cambios.push('descripción');
      if (prioridad !== t.prioridad) cambios.push(`prioridad a ${prioridad}`);
      if (fl !== t.fecha_limite) cambios.push(`fecha límite a ${fl || 'sin fecha'}`);
      await q.run(`UPDATE tasks SET titulo = ?, descripcion = ?, prioridad = ?, fecha_limite = ?, actualizado_en = datetime('now')
        WHERE id = ?`, titulo, txt(b.descripcion), prioridad, fl, t.id);
      if (nuevos) {
        const antes = t.responsables.map((r) => r.id).sort().join(',');
        if (antes !== [...nuevos].sort().join(',')) {
          await q.run('DELETE FROM task_assignees WHERE task_id = ?', t.id);
          for (const u of nuevos) await q.run('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)', t.id, u);
          cambios.push('responsables');
        }
      }
      if (cambios.length) await logTask(q, t.id, req.user.id, 'editada', `Cambió ${cambios.join(', ')}`);
    }
    if (txt(b.comentario, 1000)) await logTask(q, t.id, req.user.id, 'comentario', txt(b.comentario, 1000));
  });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth.requireAuth, async (req, res) => {
  const t = await loadTask(req, Number(req.params.id));
  if (!t) return bad(res, 'Tarea no encontrada.', 404);
  const puede = t.personal ? t.creado_por === req.user.id : isAdmin(req);
  if (!puede) return bad(res, 'No tienes permiso para eliminar esta tarea.', 403);
  // Se borran explícitamente los registros dependientes (la base remota puede no aplicar ON DELETE CASCADE)
  await db.transaccion(async (q) => {
    await q.run('DELETE FROM task_history WHERE task_id = ?', t.id);
    await q.run('DELETE FROM time_logs WHERE task_id = ?', t.id);
    await q.run('DELETE FROM task_assignees WHERE task_id = ?', t.id);
    await q.run('DELETE FROM tasks WHERE id = ?', t.id);
  });
  res.json({ ok: true });
});

// ---------- registro de horas (bitácora) ----------
// El tiempo se escribe como horas.minutos: 1.30 = 1 hora 30 minutos; 0.01 = 1 minuto; máximo 99.59.
// Las sumas se hacen en minutos para que 0.30 + 0.30 = 1.00.
const aMinutos = (v) => { const n = Number(v) || 0; const h = Math.floor(n); return h * 60 + Math.round((n - h) * 100); };
const deMinutos = (m) => Math.floor(m / 60) + (m % 60) / 100;
function leerHoras(v) {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(String(v ?? '').trim().replace(',', '.'));
  if (!m) return null;
  const horas = Number(m[1]);
  const minutos = m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'));
  if (minutos > 59 || horas * 60 + minutos === 0) return null;
  return horas + minutos / 100;
}
// Quien puede avanzar una tarea (responsable, dueño del pendiente o administrador) registra sus propias horas.
const lunesDe = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };

app.post('/api/tasks/:id/horas', auth.requireAuth, async (req, res) => {
  const t = await loadTask(req, Number(req.params.id));
  if (!t) return bad(res, 'Tarea no encontrada.', 404);
  const puede = (t.personal ? t.creado_por === req.user.id : isAdmin(req)) || t.responsables.some((r) => r.id === req.user.id);
  if (!puede) return bad(res, 'Solo los responsables pueden registrar horas en esta tarea.', 403);
  const b = req.body || {};
  const horas = leerHoras(b.horas);
  if (horas === null) return bad(res, 'Escribe el tiempo como horas.minutos: de 0.01 (1 minuto) a 99.59. Los minutos van de .00 a .59 (por ejemplo 1.30 = 1 hora 30 minutos).');
  const f = fecha(b.fecha) || hoy();
  if (f > masDias(hoy(), 1)) return bad(res, 'No puedes registrar horas en una fecha futura.');
  const id = await db.transaccion(async (q) => {
    const r = await q.run('INSERT INTO time_logs (task_id, user_id, fecha, horas, nota) VALUES (?, ?, ?, ?, ?)', t.id, req.user.id, f, horas, txt(b.nota, 300));
    await logTask(q, t.id, req.user.id, 'horas', `Registró ${horas.toFixed(2)} h el ${f}${txt(b.nota, 300) ? ': ' + txt(b.nota, 300) : ''}`);
    return r.lastInsertRowid;
  });
  res.json({ id });
});

app.delete('/api/horas/:id', auth.requireAuth, async (req, res) => {
  const h = await db.get('SELECT * FROM time_logs WHERE id = ?', Number(req.params.id));
  if (!h || !(await loadTask(req, h.task_id))) return bad(res, 'Registro no encontrado.', 404);
  if (h.user_id !== req.user.id && !isAdmin(req)) return bad(res, 'Solo puedes borrar tus propios registros.', 403);
  await db.transaccion(async (q) => {
    await q.run('DELETE FROM time_logs WHERE id = ?', h.id);
    await logTask(q, h.task_id, req.user.id, 'horas', `Borró un registro de ${Number(h.horas).toFixed(2)} h del ${h.fecha}`);
  });
  res.json({ ok: true });
});

// Bitácora: cada empleado ve sus horas; el administrador ve las de todos (o de una persona)
app.get('/api/bitacora', auth.requireAuth, async (req, res) => {
  const hasta = fecha(req.query.hasta) || hoy();
  const desde = fecha(req.query.desde) || masDias(lunesDe(hasta), -7 * 7);
  const w = await visibleTaskWhere(req);
  const cond = [w.sql, 'h.fecha >= ?', 'h.fecha <= ?'];
  const params = [...w.params, desde, hasta];
  if (!isAdmin(req)) { cond.push('h.user_id = ?'); params.push(req.user.id); }
  else if (req.query.usuario) { cond.push('h.user_id = ?'); params.push(Number(req.query.usuario)); }
  const entradas = await db.all(`SELECT h.id, h.task_id, h.user_id, h.fecha, h.horas, h.nota, u.nombre, t.titulo, t.personal
    FROM time_logs h JOIN tasks t ON t.id = h.task_id JOIN users u ON u.id = h.user_id
    WHERE ${cond.join(' AND ')} ORDER BY h.fecha DESC, h.id DESC`, ...params);
  const semanas = new Map();
  const personas = new Map();
  for (const e of entradas) {
    const s = lunesDe(e.fecha);
    const m = aMinutos(e.horas);
    semanas.set(s, (semanas.get(s) || 0) + m);
    const p = personas.get(e.user_id) || { id: e.user_id, nombre: e.nombre, minutos: 0 };
    p.minutos += m;
    personas.set(e.user_id, p);
  }
  const semanaActual = lunesDe(hoy());
  const total = entradas.reduce((s, e) => s + aMinutos(e.horas), 0);
  res.json({
    desde, hasta,
    total: deMinutos(total),
    esta_semana: deMinutos(semanas.get(semanaActual) || 0),
    promedio_semana: deMinutos(semanas.size ? Math.round(total / semanas.size) : 0),
    por_semana: [...semanas].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([inicio, m]) => ({ inicio, fin: masDias(inicio, 6), horas: deMinutos(m), minutos: m })),
    por_persona: [...personas.values()].sort((a, b) => b.minutos - a.minutos).map((p) => ({ id: p.id, nombre: p.nombre, horas: deMinutos(p.minutos) })),
    entradas,
  });
});

// ---------- reportes ----------
// El administrador obtiene el reporte general (todo el equipo) o el de una persona; el empleado, solo el suyo.
// Las tareas que se cuentan son las asignadas; los pendientes personales son privados y no entran al reporte.
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;

app.get('/api/reportes', auth.requireAuth, async (req, res) => {
  const hasta = fecha(req.query.hasta) || hoy();
  const desde = fecha(req.query.desde) || hoy().slice(0, 8) + '01';
  if (desde > hasta) return bad(res, 'La fecha inicial debe ser anterior a la final.');
  const hoyD = hoy();
  let personas;
  if (!isAdmin(req)) personas = await db.all('SELECT id, nombre, puesto, departamento FROM users WHERE id = ?', req.user.id);
  else if (req.query.usuario) personas = await db.all('SELECT id, nombre, puesto, departamento FROM users WHERE id = ?', Number(req.query.usuario));
  else personas = await db.all('SELECT id, nombre, puesto, departamento FROM users WHERE activo = 1 ORDER BY nombre');
  if (!personas.length) return bad(res, 'Persona no encontrada.', 404);
  const ids = personas.map((p) => p.id);
  const marcas = ids.map(() => '?').join(', ');

  // Tareas asignadas a estas personas, con la fecha en que se completaron (según su historial)
  const tareas = await db.all(`SELECT t.id, t.titulo, t.prioridad, t.fecha_limite, t.estado, a.user_id,
      (SELECT substr(MAX(h.creado_en), 1, 10) FROM task_history h WHERE h.task_id = t.id AND h.accion = 'estado' AND h.detalle LIKE '%→ Completada') AS completada_en
    FROM tasks t JOIN task_assignees a ON a.task_id = t.id
    WHERE t.personal = 0 AND a.user_id IN (${marcas})`, ...ids);
  const completadas = tareas.filter((t) => t.estado === 'completada' && t.completada_en && t.completada_en >= desde && t.completada_en <= hasta)
    .map((t) => ({ ...t, a_tiempo: !t.fecha_limite || t.completada_en <= t.fecha_limite ? 1 : 0 }));
  const abiertas = tareas.filter((t) => t.estado !== 'completada')
    .map((t) => ({ ...t, vencida: t.fecha_limite && t.fecha_limite < hoyD ? 1 : 0 }));

  // Horas del periodo (de lo que quien consulta puede ver)
  const w = await visibleTaskWhere(req);
  const horas = await db.all(`SELECT h.user_id, h.fecha, h.horas, h.nota, t.titulo, t.personal FROM time_logs h JOIN tasks t ON t.id = h.task_id
    WHERE ${w.sql} AND h.user_id IN (${marcas}) AND h.fecha >= ? AND h.fecha <= ? ORDER BY h.fecha, h.id`, ...w.params, ...ids, desde, hasta);

  // Incidencias aprobadas que caen en el periodo (los días se recortan al periodo)
  const incidencias = (await db.all(`SELECT i.user_id, i.tipo, i.fecha_inicio, CASE WHEN i.fecha_fin = '' OR i.fecha_fin IS NULL THEN i.fecha_inicio ELSE i.fecha_fin END AS fecha_fin, i.motivo
    FROM incidents i WHERE i.estado = 'aprobada' AND i.user_id IN (${marcas})`, ...ids))
    .filter((i) => i.fecha_inicio <= hasta && i.fecha_fin >= desde)
    .map((i) => ({ ...i, dias: diasEntre(i.fecha_inicio < desde ? desde : i.fecha_inicio, i.fecha_fin > hasta ? hasta : i.fecha_fin) }))
    .sort((a, b) => (a.fecha_inicio < b.fecha_inicio ? -1 : 1));

  const nombre = Object.fromEntries(personas.map((p) => [p.id, p.nombre]));
  const resumen = personas.map((p) => {
    const c = completadas.filter((t) => t.user_id === p.id);
    const ab = abiertas.filter((t) => t.user_id === p.id);
    const inc = incidencias.filter((i) => i.user_id === p.id);
    const diasTipo = (tipo) => inc.filter((i) => i.tipo === tipo).reduce((s, i) => s + i.dias, 0);
    return {
      id: p.id, nombre: p.nombre, puesto: p.puesto || '', departamento: p.departamento || '',
      completadas: c.length, a_tiempo: c.filter((t) => t.a_tiempo).length,
      cumplimiento: c.length ? Math.round((c.filter((t) => t.a_tiempo).length / c.length) * 100) : null,
      abiertas: ab.length, vencidas: ab.filter((t) => t.vencida).length,
      horas: deMinutos(horas.filter((h) => h.user_id === p.id).reduce((s, h) => s + aMinutos(h.horas), 0)),
      home_office: diasTipo('home_office'), permisos: diasTipo('permiso'), ausencias: diasTipo('ausencia'),
      vacaciones: diasTipo('vacaciones'), retardos: inc.filter((i) => i.tipo === 'retardo').length,
    };
  });
  const suma = (k) => resumen.reduce((s, r) => s + r[k], 0);
  // Una tarea con varios responsables aparece una sola vez en las listas y en los totales
  const unicas = (lista) => {
    const m = new Map();
    for (const t of lista) {
      const x = m.get(t.id);
      if (x) x.nombre += ', ' + nombre[t.user_id];
      else { const { user_id: _u, ...resto } = t; m.set(t.id, { ...resto, nombre: nombre[t.user_id] }); }
    }
    return [...m.values()];
  };
  const listaCompletadas = unicas(completadas).sort((a, b) => (a.completada_en < b.completada_en ? -1 : 1));
  const listaAbiertas = unicas(abiertas).sort((a, b) => ((a.fecha_limite || '9999') < (b.fecha_limite || '9999') ? -1 : 1));
  const totalCompletadas = listaCompletadas.length;
  const totalATiempo = listaCompletadas.filter((t) => t.a_tiempo).length;
  res.json({
    desde, hasta, generado: new Date().toISOString(), empresa: await setting('nombre_empresa'),
    alcance: personas.length === 1 && (!isAdmin(req) || req.query.usuario) ? 'individual' : 'general',
    totales: {
      completadas: totalCompletadas, a_tiempo: totalATiempo,
      cumplimiento: totalCompletadas ? Math.round((totalATiempo / totalCompletadas) * 100) : null,
      abiertas: listaAbiertas.length, vencidas: listaAbiertas.filter((t) => t.vencida).length,
      horas: deMinutos(horas.reduce((s, h) => s + aMinutos(h.horas), 0)),
      dias_incidencia: incidencias.filter((i) => i.tipo !== 'retardo').reduce((s, i) => s + i.dias, 0),
      retardos: incidencias.filter((i) => i.tipo === 'retardo').length,
    },
    resumen,
    completadas: listaCompletadas,
    abiertas: listaAbiertas,
    horas: horas.map((h) => ({ ...h, nombre: nombre[h.user_id] })),
    incidencias: incidencias.map((i) => ({ ...i, nombre: nombre[i.user_id] })),
  });
});

// ---------- calendario ----------
const TIPOS_INC = { home_office: 'Home Office', permiso: 'Permiso', ausencia: 'Ausencia', vacaciones: 'Vacaciones', retardo: 'Retardo', otra: 'Otra incidencia' };

app.get('/api/events', auth.requireAuth, async (req, res) => {
  const desde = fecha(req.query.desde) || masDias(hoy(), -31);
  const hasta = fecha(req.query.hasta) || masDias(hoy(), 62);
  const items = [];

  // Eventos: generales (todos) o personales del usuario
  (await db.all(`SELECT e.* FROM events e
    WHERE (e.general = 1 OR e.creado_por = ?) AND e.fecha_inicio <= ? AND (CASE WHEN e.fecha_fin = '' THEN e.fecha_inicio ELSE e.fecha_fin END) >= ?
    ORDER BY e.fecha_inicio, e.hora`, req.user.id, hasta, desde)).forEach((e) => items.push({
    origen: 'evento', id: e.id, titulo: e.titulo, tipo: e.tipo, inicio: e.fecha_inicio, fin: e.fecha_fin || e.fecha_inicio,
    hora: e.hora, descripcion: e.descripcion, general: e.general, editable: isAdmin(req) || e.creado_por === req.user.id,
  }));

  // Fechas límite de tareas visibles para el usuario
  const w = await visibleTaskWhere(req);
  (await db.all(`SELECT t.id, t.titulo, t.fecha_limite, t.estado, t.prioridad FROM tasks t
    WHERE ${w.sql} AND t.fecha_limite <> '' AND t.fecha_limite BETWEEN ? AND ?`, ...w.params, desde, hasta))
    .forEach((t) => items.push({ origen: 'tarea', id: t.id, titulo: t.titulo, tipo: 'tarea', inicio: t.fecha_limite, fin: t.fecha_limite, estado: t.estado, prioridad: t.prioridad }));

  // Cumpleaños del personal activo
  const anios = [];
  for (let y = Number(desde.slice(0, 4)); y <= Number(hasta.slice(0, 4)); y++) anios.push(y);
  (await db.all("SELECT id, nombre, cumpleanos FROM users WHERE activo = 1 AND cumpleanos <> ''")).forEach((u) => {
    anios.forEach((y) => {
      const d = `${y}${u.cumpleanos.slice(4)}`;
      if (d >= desde && d <= hasta) items.push({ origen: 'cumpleanos', id: u.id, titulo: `Cumpleaños de ${u.nombre}`, tipo: 'cumpleanos', inicio: d, fin: d });
    });
  });

  // Incidencias aprobadas: vacaciones visibles para todos; las demás solo para el interesado y el administrador
  (await db.all(`SELECT i.*, u.nombre FROM incidents i JOIN users u ON u.id = i.user_id
    WHERE i.estado = 'aprobada' AND i.fecha_inicio <= ? AND (CASE WHEN i.fecha_fin = '' THEN i.fecha_inicio ELSE i.fecha_fin END) >= ?
      AND (i.tipo = 'vacaciones' OR i.user_id = ? OR ? = 1)`, hasta, desde, req.user.id, isAdmin(req) ? 1 : 0))
    .forEach((i) => items.push({ origen: 'incidencia', id: i.id, titulo: `${TIPOS_INC[i.tipo]}: ${i.nombre}`, tipo: i.tipo === 'vacaciones' ? 'vacaciones' : 'incidencia', inicio: i.fecha_inicio, fin: i.fecha_fin || i.fecha_inicio }));

  res.json(items);
});

function eventFields(req, b) {
  return {
    titulo: txt(b.titulo, 200), descripcion: txt(b.descripcion),
    tipo: uno(b.tipo, ['actividad', 'reunion', 'entrega', 'festivo', 'vacaciones', 'otro'], 'actividad'),
    fecha_inicio: fecha(b.fecha_inicio), fecha_fin: fecha(b.fecha_fin), hora: HORA.test(b.hora || '') ? b.hora : '',
    // Solo el administrador publica eventos generales; los de un empleado son personales
    general: isAdmin(req) ? (b.general === false || b.general === 0 ? 0 : 1) : 0,
  };
}

function validarEvento(f) {
  if (!f.titulo || !f.fecha_inicio) throw errorCliente('Título y fecha son obligatorios.');
  if (f.fecha_fin && f.fecha_fin < f.fecha_inicio) throw errorCliente('La fecha final no puede ser anterior a la inicial.');
}

app.post('/api/events', auth.requireAuth, async (req, res) => {
  const f = eventFields(req, req.body || {});
  validarEvento(f);
  const r = await db.run(`INSERT INTO events (titulo, descripcion, tipo, fecha_inicio, fecha_fin, hora, general, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, f.titulo, f.descripcion, f.tipo, f.fecha_inicio, f.fecha_fin, f.hora, f.general, req.user.id);
  res.json({ id: r.lastInsertRowid });
});

async function ownEvent(req) {
  const e = await db.get('SELECT * FROM events WHERE id = ?', Number(req.params.id));
  if (!e || (!isAdmin(req) && e.creado_por !== req.user.id)) throw Object.assign(new Error('Evento no encontrado.'), { status: 404 });
  return e;
}

app.put('/api/events/:id', auth.requireAuth, async (req, res) => {
  const e = await ownEvent(req);
  const f = eventFields(req, req.body || {});
  validarEvento(f);
  await db.run('UPDATE events SET titulo = ?, descripcion = ?, tipo = ?, fecha_inicio = ?, fecha_fin = ?, hora = ?, general = ? WHERE id = ?',
    f.titulo, f.descripcion, f.tipo, f.fecha_inicio, f.fecha_fin, f.hora, f.general, e.id);
  res.json({ ok: true });
});

app.delete('/api/events/:id', auth.requireAuth, async (req, res) => {
  const e = await ownEvent(req);
  await db.run('DELETE FROM events WHERE id = ?', e.id);
  res.json({ ok: true });
});

// ---------- incidencias ----------
app.get('/api/incidents', auth.requireAuth, async (req, res) => {
  const cond = [];
  const params = [];
  if (!isAdmin(req) || req.query.mias === '1') { cond.push('i.user_id = ?'); params.push(req.user.id); }
  if (['pendiente', 'aprobada', 'rechazada', 'cancelada'].includes(req.query.estado)) { cond.push('i.estado = ?'); params.push(req.query.estado); }
  res.json(await db.all(`SELECT i.*, u.nombre, r.nombre AS revisado_por_nombre FROM incidents i
    JOIN users u ON u.id = i.user_id LEFT JOIN users r ON r.id = i.revisado_por
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY (i.estado = 'pendiente') DESC, i.creado_en DESC, i.id DESC`, ...params));
});

app.post('/api/incidents', auth.requireAuth, async (req, res) => {
  const b = req.body || {};
  const tipo = uno(b.tipo, Object.keys(TIPOS_INC), null);
  const fi = fecha(b.fecha_inicio);
  const ff = fecha(b.fecha_fin);
  if (!tipo || !fi) return bad(res, 'Tipo y fecha son obligatorios.');
  if (ff && ff < fi) return bad(res, 'La fecha final no puede ser anterior a la inicial.');
  const r = await db.run('INSERT INTO incidents (user_id, tipo, fecha_inicio, fecha_fin, motivo) VALUES (?, ?, ?, ?, ?)',
    req.user.id, tipo, fi, ff, txt(b.motivo));
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/incidents/:id/revisar', auth.requireAdmin, async (req, res) => {
  const estado = uno((req.body || {}).estado, ['aprobada', 'rechazada'], null);
  if (!estado) return bad(res, 'Indica si se aprueba o se rechaza.');
  const id = Number(req.params.id);
  const r = await db.run(`UPDATE incidents SET estado = ?, revisado_por = ?, comentario_revision = ?, revisado_en = datetime('now')
    WHERE id = ? AND estado = 'pendiente'`, estado, req.user.id, txt(req.body.comentario, 1000), id);
  if (!r.changes) {
    return (await db.get('SELECT 1 FROM incidents WHERE id = ?', id))
      ? bad(res, 'Esta solicitud ya fue revisada.', 409) : bad(res, 'Solicitud no encontrada.', 404);
  }
  res.json({ ok: true });
});

app.post('/api/incidents/:id/cancelar', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.run("UPDATE incidents SET estado = 'cancelada' WHERE id = ? AND user_id = ? AND estado = 'pendiente'", id, req.user.id);
  if (!r.changes) {
    return (await db.get('SELECT 1 FROM incidents WHERE id = ? AND user_id = ?', id, req.user.id))
      ? bad(res, 'Solo puedes cancelar solicitudes pendientes.', 409) : bad(res, 'Solicitud no encontrada.', 404);
  }
  res.json({ ok: true });
});

// ---------- panel principal ----------
app.get('/api/dashboard', auth.requireAuth, async (req, res) => {
  const d = hoy();
  const semana = masDias(d, 7);
  // En el panel cada quien ve sus propias tareas (asignadas o personales); el administrador además ve el resumen del equipo
  const mias = '((t.creado_por = ? AND t.personal = 1) OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?))';
  const p = [req.user.id, req.user.id];
  const cnt = async (extra, ...ps) => (await db.get(`SELECT COUNT(*) AS n FROM tasks t WHERE ${mias} AND ${extra}`, ...p, ...ps)).n;
  const out = {
    tareas_abiertas: await cnt("t.estado <> 'completada'"),
    vencidas: await cnt("t.estado <> 'completada' AND t.fecha_limite <> '' AND t.fecha_limite < ?", d),
    por_vencer: await db.all(`SELECT t.id, t.titulo, t.fecha_limite, t.prioridad, t.estado, t.personal FROM tasks t
      WHERE ${mias} AND t.estado <> 'completada' AND t.fecha_limite <> '' AND t.fecha_limite <= ?
      ORDER BY t.fecha_limite LIMIT 10`, ...p, semana),
    mis_incidencias_pendientes: (await db.get("SELECT COUNT(*) AS n FROM incidents WHERE user_id = ? AND estado = 'pendiente'", req.user.id)).n,
    proximos_eventos: await db.all(`SELECT id, titulo, tipo, fecha_inicio, hora FROM events
      WHERE (general = 1 OR creado_por = ?) AND fecha_inicio BETWEEN ? AND ? ORDER BY fecha_inicio, hora LIMIT 8`, req.user.id, d, masDias(d, 14)),
  };
  if (isAdmin(req)) {
    const n = async (sql, ...a) => (await db.get(sql, ...a)).n;
    out.equipo = {
      solicitudes_por_revisar: await n("SELECT COUNT(*) AS n FROM incidents WHERE estado = 'pendiente'"),
      tareas_abiertas: await n("SELECT COUNT(*) AS n FROM tasks WHERE personal = 0 AND estado <> 'completada'"),
      tareas_vencidas: await n("SELECT COUNT(*) AS n FROM tasks WHERE personal = 0 AND estado <> 'completada' AND fecha_limite <> '' AND fecha_limite < ?", d),
      empleados_activos: await n('SELECT COUNT(*) AS n FROM users WHERE activo = 1'),
      por_persona: await db.all(`SELECT u.id, u.nombre,
          SUM(CASE WHEN t.estado <> 'completada' THEN 1 ELSE 0 END) AS abiertas,
          SUM(CASE WHEN t.estado = 'completada' THEN 1 ELSE 0 END) AS completadas,
          SUM(CASE WHEN t.estado <> 'completada' AND t.fecha_limite <> '' AND t.fecha_limite < ? THEN 1 ELSE 0 END) AS vencidas
        FROM users u LEFT JOIN task_assignees a ON a.user_id = u.id LEFT JOIN tasks t ON t.id = a.task_id AND t.personal = 0
        WHERE u.activo = 1 GROUP BY u.id ORDER BY u.nombre`, d),
    };
  }
  res.json(out);
});

// ---------- errores y archivos estáticos ----------
app.use('/api', (_req, res) => bad(res, 'Ruta no encontrada.', 404));
const publico = path.join(__dirname, '..', 'public');
app.use(express.static(publico));
app.get('/{*ruta}', (_req, res) => res.sendFile(path.join(publico, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Si la solicitud falló a medias, no se guarda nada en Google Sheets
  if (res.locals.dbctx) res.locals.dbctx.abortado = true;
  if (err.status && (err.status < 500 || err.expose)) return bad(res, err.type === 'entity.parse.failed' ? 'Solicitud no válida.' : err.message, err.status);
  console.error(err);
  bad(res, 'Ocurrió un error en el servidor.', 500);
});

module.exports = app;
