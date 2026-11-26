// Prueba con Google Sheets como base de datos (contra un servidor falso en memoria)
const test = require('node:test');
const assert = require('node:assert');

process.env.GOOGLE_SHEET_ID = 'hoja-de-prueba';
const app = require('../src/app');
const { db } = require('../src/db');
const { escenario, iniciar, cliente } = require('./escenario');
const { crearHojaFalsa } = require('./hoja-falsa');

test('modo Google Sheets: flujo completo y datos en cada hoja', async () => {
  const falsa = crearHojaFalsa();
  db.configurarSheets({ fetch: falsa.fetch, token: async () => 'token-falso', spreadsheetId: 'hoja-de-prueba' });
  const { server, base } = await iniciar(app);
  try {
    const r = await escenario(base, async (u) => falsa.filas('Usuarios').find((f) => f.username === u).password_hash);

    // Usuarios: contraseñas solo con hash
    const usuarios = falsa.filas('Usuarios');
    assert.equal(usuarios.length, 3);
    assert.ok(usuarios.every((u) => /^scrypt\$/.test(u.password_hash)));
    assert.equal(usuarios.find((u) => u.username === 'luis').activo, 0);
    assert.ok(usuarios.every((u) => u.debe_cambiar_password === 0));

    // Tareas asignadas y pendientes personales en hojas separadas; el pendiente borrado ya no está
    assert.deepEqual(falsa.filas('Tareas').map((t) => t.titulo), ['Reporte mensual']);
    assert.equal(falsa.filas('Pendientes').length, 0);
    assert.equal(falsa.filas('Responsables').filter((x) => x.task_id === r.t1).length, 2);
    assert.ok(falsa.filas('Historial_Tareas').length >= 3);
    assert.ok(falsa.filas('Historial_Tareas').every((h) => h.task_id === r.t1), 'el historial del pendiente borrado se eliminó');
    assert.ok(falsa.filas('Horas').length === 1 && falsa.filas('Horas').every((h) => h.task_id === r.t1 && h.horas === 1.5), 'horas en la hoja Horas');

    // Calendario, incidencias y configuración
    assert.deepEqual(falsa.filas('Calendario').map((e) => e.titulo), ['Posada']);
    const inc = falsa.filas('Incidencias');
    assert.equal(inc.length, 1); assert.equal(inc[0].estado, 'aprobada'); assert.equal(inc[0].fecha_inicio, '2026-12-21');
    assert.equal(falsa.filas('Configuracion').find((c) => c.clave === 'nombre_empresa').valor, 'Acme');

    // Sesiones: solo hashes de token, y el logout borró la del admin
    assert.ok(falsa.filas('Sesiones').every((s) => /^[0-9a-f]{64}$/.test(s.token)));

    // Un cambio hecho a mano en la hoja se ve en la app (fecha escrita como fecha de Sheets y texto en mayúsculas)
    const fila = falsa.hojas.Tareas.findIndex((f) => f[1] === 'Reporte mensual');
    falsa.hojas.Tareas[fila][1] = 'Reporte mensual (editado en Sheets)';
    falsa.hojas.Tareas[fila][4] = 46387; // 2026-12-31 como número de serie
    const jefa = cliente(base);
    assert.equal((await jefa('POST', '/api/login', { username: 'ana', password: 'NuevaClave2' })).status, 200);
    const t = (await jefa('GET', `/api/tasks/${r.t1}`)).data;
    assert.equal(t.titulo, 'Reporte mensual (editado en Sheets)');
    assert.equal(t.fecha_limite, '2026-12-31');

    // Una fila escrita a mano con un dato inválido no rompe la app y no se borra
    falsa.hojas.Calendario.push([99, '', '', 'reunion', '2026-12-01']);
    assert.equal((await jefa('GET', '/api/events?desde=2026-12-01&hasta=2026-12-31')).status, 200);
    const nuevo = (await jefa('POST', '/api/events', { titulo: 'Mía', fecha_inicio: '2026-12-02' })).data.id;
    assert.equal(nuevo, 100, 'los nuevos id siguen al mayor del archivo');
    assert.ok(falsa.hojas.Calendario.some((f) => f[0] === 99), 'la fila inválida sigue en la hoja');

    // Usuario agregado a mano en la hoja, sin id y sin contraseña: entra con su usuario y debe cambiarla
    falsa.hojas.Usuarios.push(['', 'pedro', '', 'Pedro Gómez', 'empleado']);
    const pedro = cliente(base);
    const lp = await pedro('POST', '/api/login', { username: 'pedro', password: 'pedro' });
    assert.equal(lp.status, 200); assert.equal(lp.data.debe_cambiar_password, true);
    const filaPedro = falsa.filas('Usuarios').find((u) => u.username === 'pedro');
    assert.equal(filaPedro.id, 4, 'se le asignó id en la hoja');
    assert.equal(falsa.filas('Usuarios').filter((u) => u.username === 'pedro').length, 1, 'sin filas duplicadas');
    assert.equal((await pedro('GET', '/api/tasks')).status, 403);
    assert.equal((await pedro('POST', '/api/me/password', { nueva: 'PedroClave9' })).status, 200);
    assert.match(falsa.filas('Usuarios').find((u) => u.username === 'pedro').password_hash, /^scrypt\$/);
    // Valores escritos a mano como "si" y "Admin" se entienden
    falsa.hojas.Usuarios.push([60, 'memo', 'memo', 'Memo', 'Admin', '', '', '', '', '', '', 'si']);
    const memo = cliente(base);
    await memo('POST', '/api/login', { username: 'memo', password: 'memo' });
    assert.equal((await memo('POST', '/api/me/password', { nueva: 'MemoClave1' })).status, 200);
    assert.equal((await memo('GET', '/api/users')).data.find((u) => u.username === 'memo').rol, 'admin');
    falsa.hojas.Usuarios.push([61, 'inactivo1', 'inactivo1', 'Ina', '', '', '', '', '', '', '', 'no']);
    assert.equal((await cliente(base)('POST', '/api/login', { username: 'inactivo1', password: 'inactivo1' })).status, 403);

    // Contraseña escrita a mano en texto en la hoja: también funciona como provisional
    falsa.hojas.Usuarios.push([50, 'sofia', 'sofia', 'Sofía']);
    assert.equal((await cliente(base)('POST', '/api/login', { username: 'sofia', password: 'sofia' })).data.debe_cambiar_password, true);

    // Columnas reordenadas por el usuario: la app las sigue leyendo por su nombre
    const h = falsa.hojas.Incidencias;
    for (const f of h) { const m = f[5]; f[5] = f[0]; f[0] = m; } // intercambia "id" y "motivo"
    const lista = (await jefa('GET', '/api/incidents')).data;
    assert.equal(lista[0].motivo, 'Viaje'); assert.equal(lista[0].id, 1);
  } finally { server.close(); }
});
