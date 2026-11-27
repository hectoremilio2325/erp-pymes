// Escenario completo de la API (sesión, permisos y privacidad), usado por las pruebas de cada modo de base de datos
const assert = require('node:assert');

function cliente(base) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

// hashDe(username) devuelve lo que la base guardó como contraseña de ese usuario
async function escenario(base, hashDe) {
  const admin = cliente(base); const ana = cliente(base); const luis = cliente(base);

  assert.equal((await admin('GET', '/api/setup')).data.necesario, true);
  assert.equal((await admin('POST', '/api/setup', { empresa: 'Acme', nombre: 'Jefa', username: 'jefa', password: 'corta' })).status, 400);
  assert.equal((await admin('POST', '/api/setup', { empresa: 'Acme', nombre: 'Jefa Uno', username: 'jefa', password: 'Secreta123' })).status, 200);
  assert.equal((await admin('POST', '/api/setup', { nombre: 'X', username: 'otro', password: 'Secreta123' })).status, 409);
  const yo = (await admin('GET', '/api/me')).data;
  assert.equal(yo.rol, 'admin'); assert.equal(yo.empresa, 'Acme');

  // La contraseña se guarda con hash
  const h = await hashDe('jefa');
  assert.match(h, /^scrypt\$/); assert.ok(!h.includes('Secreta123'));

  // Crear empleados
  // Usuarios nuevos: la contraseña provisional es su usuario (guardada con hash)
  const a = await admin('POST', '/api/users', { nombre: 'Ana', username: 'ana', puesto: 'Ventas', cumpleanos: '1990-12-03' });
  const l = await admin('POST', '/api/users', { nombre: 'Luis', username: 'luis' });
  assert.equal((await admin('POST', '/api/users', { nombre: 'Dup', username: 'ANA' })).status, 409);
  assert.match(await hashDe('ana'), /^scrypt\$/);

  assert.equal((await ana('POST', '/api/login', { username: 'ana', password: 'mal' })).status, 401);
  const la = await ana('POST', '/api/login', { username: 'ana', password: 'ana' });
  assert.equal(la.status, 200); assert.equal(la.data.debe_cambiar_password, true);
  // Con contraseña provisional no puede usar la app hasta cambiarla
  assert.equal((await ana('GET', '/api/me')).data.debe_cambiar_password, 1);
  assert.equal((await ana('GET', '/api/tasks')).status, 403);
  assert.equal((await ana('POST', '/api/me/password', { nueva: 'ana' })).status, 400);
  assert.equal((await ana('POST', '/api/me/password', { nueva: 'AnaClave1' })).status, 200);
  assert.equal((await ana('GET', '/api/tasks')).status, 200);
  assert.equal((await ana('GET', '/api/me')).data.debe_cambiar_password, 0);
  assert.equal((await luis('POST', '/api/login', { username: 'luis', password: 'luis' })).status, 200);
  assert.equal((await luis('POST', '/api/me/password', { nueva: 'LuisClave1' })).status, 200);
  assert.equal((await luis('POST', '/api/login', { username: 'luis', password: 'luis' })).status, 401, 'la provisional ya no sirve');
  assert.equal((await luis('POST', '/api/login', { username: 'luis', password: 'LuisClave1' })).status, 200);

  // Empleado no puede crear usuarios
  assert.equal((await ana('POST', '/api/users', { nombre: 'X', username: 'xx1' })).status, 403);
  // El directorio de colaboradores solo lo ve el administrador
  assert.equal((await ana('GET', '/api/users')).status, 403);
  assert.equal((await admin('GET', '/api/users')).data.length, 3);

  // Tarea asignada a Ana
  const t1 = (await admin('POST', '/api/tasks', { titulo: 'Reporte mensual', responsables: [a.data.id], prioridad: 'alta', fecha_limite: '2020-01-01' })).data.id;
  // Un empleado no puede asignar: se vuelve pendiente personal de Luis
  const t2 = (await luis('POST', '/api/tasks', { titulo: 'Llamar proveedor', personal: false, responsables: [a.data.id] })).data.id;
  assert.notEqual(t1, t2);

  assert.equal((await ana('GET', `/api/tasks/${t1}`)).status, 200);
  assert.equal((await luis('GET', `/api/tasks/${t1}`)).status, 404, 'Luis no ve tareas de Ana');
  assert.equal((await ana('GET', `/api/tasks/${t2}`)).status, 404, 'Ana no ve pendientes de Luis');
  assert.equal((await admin('GET', `/api/tasks/${t2}`)).status, 404, 'admin no ve personales por defecto');
  assert.equal((await luis('GET', `/api/tasks/${t2}`)).data.personal, 1);

  // Supervisión habilitada: admin ve, pero no modifica
  await admin('PUT', '/api/settings', { admin_ve_pendientes_personales: true });
  assert.equal((await admin('GET', `/api/tasks/${t2}`)).status, 200);
  assert.equal((await admin('PUT', `/api/tasks/${t2}`, { estado: 'completada' })).status, 403);
  await admin('PUT', '/api/settings', { admin_ve_pendientes_personales: false });

  // Ana actualiza estado pero no puede editar título ni borrar
  assert.equal((await ana('PUT', `/api/tasks/${t1}`, { estado: 'en_progreso', comentario: 'Avance 50%', titulo: 'Hackeado' })).status, 200);
  const det = (await admin('GET', `/api/tasks/${t1}`)).data;
  assert.equal(det.estado, 'en_progreso'); assert.equal(det.titulo, 'Reporte mensual');
  assert.ok(det.historial.some((x) => x.accion === 'comentario'));
  assert.equal((await ana('DELETE', `/api/tasks/${t1}`)).status, 403);

  // El admin reasigna la tarea a Ana y Luis
  assert.equal((await admin('PUT', `/api/tasks/${t1}`, { titulo: 'Reporte mensual', prioridad: 'alta', fecha_limite: '2020-01-01', responsables: [a.data.id, l.data.id] })).status, 200);
  assert.equal((await luis('GET', `/api/tasks/${t1}`)).data.responsables.length, 2);

  // Registro de horas y bitácora
  const hoyT = new Date().toISOString().slice(0, 10);
  // Formato horas.minutos: 0.45 + 0.45 = 1.30
  assert.equal((await ana('POST', `/api/tasks/${t1}/horas`, { horas: '0,45', nota: 'Borrador' })).status, 200);
  assert.equal((await ana('POST', `/api/tasks/${t1}/horas`, { horas: 0.45 })).status, 200);
  assert.equal((await luis('POST', `/api/tasks/${t1}/horas`, { horas: 2, fecha: hoyT })).status, 200);
  for (const mal of [0, '0.00', '1.60', '100', '1.234', 'abc', -1]) {
    assert.equal((await ana('POST', `/api/tasks/${t1}/horas`, { horas: mal })).status, 400, `rechaza ${mal}`);
  }
  assert.equal((await ana('POST', `/api/tasks/${t1}/horas`, { horas: '99.59' })).status, 200);
  assert.equal((await ana('POST', `/api/tasks/${t1}/horas`, { horas: '0.01' })).status, 200);
  const extra = (await ana('GET', `/api/tasks/${t1}`)).data.horas.filter((x) => x.horas === 99.59 || x.horas === 0.01);
  assert.equal(extra.length, 2);
  for (const x of extra) assert.equal((await ana('DELETE', `/api/horas/${x.id}`)).status, 200);
  assert.equal((await ana('POST', `/api/tasks/${t2}/horas`, { horas: 1 })).status, 404, 'no registra en pendientes ajenos');
  assert.equal((await luis('POST', `/api/tasks/${t2}/horas`, { horas: 0.5 })).status, 200);
  const conHoras = (await admin('GET', `/api/tasks/${t1}`)).data;
  assert.equal(conHoras.horas_total, 3.3); assert.equal(conHoras.horas.length, 3);
  assert.equal((await admin('GET', '/api/tasks')).data.find((x) => x.id === t1).horas_total, 3.3);
  const bitAna = (await ana('GET', '/api/bitacora')).data;
  assert.equal(bitAna.total, 1.3); assert.equal(bitAna.esta_semana, 1.3); assert.equal(bitAna.entradas.length, 2);
  const bitLuis = (await luis('GET', '/api/bitacora')).data;
  assert.equal(bitLuis.total, 2.5, 'Luis ve sus horas en tareas y pendientes');
  const bitAdmin = (await admin('GET', '/api/bitacora')).data;
  assert.equal(bitAdmin.total, 3.3, 'admin no ve horas de pendientes personales ajenos');
  assert.equal(bitAdmin.por_persona.length, 2); assert.equal(bitAdmin.por_semana.length, 1);
  assert.equal((await admin('GET', `/api/bitacora?usuario=${a.data.id}`)).data.total, 1.3);
  const horaLuis = conHoras.horas.find((x) => x.horas === 2).id;
  assert.equal((await ana('DELETE', `/api/horas/${horaLuis}`)).status, 403);
  assert.equal((await luis('DELETE', `/api/horas/${horaLuis}`)).status, 200);
  assert.equal((await admin('GET', `/api/tasks/${t1}`)).data.horas_total, 1.3);

  // Panel
  const dash = (await ana('GET', '/api/dashboard')).data;
  assert.equal(dash.tareas_abiertas, 1); assert.equal(dash.vencidas, 1); assert.equal(dash.equipo, undefined);
  assert.ok((await admin('GET', '/api/dashboard')).data.equipo);

  // Calendario
  const ev = await luis('POST', '/api/events', { titulo: 'Junta general?', fecha_inicio: '2026-12-10', general: true });
  assert.equal((await ana('GET', '/api/events?desde=2026-12-01&hasta=2026-12-31')).data.filter((x) => x.origen === 'evento').length, 0, 'evento de empleado es personal');
  await admin('POST', '/api/events', { titulo: 'Posada', tipo: 'festivo', fecha_inicio: '2026-12-18', hora: '19:00' });
  const cal = (await ana('GET', '/api/events?desde=2026-12-01&hasta=2026-12-31')).data;
  assert.ok(cal.some((x) => x.titulo === 'Posada' && x.hora === '19:00'));
  assert.ok(cal.some((x) => x.origen === 'cumpleanos' && x.inicio === '2026-12-03'));
  assert.equal((await ana('DELETE', `/api/events/${ev.data.id}`)).status, 404);
  assert.equal((await luis('DELETE', `/api/events/${ev.data.id}`)).status, 200);

  // Incidencias
  const inc = (await ana('POST', '/api/incidents', { tipo: 'vacaciones', fecha_inicio: '2026-12-21', fecha_fin: '2026-12-24', motivo: 'Viaje' })).data.id;
  assert.equal((await ana('POST', `/api/incidents/${inc}/revisar`, { estado: 'aprobada' })).status, 403);
  assert.equal((await luis('GET', '/api/incidents')).data.length, 0);
  assert.equal((await admin('POST', `/api/incidents/${inc}/revisar`, { estado: 'aprobada', comentario: 'OK' })).status, 200);
  assert.equal((await admin('POST', `/api/incidents/${inc}/revisar`, { estado: 'rechazada' })).status, 409);
  assert.ok((await luis('GET', '/api/events?desde=2026-12-01&hasta=2026-12-31')).data.some((x) => x.tipo === 'vacaciones'));

  // Borrar un pendiente personal
  assert.equal((await luis('DELETE', `/api/tasks/${t2}`)).status, 200);
  assert.equal((await luis('GET', `/api/tasks/${t2}`)).status, 404);

  // Cambio de contraseña y desactivación
  assert.equal((await ana('POST', '/api/me/password', { actual: 'mal', nueva: 'NuevaClave2' })).status, 400);
  assert.equal((await ana('POST', '/api/me/password', { actual: 'AnaClave1', nueva: 'NuevaClave2' })).status, 200);
  assert.equal((await ana('GET', '/api/me')).status, 200, 'la sesión actual sigue activa');
  // Restablecer: vuelve a la contraseña provisional (su usuario)
  assert.equal((await ana('POST', `/api/users/${l.data.id}/password`, {})).status, 403);
  assert.equal((await admin('POST', `/api/users/${l.data.id}/password`, {})).status, 200);
  assert.equal((await luis('GET', '/api/me')).status, 401, 'se cerraron sus sesiones');
  assert.equal((await luis('POST', '/api/login', { username: 'luis', password: 'luis' })).data.debe_cambiar_password, true);
  assert.equal((await luis('POST', '/api/me/password', { nueva: 'LuisClave1' })).status, 200);
  await admin('PUT', `/api/users/${l.data.id}`, { nombre: 'Luis', activo: false });
  assert.equal((await luis('GET', '/api/me')).status, 401);
  assert.equal((await luis('POST', '/api/login', { username: 'luis', password: 'LuisClave1' })).status, 403);

  // No se puede quitar el último administrador
  assert.equal((await admin('PUT', `/api/users/${yo.id}`, { nombre: 'Jefa', rol: 'empleado' })).status, 400);

  // Bloqueo tras 5 intentos fallidos
  const x = cliente(base);
  for (let i = 0; i < 5; i++) await x('POST', '/api/login', { username: 'jefa', password: 'mala1234' });
  assert.equal((await x('POST', '/api/login', { username: 'jefa', password: 'Secreta123' })).status, 429);

  await admin('POST', '/api/logout');
  assert.equal((await admin('GET', '/api/me')).status, 401);
  return { t1, t2, ana: a.data.id, luis: l.data.id };
}

function iniciar(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r({ server: s, base: `http://127.0.0.1:${s.address().port}` })); });
}

module.exports = { escenario, iniciar, cliente };
