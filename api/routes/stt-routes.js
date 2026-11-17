// api/routes/stt-routes.js — Speech-to-Text proxy → forwards to Whisper server on port 3014

const express = require('express');
const router = express.Router();
const http = require('http');

const STT_HOST = '127.0.0.1';
const STT_PORT = 3014;

// GET /api/stt/models — list available models
router.get('/models', (req, res) => {
  const options = {
    hostname: STT_HOST,
    port: STT_PORT,
    path: '/models',
    method: 'GET'
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/json');
      res.status(proxyRes.statusCode).send(data);
    });
  });

  proxyReq.on('error', () => {
    res.json({ models: [], error: 'STT service unavailable' });
  });

  proxyReq.end();
});

// POST /api/stt — transcribe audio
// Body: raw audio binary (webm, wav, mp3)
// Returns: { text: string }
router.post('/', (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'], 10) || 0;

  if (contentLength === 0) {
    return res.status(400).json({ error: 'No audio data provided' });
  }

  if (contentLength > 50 * 1024 * 1024) {
    return res.status(413).json({ error: 'Audio file too large (max 50MB)' });
  }

  const options = {
    hostname: STT_HOST,
    port: STT_PORT,
    path: '/transcribe',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': contentLength
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/json');
      res.status(proxyRes.statusCode).send(data);
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[STT] Proxy error:', err.message);
    res.status(503).json({ error: 'STT service temporarily unavailable' });
  });

  req.pipe(proxyReq);
});

module.exports = router;
