// api/routes/tts-routes.js — Text-to-Speech proxy → forwards to Kokoro Python server on port 3013

const express = require('express');
const router = express.Router();
const http = require('http');

const TTS_HOST = '127.0.0.1';
const TTS_PORT = 3013;

// GET /api/tts/voices — list available voices (proxied from Python server)
router.get('/voices', (req, res) => {
  const options = {
    hostname: TTS_HOST,
    port: TTS_PORT,
    path: '/voices',
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

  proxyReq.on('error', (err) => {
    console.error('[TTS] Voices proxy error:', err.message);
    // Fallback: return hardcoded voices if Python server is down
    res.json({
      voices: [
        { id: 'af_sarah',  name: 'Sarah',  desc: 'Bright & cheerful' },
        { id: 'af_bella',  name: 'Bella',  desc: 'Warm & friendly' },
        { id: 'af_nicole', name: 'Nicole', desc: 'Calm & professional' },
        { id: 'af_nova',   name: 'Nova',   desc: 'Clear & upbeat' },
      ],
      default: 'af_sarah',
      languages: {}
    });
  });

  proxyReq.end();
});

// POST /api/tts — generate TTS audio
// Body: { text: string, voice?: string, speed?: number, lang?: string }
// Returns: audio/wav stream
//
// `lang` is a Kokoro language code (a American English, b British, e Spanish,
// f French, h Hindi, i Italian, p Portuguese, z Mandarin, j Japanese). The
// voice is validated against that language by the Python service, so an
// unknown voice falls back to the language's first voice rather than
// silently switching language.
router.post('/', (req, res, next) => {
  const { text, voice = 'af_sarah', speed = 1.0, lang = 'a' } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "text" field' });
  }

  const cleanText = text.slice(0, 5000);
  const clampedSpeed = Math.max(0.5, Math.min(2.0, parseFloat(speed) || 1.0));
  const safeLang = /^[a-z]$/i.test(String(lang)) ? String(lang).toLowerCase() : 'a';
  const safeVoice = typeof voice === 'string' && voice ? voice.slice(0, 40) : 'af_sarah';

  const postData = JSON.stringify({
    text: cleanText,
    voice: safeVoice,
    speed: clampedSpeed,
    lang: safeLang
  });

  const options = {
    hostname: TTS_HOST,
    port: TTS_PORT,
    path: '/tts',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.set({
      'Content-Type': 'audio/wav',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'X-TTS-Voice': safeVoice,
      'X-TTS-Speed': clampedSpeed.toString()
    });

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[TTS] Proxy error:', err.message);
    res.status(503).json({ error: 'TTS service temporarily unavailable' });
  });

  proxyReq.write(postData);
  proxyReq.end();
});

module.exports = router;
