// ERP PyMES: interfaz de una sola página (sin frameworks)
'use strict';

// ---------- utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtFecha = (iso) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${Number(d)} ${MESES[Number(m) - 1].slice(0, 3)} ${y}`; };
const fmtFechaHora = (s) => { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }); };

const PRIORIDAD = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const ESTADO_TAREA = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada' };
const TIPO_EVENTO = { actividad: 'Actividad', reunion: 'Reunión', entrega: 'Fecha de entrega', festivo: 'Día festivo', vacaciones: 'Vacaciones', otro: 'Otro' };
const TIPO_INC = { home_office: 'Home Office', permiso: 'Permiso', ausencia: 'Ausencia', vacaciones: 'Vacaciones', retardo: 'Retardo', otra: 'Otra incidencia' };
const ESTADO_INC = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', cancelada: 'Cancelada' };
// Tiempo en formato horas.minutos (1.30 = 1 hora 30 minutos)
const fmtHoras = (n) => `${Number(n || 0).toFixed(2)} h`;
const chip = (clase, texto) => `<span class="etiqueta-chip chip-${esc(clase)}">${esc(texto)}</span>`;
const opciones = (mapa, sel) => Object.entries(mapa).map(([k, v]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me/password')) { estado.yo = null; mostrarAcceso(); throw new Error(data.error || 'Sesión expirada'); }
  if (res.status === 403 && data.debe_cambiar_password) { location.reload(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error.');
  return data;
}

function aviso(texto, esError = false) {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = 'visible' + (esError ? ' error' : '');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { el.className = ''; }, 3000);
}

const modal = {
  abrir(html, alMontar) {
    $('#modal-contenido').innerHTML = html;
    const d = $('#modal');
    if (!d.open) d.showModal();
    $$('[data-cerrar]', d).forEach((b) => b.addEventListener('click', () => modal.cerrar()));
    if (alMontar) alMontar($('#modal-contenido'));
    const primero = $('input, select, textarea', d);
    if (primero) primero.focus();
  },
  cerrar() { $('#modal').close(); },
};

// Convierte un formulario en objeto
function datosForm(form) {
  const o = {};
  $$('input, select, textarea', form).forEach((el) => {
    if (!el.name) return;
    if (el.type === 'checkbox' && el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(Number(el.value)); return; }
    if (el.type === 'checkbox') { o[el.name] = el.checked; return; }
    o[el.name] = el.value;
  });
  return o;
}

// Envía un formulario mostrando errores en el propio formulario
function alEnviar(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    if (err) err.textContent = '';
    const btn = $('button[type=submit]', form);
    if (btn) btn.disabled = true;
    try { await fn(datosForm(form)); } catch (ex) { if (err) err.textContent = ex.message; else aviso(ex.message, true); } finally { if (btn) btn.disabled = false; }
  });
}

// ---------- estado y navegación ----------
const estado = { yo: null, usuarios: [] };
const esAdmin = () => estado.yo && estado.yo.rol === 'admin';

const RUTAS = {
  panel: { titulo: 'Panel principal', fn: vistaPanel },
  tareas: { titulo: 'Tareas y pendientes', fn: vistaTareas },
  bitacora: { titulo: 'Bitácora de horas', fn: vistaBitacora },
  calendario: { titulo: 'Calendario', fn: vistaCalendario },
  incidencias: { titulo: 'Incidencias', fn: vistaIncidencias },
  directorio: { titulo: 'Directorio', fn: vistaDirectorio, admin: true },
  perfil: { titulo: 'Mi perfil', fn: vistaPerfil },
  configuracion: { titulo: 'Configuración', fn: vistaConfiguracion, admin: true },
};

async function iniciar() {
  try {
    const r0 = await fetch('/api/setup');
    const s = await r0.json();
    if (!r0.ok) { $('#app').textContent = s.error || 'No se pudo conectar con el servidor.'; return; }
    if (s.necesario) return mostrarConfiguracionInicial();
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok) return mostrarAcceso(s.empresa);
    estado.yo = await r.json();
    if (estado.yo.debe_cambiar_password) return mostrarCambioObligatorio();
    montarLayout();
    window.addEventListener('hashchange', navegar);
    navegar();
  } catch (e) {
    $('#app').textContent = 'No se pudo conectar con el servidor.';
  }
}

function mostrarAcceso(empresa) {
  $('#app').className = '';
  $('#app').innerHTML = `
    <main class="acceso">
      <div class="acceso-empresa">${esc(empresa || (estado.yo && estado.yo.empresa) || 'ERP PyMES')}</div>
      <form class="tarjeta" id="f-login">
        <h1>Iniciar sesión</h1>
        <div class="campo"><label for="l-u">Usuario</label><input id="l-u" name="username" autocomplete="username" required></div>
        <div class="campo"><label for="l-p">Contraseña</label><input id="l-p" name="password" type="password" autocomplete="current-password" required></div>
        <div class="error"></div>
        <button class="primario" type="submit">Entrar</button>
      </form>
    </main>`;
  alEnviar($('#f-login'), async (d) => { await api('/api/login', { method: 'POST', body: d }); location.hash = '#/panel'; location.reload(); });
  $('#l-u').focus();
}

function mostrarCambioObligatorio() {
  $('#app').className = '';
  $('#app').innerHTML = `
    <main class="acceso">
      <form class="tarjeta" id="f-nueva">
        <h1>Crea tu contraseña</h1>
        <p>Hola, ${esc(estado.yo.nombre)}. Entraste con una contraseña provisional. Antes de continuar, elige una contraseña propia.</p>
        <div class="campo"><label for="n-p">Nueva contraseña</label><input id="n-p" name="nueva" type="password" autocomplete="new-password" required>
          <span class="ayuda">Mínimo 8 caracteres, con letras y números, y distinta de tu usuario.</span></div>
        <div class="campo"><label for="n-c">Confirmar contraseña</label><input id="n-c" name="confirmar" type="password" autocomplete="new-password" required></div>
        <div class="error"></div>
        <button class="primario" type="submit">Guardar y entrar</button>
        <button type="button" id="n-salir">Cerrar sesión</button>
      </form>
    </main>`;
  alEnviar($('#f-nueva'), async (d) => {
    if (d.nueva !== d.confirmar) throw new Error('Las contraseñas no coinciden.');
    await api('/api/me/password', { method: 'POST', body: { nueva: d.nueva } });
    location.hash = '#/panel'; location.reload();
  });
  $('#n-salir').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });
  $('#n-p').focus();
}

function mostrarConfiguracionInicial() {
  $('#app').className = '';
  $('#app').innerHTML = `
    <main class="acceso">
      <form class="tarjeta" id="f-setup">
        <h1>Bienvenido</h1>
        <p>Configura tu empresa y crea la cuenta del administrador.</p>
        <div class="campo"><label for="s-e">Nombre de la empresa</label><input id="s-e" name="empresa" required></div>
        <div class="campo"><label for="s-n">Tu nombre completo</label><input id="s-n" name="nombre" required></div>
        <div class="campo"><label for="s-u">Usuario</label><input id="s-u" name="username" autocomplete="username" required></div>
        <div class="campo"><label for="s-p">Contraseña</label><input id="s-p" name="password" type="password" autocomplete="new-password" required>
          <span class="ayuda">Mínimo 8 caracteres, con letras y números.</span></div>
        <div class="error"></div>
        <button class="primario" type="submit">Crear y entrar</button>
      </form>
    </main>`;
  alEnviar($('#f-setup'), async (d) => { await api('/api/setup', { method: 'POST', body: d }); location.hash = '#/panel'; location.reload(); });
}

function montarLayout() {
  const yo = estado.yo;
  const enlaces = Object.entries(RUTAS).filter(([, r]) => !r.admin || esAdmin())
    .map(([k, r]) => `<a href="#/${k}" data-ruta="${k}">${esc(r.titulo)}<span data-badge="${k}"></span></a>`).join('');
  $('#app').className = '';
  $('#app').innerHTML = `
    <div class="layout">
      <nav class="lateral" id="lateral" aria-label="Menú principal">
        <div class="marca">${esc(yo.empresa)}<small>Control interno</small></div>
        ${enlaces}
        <div class="pie"><strong>${esc(yo.nombre)}</strong>${yo.rol === 'admin' ? 'Administrador' : 'Colaborador'}
          <button id="b-salir">Cerrar sesión</button></div>
      </nav>
      <main class="contenido">
        <button class="menu-movil" id="b-menu" aria-controls="lateral">☰ Menú</button>
        <div id="vista"></div>
      </main>
    </div>`;
  $('#b-salir').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.hash = ''; location.reload(); });
  $('#b-menu').addEventListener('click', () => $('#lateral').classList.toggle('abierto'));
}

async function navegar() {
  const clave = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'panel';
  const ruta = RUTAS[clave] && (!RUTAS[clave].admin || esAdmin()) ? RUTAS[clave] : RUTAS.panel;
  $$('.lateral a').forEach((a) => a.classList.toggle('activo', a.dataset.ruta === clave));
  $('#lateral').classList.remove('abierto');
  document.title = `${ruta.titulo} · ${estado.yo.empresa}`;
  const v = $('#vista');
  v.innerHTML = '<p class="suave">Cargando…</p>';
  try { await ruta.fn(v); } catch (e) { v.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function cargarUsuarios() { estado.usuarios = await api('/api/users'); return estado.usuarios; }

// ---------- panel principal ----------
async function vistaPanel(v) {
  const d = await api('/api/dashboard');
  const hoy = hoyISO();
  const filasTareas = d.por_vencer.length ? d.por_vencer.map((t) => `
    <tr class="clic" data-tarea="${t.id}"><td>${esc(t.titulo)} ${t.personal ? chip('personal', 'Personal') : ''}</td>
    <td class="${t.fecha_limite < hoy ? 'vencida' : ''}">${fmtFecha(t.fecha_limite)}</td><td>${chip(t.prioridad, PRIORIDAD[t.prioridad])}</td></tr>`).join('')
    : '<tr><td colspan="3" class="vacio">No tienes tareas por vencer esta semana.</td></tr>';
  const eventos = d.proximos_eventos.length ? d.proximos_eventos.map((e) => `
    <tr><td>${esc(e.titulo)}</td><td>${fmtFecha(e.fecha_inicio)} ${esc(e.hora || '')}</td><td>${chip('x', TIPO_EVENTO[e.tipo])}</td></tr>`).join('')
    : '<tr><td colspan="3" class="vacio">Sin actividades en los próximos 14 días.</td></tr>';

  let equipo = '';
  if (d.equipo) {
    const e = d.equipo;
    equipo = `
      <h2>Resumen del equipo</h2>
      <div class="cifras">
        <a class="cifra ${e.solicitudes_por_revisar ? 'alerta' : ''}" href="#/incidencias"><div class="valor">${e.solicitudes_por_revisar}</div><div class="etiqueta">Solicitudes por revisar</div></a>
        <div class="cifra"><div class="valor">${e.tareas_abiertas}</div><div class="etiqueta">Tareas asignadas abiertas</div></div>
        <div class="cifra ${e.tareas_vencidas ? 'alerta' : ''}"><div class="valor">${e.tareas_vencidas}</div><div class="etiqueta">Tareas del equipo vencidas</div></div>
        <div class="cifra"><div class="valor">${e.empleados_activos}</div><div class="etiqueta">Personas activas</div></div>
      </div>
      <div class="tarjeta tabla-scroll"><h2>Avance por colaborador</h2>
        <table><thead><tr><th>Colaborador</th><th>Abiertas</th><th>Vencidas</th><th>Completadas</th></tr></thead><tbody>
        ${e.por_persona.map((p) => `<tr><td>${esc(p.nombre)}</td><td>${p.abiertas || 0}</td><td class="${p.vencidas ? 'vencida' : ''}">${p.vencidas || 0}</td><td>${p.completadas || 0}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  v.innerHTML = `
    <h1>Hola, ${esc(estado.yo.nombre.split(' ')[0])}</h1>
    <div class="cifras">
      <a class="cifra" href="#/tareas"><div class="valor">${d.tareas_abiertas}</div><div class="etiqueta">Mis tareas abiertas</div></a>
      <div class="cifra ${d.vencidas ? 'alerta' : ''}"><div class="valor">${d.vencidas}</div><div class="etiqueta">Vencidas</div></div>
      <div class="cifra"><div class="valor">${d.por_vencer.length}</div><div class="etiqueta">Vencen en 7 días o antes</div></div>
      <a class="cifra" href="#/incidencias"><div class="valor">${d.mis_incidencias_pendientes}</div><div class="etiqueta">Mis solicitudes en espera</div></a>
    </div>
    <div class="columnas">
      <div class="tarjeta tabla-scroll"><h2>Próximas a vencer</h2><table><tbody>${filasTareas}</tbody></table></div>
      <div class="tarjeta tabla-scroll"><h2>Próximas actividades</h2><table><tbody>${eventos}</tbody></table></div>
    </div>
    ${equipo}`;
  $$('[data-tarea]', v).forEach((tr) => tr.addEventListener('click', () => abrirTarea(Number(tr.dataset.tarea), () => vistaPanel(v))));
}

// ---------- tareas ----------
async function vistaTareas(v) {
  if (esAdmin()) await cargarUsuarios();
  const f = vistaTareas.filtros ||= { tipo: '', estado: 'abiertas', responsable: '' };
  const qs = new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString();
  const tareas = await api('/api/tasks?' + qs);
  const hoy = hoyISO();
  v.innerHTML = `
    <div class="encabezado"><h1>Tareas y pendientes</h1>
      <div>${esAdmin() ? '<button class="primario" id="b-asignar">+ Asignar tarea</button> ' : ''}<button ${esAdmin() ? '' : 'class="primario"'} id="b-personal">+ Pendiente personal</button></div></div>
    <div class="filtros">
      <select id="f-tipo" aria-label="Tipo"><option value="">Todas</option>${opciones({ asignada: 'Asignadas', personal: 'Personales' }, f.tipo)}</select>
      <select id="f-estado" aria-label="Estado"><option value="">Cualquier estado</option>${opciones({ abiertas: 'Abiertas', ...ESTADO_TAREA }, f.estado)}</select>
      ${esAdmin() ? `<select id="f-resp" aria-label="Responsable"><option value="">Todos los responsables</option>${estado.usuarios.filter((u) => u.activo).map((u) => `<option value="${u.id}"${String(u.id) === f.responsable ? ' selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="tarjeta tabla-scroll">
      <table><thead><tr><th>Tarea</th><th>Responsables</th><th>Prioridad</th><th>Fecha límite</th><th>Estado</th><th>Horas</th></tr></thead>
      <tbody>${tareas.length ? tareas.map((t) => `
        <tr class="clic ${t.estado === 'completada' ? 'hecha' : ''}" data-tarea="${t.id}">
          <td><span class="titulo">${esc(t.titulo)}</span> ${t.personal ? chip('personal', 'Personal') : ''}</td>
          <td>${t.personal ? '<span class="suave">—</span>' : esc(t.responsables || '')}</td>
          <td>${chip(t.prioridad, PRIORIDAD[t.prioridad])}</td>
          <td class="${t.estado !== 'completada' && t.fecha_limite && t.fecha_limite < hoy ? 'vencida' : ''}">${fmtFecha(t.fecha_limite) || '<span class="suave">Sin fecha</span>'}</td>
          <td>${chip(t.estado, ESTADO_TAREA[t.estado])}</td>
          <td>${t.horas_total ? fmtHoras(t.horas_total) : '<span class="suave">—</span>'}</td></tr>`).join('') : '<tr><td colspan="6" class="vacio">No hay tareas con estos filtros.</td></tr>'}
      </tbody></table></div>`;
  const recargar = () => vistaTareas(v);
  $('#f-tipo').addEventListener('change', (e) => { f.tipo = e.target.value; recargar(); });
  $('#f-estado').addEventListener('change', (e) => { f.estado = e.target.value; recargar(); });
  if ($('#f-resp')) $('#f-resp').addEventListener('change', (e) => { f.responsable = e.target.value; recargar(); });
  if ($('#b-asignar')) $('#b-asignar').addEventListener('click', () => formTarea(null, false, recargar));
  $('#b-personal').addEventListener('click', () => formTarea(null, true, recargar));
  $$('[data-tarea]', v).forEach((tr) => tr.addEventListener('click', () => abrirTarea(Number(tr.dataset.tarea), recargar)));
}

async function formTarea(t, personal, alGuardar) {
  if (!personal && !estado.usuarios.length) await cargarUsuarios();
  const sel = new Set((t && t.responsables || []).map((r) => r.id));
  const lista = estado.usuarios.filter((u) => u.activo).map((u) => `
    <label><input type="checkbox" name="responsables" data-multi="1" value="${u.id}"${sel.has(u.id) ? ' checked' : ''}> ${esc(u.nombre)} <span class="suave">${esc(u.puesto || '')}</span></label>`).join('');
  modal.abrir(`
    <h2>${t ? 'Editar' : 'Nueva'} ${personal ? 'pendiente personal' : 'tarea asignada'}</h2>
    <form id="f-tarea">
      <div class="campo"><label for="t-ti">Título</label><input id="t-ti" name="titulo" required maxlength="200" value="${esc(t?.titulo)}"></div>
      <div class="campo"><label for="t-de">Descripción</label><textarea id="t-de" name="descripcion">${esc(t?.descripcion)}</textarea></div>
      <div class="fila">
        <div class="campo"><label for="t-pr">Prioridad</label><select id="t-pr" name="prioridad">${opciones(PRIORIDAD, t?.prioridad || 'media')}</select></div>
        <div class="campo"><label for="t-fl">Fecha límite</label><input id="t-fl" type="date" name="fecha_limite" value="${esc(t?.fecha_limite)}"></div>
      </div>
      ${personal ? '' : `<div class="campo"><label>Responsables</label><div class="lista-check">${lista}</div><span class="ayuda">Puedes asignarla a una o varias personas.</span></div>`}
      <div class="error"></div>
      <div class="acciones"><button type="button" data-cerrar>Cancelar</button><button class="primario" type="submit">Guardar</button></div>
    </form>`, (root) => {
    alEnviar($('#f-tarea', root), async (d) => {
      d.personal = personal;
      if (!personal && !(d.responsables || []).length) throw new Error('Elige al menos un responsable.');
      if (t) await api(`/api/tasks/${t.id}`, { method: 'PUT', body: d });
      else await api('/api/tasks', { method: 'POST', body: d });
      modal.cerrar(); aviso('Tarea guardada'); alGuardar();
    });
  });
}

async function abrirTarea(id, alCambiar) {
  const t = await api(`/api/tasks/${id}`);
  const yo = estado.yo.id;
  const puedeEditar = t.personal ? t.creado_por === yo : esAdmin();
  const esResp = t.responsables.some((r) => r.id === yo);
  const puedeEstado = puedeEditar || esResp;
  modal.abrir(`
    <h2>${esc(t.titulo)}</h2>
    <p>${t.personal ? chip('personal', 'Pendiente personal') : ''} ${chip(t.prioridad, 'Prioridad ' + PRIORIDAD[t.prioridad].toLowerCase())} ${chip(t.estado, ESTADO_TAREA[t.estado])}</p>
    ${t.descripcion ? `<p>${esc(t.descripcion).replace(/\n/g, '<br>')}</p>` : ''}
    <p class="suave">Fecha límite: <strong>${fmtFecha(t.fecha_limite) || 'sin fecha'}</strong><br>
      Creada por ${esc(t.creado_por_nombre)} el ${fmtFechaHora(t.creado_en)}
      ${t.personal ? '' : `<br>Responsables: ${t.responsables.map((r) => esc(r.nombre)).join(', ')}`}</p>
    ${puedeEstado ? `
    <form id="f-avance">
      <div class="fila">
        <div class="campo"><label for="a-es">Estado</label><select id="a-es" name="estado">${opciones(ESTADO_TAREA, t.estado)}</select></div>
        <div class="campo"><label for="a-co">Comentario o avance (opcional)</label><input id="a-co" name="comentario" maxlength="1000"></div>
      </div>
      <div class="error"></div>
      <div class="acciones">
        ${puedeEditar ? '<button type="button" class="peligro" id="b-borrar">Eliminar</button><button type="button" id="b-editar">Editar</button>' : ''}
        <button type="button" data-cerrar>Cerrar</button><button class="primario" type="submit">Guardar avance</button></div>
    </form>` : '<div class="acciones"><button type="button" data-cerrar>Cerrar</button></div>'}
    <h2>Horas trabajadas <span class="suave">· ${fmtHoras(t.horas_total)} en total</span></h2>
    ${puedeEstado ? `
    <form id="f-horas" class="form-horas">
      <div class="campo"><label for="h-fe">Fecha</label><input id="h-fe" type="date" name="fecha" value="${hoyISO()}" max="${hoyISO()}" required></div>
      <div class="campo"><label for="h-ho">Horas</label><input id="h-ho" name="horas" inputmode="decimal" pattern="\\d{1,2}([.,][0-5]?\\d)?" maxlength="5" placeholder="1.30" required title="Horas.minutos, de 0.01 a 99.59"></div>
      <div class="campo"><label for="h-no">¿Qué hiciste? (opcional)</label><input id="h-no" name="nota" maxlength="300"></div>
      <button class="primario" type="submit">Registrar</button>
      <span class="ayuda">Formato horas.minutos: 0.45 = 45 minutos, 1.30 = 1 hora 30 minutos (máximo 99.59).</span>
      <div class="error"></div>
    </form>` : ''}
    ${t.horas.length ? `<table class="tabla-horas"><tbody>${t.horas.map((h) => `
      <tr><td>${fmtFecha(h.fecha)}</td><td>${esc(h.nombre)}</td><td><strong>${fmtHoras(h.horas)}</strong></td><td>${esc(h.nota || '')}</td>
      <td>${h.user_id === yo || esAdmin() ? `<button type="button" class="chico peligro" data-borrar-hora="${h.id}">Borrar</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p class="vacio">Todavía no hay horas registradas.</p>'}
    <h2>Historial</h2>
    <ul class="historial">${t.historial.map((h) => `<li><strong>${esc(h.nombre)}</strong> · ${esc(h.accion)}${h.detalle ? ': ' + esc(h.detalle) : ''} <span class="suave">· ${fmtFechaHora(h.creado_en)}</span></li>`).join('')}</ul>`,
  (root) => {
    const f = $('#f-avance', root);
    if (f) alEnviar(f, async (d) => { await api(`/api/tasks/${id}`, { method: 'PUT', body: d }); modal.cerrar(); aviso('Avance guardado'); alCambiar(); });
    const fh = $('#f-horas', root);
    if (fh) alEnviar(fh, async (d) => { await api(`/api/tasks/${id}/horas`, { method: 'POST', body: d }); aviso('Horas registradas'); alCambiar(); abrirTarea(id, alCambiar); });
    $$('[data-borrar-hora]', root).forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro?'; return; }
      try { await api(`/api/horas/${b.dataset.borrarHora}`, { method: 'DELETE' }); aviso('Registro borrado'); alCambiar(); abrirTarea(id, alCambiar); } catch (e) { aviso(e.message, true); }
    }));
    const be = $('#b-editar', root);
    if (be) be.addEventListener('click', () => formTarea(t, !!t.personal, alCambiar));
    const bb = $('#b-borrar', root);
    if (bb) bb.addEventListener('click', async () => {
      if (bb.dataset.confirmar !== '1') { bb.dataset.confirmar = '1'; bb.textContent = '¿Seguro? Clic de nuevo'; return; }
      await api(`/api/tasks/${id}`, { method: 'DELETE' }); modal.cerrar(); aviso('Tarea eliminada'); alCambiar();
    });
  });
}

// ---------- bitácora de horas ----------
async function vistaBitacora(v) {
  if (esAdmin() && !estado.usuarios.length) await cargarUsuarios();
  const f = vistaBitacora.filtros ||= { desde: '', hasta: '', usuario: '' };
  const qs = new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString();
  const b = await api('/api/bitacora?' + qs);
  const maxSem = Math.max(1, ...b.por_semana.map((s) => s.minutos));
  v.innerHTML = `
    <div class="encabezado"><h1>Bitácora de horas</h1></div>
    <div class="filtros">
      <label class="suave">Desde <input type="date" id="b-desde" value="${esc(b.desde)}"></label>
      <label class="suave">Hasta <input type="date" id="b-hasta" value="${esc(b.hasta)}"></label>
      ${esAdmin() ? `<select id="b-usuario" aria-label="Persona"><option value="">Todo el equipo</option>${estado.usuarios.map((u) => `<option value="${u.id}"${String(u.id) === f.usuario ? ' selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="cifras">
      <div class="cifra"><div class="valor">${fmtHoras(b.esta_semana)}</div><div class="etiqueta">Esta semana</div></div>
      <div class="cifra"><div class="valor">${fmtHoras(b.total)}</div><div class="etiqueta">Total del periodo</div></div>
      <div class="cifra"><div class="valor">${fmtHoras(b.promedio_semana)}</div><div class="etiqueta">Promedio por semana trabajada</div></div>
      <div class="cifra"><div class="valor">${b.entradas.length}</div><div class="etiqueta">Registros</div></div>
    </div>
    <div class="columnas">
      <div class="tarjeta tabla-scroll"><h2>Horas por semana</h2>
        ${b.por_semana.length ? `<table><thead><tr><th>Semana</th><th>Horas</th><th></th></tr></thead><tbody>${b.por_semana.map((s) => `
          <tr><td>${fmtFecha(s.inicio)} – ${fmtFecha(s.fin)}</td><td><strong>${fmtHoras(s.horas)}</strong></td>
          <td class="celda-barra"><meter min="0" max="${maxSem}" value="${s.minutos}"></meter></td></tr>`).join('')}</tbody></table>`
    : '<p class="vacio">Sin horas registradas en este periodo.</p>'}
      </div>
      ${esAdmin() && !f.usuario ? `<div class="tarjeta tabla-scroll"><h2>Horas por persona</h2>
        ${b.por_persona.length ? `<table><thead><tr><th>Persona</th><th>Horas</th></tr></thead><tbody>${b.por_persona.map((p) => `
          <tr><td>${esc(p.nombre)}</td><td><strong>${fmtHoras(p.horas)}</strong></td></tr>`).join('')}</tbody></table>` : '<p class="vacio">Nadie ha registrado horas en este periodo.</p>'}
      </div>` : ''}
    </div>
    <div class="tarjeta tabla-scroll"><h2>Registro detallado</h2>
      ${b.entradas.length ? `<table><thead><tr><th>Fecha</th>${esAdmin() ? '<th>Persona</th>' : ''}<th>Tarea</th><th>Horas</th><th>Nota</th></tr></thead><tbody>${b.entradas.map((e) => `
        <tr class="clic" data-tarea="${e.task_id}"><td>${fmtFecha(e.fecha)}</td>${esAdmin() ? `<td>${esc(e.nombre)}</td>` : ''}
          <td>${esc(e.titulo)} ${e.personal ? chip('personal', 'Personal') : ''}</td><td><strong>${fmtHoras(e.horas)}</strong></td><td>${esc(e.nota || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="vacio">Registra horas desde el detalle de cada tarea o pendiente.</p>'}
    </div>`;
  const recargar = () => vistaBitacora(v);
  $('#b-desde').addEventListener('change', (e) => { f.desde = e.target.value; recargar(); });
  $('#b-hasta').addEventListener('change', (e) => { f.hasta = e.target.value; recargar(); });
  if ($('#b-usuario')) $('#b-usuario').addEventListener('change', (e) => { f.usuario = e.target.value; recargar(); });
  $$('[data-tarea]', v).forEach((tr) => tr.addEventListener('click', () => abrirTarea(Number(tr.dataset.tarea), recargar)));
}

// ---------- calendario ----------
async function vistaCalendario(v) {
  const c = vistaCalendario.mes ||= (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
  const primero = new Date(c.y, c.m, 1);
  const offset = (primero.getDay() + 6) % 7; // semana inicia en lunes
  const inicio = new Date(c.y, c.m, 1 - offset);
  const dias = [];
  for (let i = 0; i < 42; i++) { const d = new Date(inicio); d.setDate(inicio.getDate() + i); dias.push(d); }
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const items = await api(`/api/events?desde=${iso(dias[0])}&hasta=${iso(dias[41])}`);
  const hoy = hoyISO();
  const porDia = (dia) => items.filter((it) => it.inicio <= dia && it.fin >= dia);

  v.innerHTML = `
    <div class="encabezado"><h1>Calendario</h1>
      <div class="cal-nav"><button id="c-ant" aria-label="Mes anterior">‹</button><strong>${MESES[c.m][0].toUpperCase() + MESES[c.m].slice(1)} ${c.y}</strong><button id="c-sig" aria-label="Mes siguiente">›</button>
      <button id="c-hoy">Hoy</button><button class="primario" id="c-nuevo">+ Evento</button></div></div>
    <div class="calendario">
      ${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((n) => `<div class="dia-nombre">${n}</div>`).join('')}
      ${dias.map((d) => { const k = iso(d); const its = porDia(k); return `
        <div class="dia ${d.getMonth() !== c.m ? 'otro-mes' : ''} ${k === hoy ? 'hoy' : ''}" data-dia="${k}">
          <span class="num">${d.getDate()}</span>
          ${its.slice(0, 4).map((it) => `<button class="item-cal t-${esc(it.tipo)}" data-item="${items.indexOf(it)}" title="${esc(it.titulo)}">${it.hora ? esc(it.hora) + ' ' : ''}${esc(it.titulo)}</button>`).join('')}
          ${its.length > 4 ? `<span class="suave">+${its.length - 4} más</span>` : ''}
        </div>`; }).join('')}
    </div>
    <div class="leyenda">${[['actividad', 'Actividad'], ['reunion', 'Reunión'], ['entrega', 'Entrega / tarea'], ['festivo', 'Festivo'], ['vacaciones', 'Vacaciones'], ['cumpleanos', 'Cumpleaños'], ['incidencia', 'Incidencia']]
    .map(([k, n]) => `<span class="item-cal t-${k}">${n}</span>`).join('')}</div>
    <p class="ayuda">${esAdmin() ? 'Los eventos que crees pueden ser generales (para toda la empresa) o personales.' : 'Los eventos que crees son personales; los generales los publica el administrador.'} Haz clic en un día para agregar un evento.</p>`;

  const recargar = () => vistaCalendario(v);
  $('#c-ant').addEventListener('click', () => { c.m--; if (c.m < 0) { c.m = 11; c.y--; } recargar(); });
  $('#c-sig').addEventListener('click', () => { c.m++; if (c.m > 11) { c.m = 0; c.y++; } recargar(); });
  $('#c-hoy').addEventListener('click', () => { const d = new Date(); c.y = d.getFullYear(); c.m = d.getMonth(); recargar(); });
  $('#c-nuevo').addEventListener('click', () => formEvento(null, hoy, recargar));
  $$('[data-dia]', v).forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('[data-item]')) return; formEvento(null, el.dataset.dia, recargar); }));
  $$('[data-item]', v).forEach((el) => el.addEventListener('click', () => {
    const it = items[Number(el.dataset.item)];
    if (it.origen === 'tarea') return abrirTarea(it.id, recargar);
    if (it.origen === 'evento') return detalleEvento(it, recargar);
    modal.abrir(`<h2>${esc(it.titulo)}</h2><p>${fmtFecha(it.inicio)}${it.fin !== it.inicio ? ' al ' + fmtFecha(it.fin) : ''}</p><div class="acciones"><button data-cerrar>Cerrar</button></div>`);
  }));
}

function detalleEvento(it, alCambiar) {
  modal.abrir(`
    <h2>${esc(it.titulo)}</h2>
    <p>${chip('x', TIPO_EVENTO[it.tipo] || it.tipo)} ${it.general ? chip('x', 'General') : chip('personal', 'Personal')}</p>
    <p>${fmtFecha(it.inicio)}${it.fin !== it.inicio ? ' al ' + fmtFecha(it.fin) : ''} ${esc(it.hora || '')}</p>
    ${it.descripcion ? `<p>${esc(it.descripcion).replace(/\n/g, '<br>')}</p>` : ''}
    <div class="acciones">${it.editable ? '<button class="peligro" id="e-borrar">Eliminar</button><button id="e-editar">Editar</button>' : ''}<button data-cerrar>Cerrar</button></div>`,
  (root) => {
    if (!it.editable) return;
    $('#e-editar', root).addEventListener('click', () => formEvento(it, it.inicio, alCambiar));
    const bb = $('#e-borrar', root);
    bb.addEventListener('click', async () => {
      if (bb.dataset.confirmar !== '1') { bb.dataset.confirmar = '1'; bb.textContent = '¿Seguro? Clic de nuevo'; return; }
      await api(`/api/events/${it.id}`, { method: 'DELETE' }); modal.cerrar(); aviso('Evento eliminado'); alCambiar();
    });
  });
}

function formEvento(it, dia, alGuardar) {
  modal.abrir(`
    <h2>${it ? 'Editar' : 'Nuevo'} evento</h2>
    <form id="f-evento">
      <div class="campo"><label for="e-ti">Título</label><input id="e-ti" name="titulo" required maxlength="200" value="${esc(it?.titulo)}"></div>
      <div class="fila">
        <div class="campo"><label for="e-tp">Tipo</label><select id="e-tp" name="tipo">${opciones(TIPO_EVENTO, it?.tipo || 'actividad')}</select></div>
        <div class="campo"><label for="e-ho">Hora (opcional)</label><input id="e-ho" type="time" name="hora" value="${esc(it?.hora)}"></div>
      </div>
      <div class="fila">
        <div class="campo"><label for="e-fi">Fecha</label><input id="e-fi" type="date" name="fecha_inicio" required value="${esc(it?.inicio || dia)}"></div>
        <div class="campo"><label for="e-ff">Hasta (opcional)</label><input id="e-ff" type="date" name="fecha_fin" value="${it && it.fin !== it.inicio ? esc(it.fin) : ''}"></div>
      </div>
      <div class="campo"><label for="e-de">Descripción</label><textarea id="e-de" name="descripcion">${esc(it?.descripcion)}</textarea></div>
      ${esAdmin() ? `<div class="campo check"><input type="checkbox" id="e-ge" name="general"${!it || it.general ? ' checked' : ''}><label for="e-ge">Visible para toda la empresa</label></div>` : ''}
      <div class="error"></div>
      <div class="acciones"><button type="button" data-cerrar>Cancelar</button><button class="primario" type="submit">Guardar</button></div>
    </form>`, (root) => {
    alEnviar($('#f-evento', root), async (d) => {
      if (it) await api(`/api/events/${it.id}`, { method: 'PUT', body: d });
      else await api('/api/events', { method: 'POST', body: d });
      modal.cerrar(); aviso('Evento guardado'); alGuardar();
    });
  });
}

// ---------- incidencias ----------
async function vistaIncidencias(v) {
  const f = vistaIncidencias.filtros ||= { estado: '', mias: '' };
  const qs = new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString();
  const lista = await api('/api/incidents?' + qs);
  const verTodos = esAdmin() && f.mias !== '1';
  v.innerHTML = `
    <div class="encabezado"><h1>Incidencias y solicitudes</h1><button class="primario" id="b-sol">+ Nueva solicitud</button></div>
    <div class="filtros">
      <select id="i-es" aria-label="Estado"><option value="">Cualquier estado</option>${opciones(ESTADO_INC, f.estado)}</select>
      ${esAdmin() ? `<select id="i-mias" aria-label="De quién"><option value="">Todo el equipo</option><option value="1"${f.mias === '1' ? ' selected' : ''}>Solo las mías</option></select>` : ''}
    </div>
    <div class="tarjeta tabla-scroll">
      <table><thead><tr>${verTodos ? '<th>Colaborador</th>' : ''}<th>Tipo</th><th>Fechas</th><th>Motivo</th><th>Estado</th><th></th></tr></thead>
      <tbody>${lista.length ? lista.map((i) => `
        <tr>${verTodos ? `<td>${esc(i.nombre)}</td>` : ''}
          <td>${esc(TIPO_INC[i.tipo])}</td>
          <td>${fmtFecha(i.fecha_inicio)}${i.fecha_fin && i.fecha_fin !== i.fecha_inicio ? ' al ' + fmtFecha(i.fecha_fin) : ''}</td>
          <td>${esc(i.motivo)}${i.comentario_revision ? `<br><span class="suave">Respuesta: ${esc(i.comentario_revision)}</span>` : ''}</td>
          <td>${chip(i.estado, ESTADO_INC[i.estado])}${i.revisado_por_nombre ? `<br><span class="ayuda">por ${esc(i.revisado_por_nombre)}</span>` : ''}</td>
          <td>${i.estado === 'pendiente' && esAdmin() ? `<button class="chico" data-revisar="${i.id}">Revisar</button>` : ''}
              ${i.estado === 'pendiente' && i.user_id === estado.yo.id ? `<button class="chico peligro" data-cancelar="${i.id}">Cancelar</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="vacio">No hay solicitudes.</td></tr>`}
      </tbody></table></div>`;
  const recargar = () => vistaIncidencias(v);
  $('#i-es').addEventListener('change', (e) => { f.estado = e.target.value; recargar(); });
  if ($('#i-mias')) $('#i-mias').addEventListener('change', (e) => { f.mias = e.target.value; recargar(); });
  $('#b-sol').addEventListener('click', () => formIncidencia(recargar));
  $$('[data-revisar]', v).forEach((b) => b.addEventListener('click', () => revisarIncidencia(lista.find((i) => i.id === Number(b.dataset.revisar)), recargar)));
  $$('[data-cancelar]', v).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro?'; return; }
    try { await api(`/api/incidents/${b.dataset.cancelar}/cancelar`, { method: 'POST' }); aviso('Solicitud cancelada'); recargar(); } catch (e) { aviso(e.message, true); }
  }));
}

function formIncidencia(alGuardar) {
  modal.abrir(`
    <h2>Nueva solicitud o reporte</h2>
    <form id="f-inc">
      <div class="campo"><label for="i-tp">Tipo</label><select id="i-tp" name="tipo">${opciones(TIPO_INC, 'home_office')}</select></div>
      <div class="fila">
        <div class="campo"><label for="i-fi">Fecha</label><input id="i-fi" type="date" name="fecha_inicio" required value="${hoyISO()}"></div>
        <div class="campo"><label for="i-ff">Hasta (opcional)</label><input id="i-ff" type="date" name="fecha_fin"></div>
      </div>
      <div class="campo"><label for="i-mo">Motivo o detalle</label><textarea id="i-mo" name="motivo" maxlength="2000"></textarea></div>
      <div class="error"></div>
      <div class="acciones"><button type="button" data-cerrar>Cancelar</button><button class="primario" type="submit">Enviar</button></div>
    </form>`, (root) => {
    alEnviar($('#f-inc', root), async (d) => { await api('/api/incidents', { method: 'POST', body: d }); modal.cerrar(); aviso('Solicitud enviada'); alGuardar(); });
  });
}

function revisarIncidencia(i, alGuardar) {
  modal.abrir(`
    <h2>Revisar solicitud</h2>
    <p><strong>${esc(i.nombre)}</strong> · ${esc(TIPO_INC[i.tipo])}<br>
      ${fmtFecha(i.fecha_inicio)}${i.fecha_fin && i.fecha_fin !== i.fecha_inicio ? ' al ' + fmtFecha(i.fecha_fin) : ''}</p>
    ${i.motivo ? `<p>${esc(i.motivo)}</p>` : ''}
    <form id="f-rev">
      <div class="campo"><label for="r-co">Comentario (opcional)</label><textarea id="r-co" name="comentario"></textarea></div>
      <div class="error"></div>
      <div class="acciones"><button type="button" data-cerrar>Cancelar</button>
        <button type="button" class="peligro" data-dec="rechazada">Rechazar</button>
        <button type="button" class="primario" data-dec="aprobada">Aprobar</button></div>
    </form>`, (root) => {
    $$('[data-dec]', root).forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/incidents/${i.id}/revisar`, { method: 'POST', body: { estado: b.dataset.dec, comentario: $('#r-co', root).value } });
        modal.cerrar(); aviso(b.dataset.dec === 'aprobada' ? 'Solicitud aprobada' : 'Solicitud rechazada'); alGuardar();
      } catch (e) { $('.error', root).textContent = e.message; }
    }));
  });
}

// ---------- directorio y usuarios ----------
async function vistaDirectorio(v) {
  const us = await cargarUsuarios();
  const admin = esAdmin();
  v.innerHTML = `
    <div class="encabezado"><h1>Directorio de empleados</h1>${admin ? '<button class="primario" id="b-nuevo">+ Nuevo usuario</button>' : ''}</div>
    <div class="tarjeta tabla-scroll">
      <table><thead><tr><th>Nombre</th><th>Puesto</th><th>Departamento</th><th>Ingreso</th><th>Cumpleaños</th><th>Contacto</th>${admin ? '<th>Usuario</th><th>Rol</th>' : ''}</tr></thead>
      <tbody>${us.map((u) => `
        <tr class="${admin ? 'clic' : ''} ${u.activo === 0 ? 'hecha' : ''}" data-usuario="${u.id}">
          <td><span class="titulo">${esc(u.nombre)}</span>${u.activo === 0 ? ' ' + chip('cancelada', 'Inactivo') : ''}</td>
          <td>${esc(u.puesto)}</td><td>${esc(u.departamento)}</td><td>${fmtFecha(u.fecha_ingreso)}</td>
          <td>${u.cumpleanos ? `${Number(u.cumpleanos.slice(8))} de ${MESES[Number(u.cumpleanos.slice(5, 7)) - 1]}` : ''}</td>
          <td>${esc(u.email)}${u.telefono ? '<br>' + esc(u.telefono) : ''}</td>
          ${admin ? `<td>${esc(u.username)}</td><td>${u.rol === 'admin' ? 'Administrador' : 'Colaborador'}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>
    ${admin ? '<p class="ayuda">Haz clic en una persona para editar sus datos, cambiar su rol, restablecer su contraseña o desactivar su cuenta.</p>' : ''}`;
  if (!admin) return;
  const recargar = () => vistaDirectorio(v);
  $('#b-nuevo').addEventListener('click', () => formUsuario(null, recargar));
  $$('[data-usuario]', v).forEach((tr) => tr.addEventListener('click', () => formUsuario(us.find((u) => u.id === Number(tr.dataset.usuario)), recargar)));
}

function formUsuario(u, alGuardar) {
  modal.abrir(`
    <h2>${u ? 'Editar usuario' : 'Nuevo usuario'}</h2>
    <form id="f-usr">
      <div class="fila">
        <div class="campo"><label for="u-no">Nombre completo</label><input id="u-no" name="nombre" required value="${esc(u?.nombre)}"></div>
        <div class="campo"><label for="u-ro">Rol</label><select id="u-ro" name="rol">${opciones({ empleado: 'Colaborador', admin: 'Administrador' }, u?.rol || 'empleado')}</select></div>
      </div>
      ${u ? '' : `<div class="campo"><label for="u-us">Usuario</label><input id="u-us" name="username" required autocomplete="off">
        <span class="ayuda">La contraseña provisional será el mismo usuario. La persona tendrá que cambiarla la primera vez que entre.</span></div>`}
      <div class="fila">
        <div class="campo"><label for="u-pu">Puesto</label><input id="u-pu" name="puesto" value="${esc(u?.puesto)}"></div>
        <div class="campo"><label for="u-de">Departamento</label><input id="u-de" name="departamento" value="${esc(u?.departamento)}"></div>
      </div>
      <div class="fila">
        <div class="campo"><label for="u-em">Correo</label><input id="u-em" type="email" name="email" value="${esc(u?.email)}"></div>
        <div class="campo"><label for="u-te">Teléfono</label><input id="u-te" name="telefono" value="${esc(u?.telefono)}"></div>
      </div>
      <div class="fila">
        <div class="campo"><label for="u-fi">Fecha de ingreso</label><input id="u-fi" type="date" name="fecha_ingreso" value="${esc(u?.fecha_ingreso)}"></div>
        <div class="campo"><label for="u-cu">Fecha de nacimiento</label><input id="u-cu" type="date" name="cumpleanos" value="${esc(u?.cumpleanos)}"></div>
      </div>
      ${u ? `<div class="campo check"><input type="checkbox" id="u-ac" name="activo"${u.activo ? ' checked' : ''}><label for="u-ac">Cuenta activa (puede iniciar sesión)</label></div>` : ''}
      <div class="error"></div>
      <div class="acciones">${u ? '<button type="button" id="u-reset">Restablecer contraseña</button>' : ''}<button type="button" data-cerrar>Cancelar</button><button class="primario" type="submit">Guardar</button></div>
    </form>`, (root) => {
    alEnviar($('#f-usr', root), async (d) => {
      if (u) await api(`/api/users/${u.id}`, { method: 'PUT', body: d });
      else await api('/api/users', { method: 'POST', body: d });
      modal.cerrar(); aviso('Usuario guardado'); alGuardar();
    });
    if (u) $('#u-reset', root).addEventListener('click', () => {
      modal.abrir(`
        <h2>Restablecer contraseña de ${esc(u.nombre)}</h2>
        <p>Su contraseña volverá a ser su usuario, <strong>${esc(u.username)}</strong>, y tendrá que cambiarla al entrar. Se cerrarán sus sesiones abiertas.</p>
        <div class="error"></div>
        <div class="acciones"><button type="button" data-cerrar>Cancelar</button><button class="primario" type="button" id="r-ok">Restablecer</button></div>`,
      (r2) => $('#r-ok', r2).addEventListener('click', async () => {
        try { await api(`/api/users/${u.id}/password`, { method: 'POST', body: {} }); modal.cerrar(); aviso('Contraseña restablecida'); } catch (e) { $('.error', r2).textContent = e.message; }
      }));
    });
  });
}

// ---------- perfil ----------
async function vistaPerfil(v) {
  const yo = await api('/api/me');
  v.innerHTML = `
    <h1>Mi perfil</h1>
    <div class="columnas">
      <div class="tarjeta">
        <h2>Mis datos</h2>
        <p><strong>${esc(yo.nombre)}</strong><br><span class="suave">${esc(yo.puesto || '')}${yo.departamento ? ' · ' + esc(yo.departamento) : ''}</span><br>
          <span class="suave">Usuario: ${esc(yo.username)} · ${yo.rol === 'admin' ? 'Administrador' : 'Colaborador'}</span>
          ${yo.fecha_ingreso ? `<br><span class="suave">Ingreso: ${fmtFecha(yo.fecha_ingreso)}</span>` : ''}</p>
        <form id="f-perfil">
          <div class="campo"><label for="p-em">Correo</label><input id="p-em" type="email" name="email" value="${esc(yo.email)}"></div>
          <div class="campo"><label for="p-te">Teléfono</label><input id="p-te" name="telefono" value="${esc(yo.telefono)}"></div>
          <div class="campo"><label for="p-cu">Fecha de nacimiento</label><input id="p-cu" type="date" name="cumpleanos" value="${esc(yo.cumpleanos)}"></div>
          <div class="error"></div>
          <div class="acciones"><button class="primario" type="submit">Guardar</button></div>
        </form>
      </div>
      <div class="tarjeta">
        <h2>Cambiar contraseña</h2>
        <form id="f-pass">
          <div class="campo"><label for="p-ac">Contraseña actual</label><input id="p-ac" type="password" name="actual" required autocomplete="current-password"></div>
          <div class="campo"><label for="p-nu">Nueva contraseña</label><input id="p-nu" type="password" name="nueva" required autocomplete="new-password"><span class="ayuda">Mínimo 8 caracteres, con letras y números.</span></div>
          <div class="campo"><label for="p-co">Confirmar nueva contraseña</label><input id="p-co" type="password" name="confirmar" required autocomplete="new-password"></div>
          <div class="error"></div>
          <div class="acciones"><button class="primario" type="submit">Cambiar contraseña</button></div>
        </form>
      </div>
    </div>`;
  alEnviar($('#f-perfil'), async (d) => { await api('/api/me', { method: 'PUT', body: d }); aviso('Datos guardados'); });
  alEnviar($('#f-pass'), async (d) => {
    if (d.nueva !== d.confirmar) throw new Error('Las contraseñas nuevas no coinciden.');
    await api('/api/me/password', { method: 'POST', body: d });
    $('#f-pass').reset(); aviso('Contraseña actualizada');
  });
}

// ---------- configuración ----------
async function vistaConfiguracion(v) {
  const s = await api('/api/settings');
  v.innerHTML = `
    <h1>Configuración de la empresa</h1>
    <div class="tarjeta">
      <form id="f-conf">
        <div class="campo"><label for="c-em">Nombre de la empresa</label><input id="c-em" name="nombre_empresa" required value="${esc(s.nombre_empresa)}"></div>
        <div class="campo check"><input type="checkbox" id="c-pp" name="admin_ve_pendientes_personales"${s.admin_ve_pendientes_personales === '1' ? ' checked' : ''}>
          <label for="c-pp">Los administradores pueden ver (sin modificar) los pendientes personales de los empleados</label></div>
        <p class="ayuda">Según la política de privacidad de tu empresa. Desactivado, cada pendiente personal solo lo ve su dueño.</p>
        <div class="error"></div>
        <div class="acciones"><button class="primario" type="submit">Guardar</button></div>
      </form>
    </div>`;
  alEnviar($('#f-conf'), async (d) => { await api('/api/settings', { method: 'PUT', body: d }); aviso('Configuración guardada'); estado.yo.empresa = d.nombre_empresa; $('.marca').firstChild.textContent = d.nombre_empresa; });
}

iniciar();
