// Arranca el servidor en tu computadora: npm start
const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`ERP PyMES listo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
