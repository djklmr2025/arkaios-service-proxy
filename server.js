const express = require('express');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware de logging
app.use(morgan('dev'));

// Ruta raíz
app.get('/', (req, res) => {
  res.send('ARKAIOS Proxy está activo ✅');
});

// Ruta de salud
app.get('/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Manejo de rutas no encontradas
app.use((req, res, next) => {
  res.status(404).json({ error: 'Ruta no encontrada ❌' });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('🚨 Error:', err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
