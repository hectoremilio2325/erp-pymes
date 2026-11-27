# ERP PyMES · Control interno

Aplicación web para que una PyME organice sus actividades, dé seguimiento a las responsabilidades de cada colaborador y lleve su control interno.

## Qué incluye (versión 0.1)

- **Inicio de sesión y perfiles:** cuentas individuales con contraseña (guardada con hash scrypt y sal), sesiones que expiran a los 7 días, bloqueo temporal tras 5 intentos fallidos. Dos roles: Administrador y Colaborador.
- **Directorio de empleados (solo administrador):** nombre, puesto, departamento, fecha de ingreso, cumpleaños y contacto. Solo el administrador ve a los colaboradores; crea usuarios, cambia roles, restablece contraseñas y desactiva cuentas.
- **Mi perfil:** cada persona actualiza su correo, teléfono y cumpleaños, y cambia su contraseña.
- **Tareas y pendientes:** el administrador asigna tareas a una o varias personas con prioridad y fecha límite. Cada persona crea sus pendientes personales. Los responsables actualizan el estado y dejan comentarios de avance. Cada tarea guarda su historial de cambios.
- **Bitácora de horas:** en cada tarea o pendiente se registra el tiempo que tomó (fecha, tiempo y nota). El tiempo se escribe como horas.minutos: de 0.01 (1 minuto) a 99.59; por ejemplo 1.30 = 1 hora 30 minutos. Las sumas respetan los minutos (0.45 + 0.45 = 1.30). La bitácora muestra el total del periodo, las horas de la semana actual, las horas por semana y el registro detallado. Cada persona ve sus horas; el administrador ve las de todo el equipo y puede filtrar por persona.
- **Calendario:** vista mensual con actividades, reuniones, entregas, días festivos, vacaciones aprobadas, cumpleaños y fechas límite de tareas.
- **Incidencias:** solicitudes de Home Office, permisos, ausencias y vacaciones, y reportes de retardos u otras incidencias. El administrador las aprueba o rechaza con un comentario.
- **Panel principal:** resumen de tareas abiertas, vencidas y por vencer, próximas actividades y solicitudes en espera. El administrador ve además el avance de cada colaborador.
- **Configuración:** nombre de la empresa y si el administrador puede ver (solo lectura) los pendientes personales.

## Privacidad (según el documento del proyecto)

- Una tarea asignada solo la ven sus responsables y el administrador.
- Un pendiente personal solo lo ve su dueño. El administrador puede verlo sin modificarlo únicamente si se activa en Configuración.
- Un colaborador solo ve sus propias incidencias. De las incidencias aprobadas, solo las vacaciones aparecen en el calendario de todos.
- Los eventos que crea un colaborador son personales. Los generales los publica el administrador.

## Base de datos

La app elige la base de datos según las variables de entorno:

1. **Google Sheets** (`GOOGLE_SHEET_ID`): un archivo de Google Sheets es la base de datos, con una hoja por módulo (Usuarios, Tareas, Pendientes, Responsables, Historial_Tareas, Horas, Calendario, Incidencias, Configuracion, Sesiones e Intentos_Login). Es el modo que se usa en Vercel. En cada solicitud la app lee el archivo y escribe solo las filas que cambiaron.
2. **Turso** (`TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`): SQLite en la nube.
3. **Archivo local**: si no defines nada, se usa `data/erp.db` en tu computadora. Sirve para probar la app sin configurar nada.

Las contraseñas se guardan siempre con hash scrypt y los tokens de sesión con hash SHA-256, así que ni en el archivo ni en la base aparecen en texto.

### Conectar Google Sheets

1. En Google Cloud crea un proyecto, habilita la API de Google Sheets y crea una cuenta de servicio con una clave JSON.
2. Comparte el archivo de Google Sheets con el correo de la cuenta de servicio, como Editor.
3. Define estas variables (en Vercel: Settings > Environment Variables):
   - `GOOGLE_SHEET_ID`: el id del archivo (lo que va entre `/d/` y `/edit` en su URL).
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: el contenido completo del archivo .json de la clave.

No cambies los nombres de las hojas ni los encabezados de la fila 1. Puedes reordenar columnas o agregar columnas propias; la app solo toca las suyas.

## Cómo usarla en tu computadora

Requisito: [Node.js](https://nodejs.org) 20 o más reciente.

```bash
npm install
npm start
```

Abre http://localhost:3000. La primera vez te pedirá el nombre de la empresa y creará la cuenta del administrador.

Opciones (variables de entorno): `PORT` (por defecto 3000), `HOST` (por defecto `127.0.0.1`; usa `0.0.0.0` para abrirla a la red de la oficina) y `ERP_DATA_DIR` (carpeta del archivo local).

## Publicar en Vercel

El repositorio ya trae `vercel.json`: la interfaz se sirve desde `public/` y la API corre como función en `api/index.js`. Importa el repositorio en Vercel, define las variables de Google Sheets y despliega.

## Pruebas

```bash
npm test
```

Prueban el inicio de sesión, el hash de contraseñas, los permisos por rol, la privacidad de tareas e incidencias, el calendario y el panel, con el archivo local y con Google Sheets (contra un servidor falso en memoria).

## Estructura

```
src/app.js      API y servidor web (Express)
src/server.js   Arranque en tu computadora
api/index.js    Arranque en Vercel
src/db.js       Esquema y modos de base de datos
src/sheets.js   Lectura y escritura en Google Sheets
src/auth.js     Contraseñas, sesiones y permisos
public/         Interfaz (HTML, CSS y JavaScript)
test/           Pruebas automáticas
```

## Siguientes módulos sugeridos

Registro de horas trabajadas, control de entregables con archivos adjuntos, y reportes exportables.
