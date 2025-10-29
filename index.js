const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/status', (req, res) => {
  res.send({ status: 'ok', time: new Date() });
});

app.use('/', createProxyMiddleware({
  target: 'https://arkaios-gateway-open.onrender.com',
  changeOrigin: true
}));

app.listen(PORT, () => {
  console.log(`Proxy escuchando en http://localhost:${PORT}`);
});
