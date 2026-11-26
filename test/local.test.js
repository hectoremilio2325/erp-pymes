// Prueba con la base SQLite local (archivo)
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ERP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-test-'));
delete process.env.GOOGLE_SHEET_ID;
const app = require('../src/app');
const { db } = require('../src/db');
const { escenario, iniciar } = require('./escenario');

test('modo archivo local: flujo completo con permisos', async () => {
  const { server, base } = await iniciar(app);
  try {
    await escenario(base, async (u) => (await db.get('SELECT password_hash FROM users WHERE username = ?', u)).password_hash);
  } finally { server.close(); }
});
