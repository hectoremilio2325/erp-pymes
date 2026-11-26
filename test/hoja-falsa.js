// Servidor falso de Google Sheets en memoria (implementa solo lo que usa la app)
const ENCABEZADOS = {
  Usuarios: ['id', 'username', 'password_hash', 'nombre', 'rol', 'puesto', 'departamento', 'email', 'telefono', 'fecha_ingreso', 'cumpleanos', 'activo', 'creado_en'],
  Tareas: ['id', 'titulo', 'descripcion', 'prioridad', 'fecha_limite', 'estado', 'personal', 'creado_por', 'creado_en', 'actualizado_en'],
  Pendientes: ['id', 'titulo', 'descripcion', 'prioridad', 'fecha_limite', 'estado', 'personal', 'creado_por', 'creado_en', 'actualizado_en'],
  Responsables: ['task_id', 'user_id'],
  Historial_Tareas: ['id', 'task_id', 'user_id', 'accion', 'detalle', 'creado_en'],
  Calendario: ['id', 'titulo', 'descripcion', 'tipo', 'fecha_inicio', 'fecha_fin', 'hora', 'general', 'creado_por', 'creado_en'],
  Incidencias: ['id', 'user_id', 'tipo', 'fecha_inicio', 'fecha_fin', 'motivo', 'estado', 'revisado_por', 'comentario_revision', 'creado_en', 'revisado_en'],
  Configuracion: ['clave', 'valor'],
  Sesiones: ['token', 'user_id', 'expira_en'],
  Intentos_Login: ['clave', 'intentos', 'desde'],
};

function crearHojaFalsa() {
  const hojas = { Instrucciones: [['Texto libre']] };
  Object.entries(ENCABEZADOS).forEach(([h, e]) => { hojas[h] = [[...e]]; });
  hojas.Configuracion.push(['nombre_empresa', 'Mi Empresa'], ['admin_ve_pendientes_personales', '0']);
  const ids = Object.fromEntries(Object.keys(hojas).map((h, i) => [h, i]));
  let llamadas = 0;
  const nombre = (r) => decodeURIComponent(r).split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  const recortar = (filas) => {
    const out = filas.map((f) => { const c = [...f]; while (c.length && (c[c.length - 1] === '' || c[c.length - 1] == null)) c.pop(); return c; });
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  };

  async function fetchFalso(url, opt = {}) {
    llamadas++;
    const u = new URL(url);
    const ruta = decodeURIComponent(u.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, ''));
    const cuerpo = opt.body ? JSON.parse(opt.body) : null;
    if (ruta === '/values:batchGet') {
      return ok({ valueRanges: u.searchParams.getAll('ranges').map((r) => ({ values: structuredClone(recortar(hojas[nombre(r)] || [])) })) });
    }
    if (ruta === '' && u.searchParams.get('fields')) {
      return ok({ sheets: Object.keys(hojas).map((t) => ({ properties: { title: t, sheetId: ids[t] } })) });
    }
    if (ruta === '/values:batchUpdate') {
      for (const d of cuerpo.data) {
        const h = hojas[nombre(d.range)];
        const fila = Number(d.range.split('!A')[1]) - 1;
        h[fila] ||= [];
        d.values[0].forEach((v, j) => { if (v !== null) h[fila][j] = v; });
      }
      return ok({});
    }
    if (ruta.startsWith('/values/') && ruta.endsWith(':append')) {
      const h = hojas[nombre(ruta.slice(8, -7))];
      const ultima = recortar(h).length;
      h.splice(ultima, 0, ...cuerpo.values.map((f) => [...f]));
      return ok({});
    }
    if (ruta === ':batchUpdate') {
      for (const r of cuerpo.requests) {
        const { sheetId, startIndex, endIndex } = r.deleteDimension.range;
        const t = Object.keys(ids).find((k) => ids[k] === sheetId);
        hojas[t].splice(startIndex, endIndex - startIndex);
      }
      return ok({});
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: `Ruta falsa no soportada: ${ruta}` } }) };
  }

  // Convierte una hoja en objetos (como la vería una persona)
  const filas = (h) => recortar(hojas[h]).slice(1).map((f) => Object.fromEntries(hojas[h][0].map((c, i) => [c, f[i]])));
  return { hojas, fetch: fetchFalso, filas, llamadas: () => llamadas };
}

module.exports = { crearHojaFalsa };
