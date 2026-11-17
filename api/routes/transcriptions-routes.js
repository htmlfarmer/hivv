// api/routes/transcriptions-routes.js — OpenAI-compatible speech-to-text.
//
//   POST /v1/audio/transcriptions
//     multipart/form-data: file=<audio>, model=whisper-1, language=en,
//                          response_format=json|text|verbose_json
//     → { "text": "..." }            (json)
//     → "..."                        (text)
//     → { "text", "language" }       (verbose_json)
//
// This is the endpoint OpenAI-compatible clients expect, and it is what the
// Helpable API's transcription client calls. It forwards to the local
// Whisper server on port 3014, so audio never leaves this machine.

const express = require('express');
const router = express.Router();
const http = require('http');

const STT_HOST = '127.0.0.1';
const STT_PORT = 3014;
const MAX_BYTES = 50 * 1024 * 1024;

// Parse multipart/form-data without pulling in a heavier dependency: we only
// need the `file` part and a couple of scalar fields.
function parseMultipart(buffer, boundary) {
    const parts = {};
    const delimiter = Buffer.from(`--${boundary}`);
    let index = buffer.indexOf(delimiter);
    if (index === -1) return parts;

    while (index !== -1) {
        const start = index + delimiter.length;
        if (buffer.slice(start, start + 2).toString() === '--') break;
        const headerEnd = buffer.indexOf('\r\n\r\n', start);
        if (headerEnd === -1) break;
        const headers = buffer.slice(start, headerEnd).toString('utf8');
        const next = buffer.indexOf(delimiter, headerEnd);
        if (next === -1) break;
        // Trim the CRLF that precedes the next boundary.
        const body = buffer.slice(headerEnd + 4, next - 2);

        const nameMatch = /name="([^"]+)"/i.exec(headers);
        const filenameMatch = /filename="([^"]*)"/i.exec(headers);
        if (nameMatch) {
            parts[nameMatch[1]] = filenameMatch
                ? { filename: filenameMatch[1], data: body }
                : body.toString('utf8');
        }
        index = next;
    }
    return parts;
}

function forwardToWhisper(audioBuffer, language) {
    return new Promise((resolve, reject) => {
        const path = `/transcribe${language ? `?lang=${encodeURIComponent(language)}` : ''}`;
        const req = http.request({
            hostname: STT_HOST,
            port: STT_PORT,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': audioBuffer.length,
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error('Whisper returned a non-JSON response'));
                }
            });
        });
        req.on('error', reject);
        req.end(audioBuffer);
    });
}

router.post('/transcriptions', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    const contentType = req.headers['content-type'] || '';
    let audio = null;
    let language = null;
    let responseFormat = 'json';

    if (contentType.includes('multipart/form-data')) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BYTES) {
                return res.status(413).json({ error: { message: 'Audio file too large (max 50MB)', type: 'invalid_request_error' } });
            }
            chunks.push(chunk);
        }
        const boundaryMatch = /boundary=("?)([^";]+)\1/i.exec(contentType);
        if (!boundaryMatch) {
            return res.status(400).json({ error: { message: 'Missing multipart boundary', type: 'invalid_request_error' } });
        }
        const parts = parseMultipart(Buffer.concat(chunks), boundaryMatch[2]);
        const file = parts.file;
        if (!file || !file.data || !file.data.length) {
            return res.status(400).json({ error: { message: 'No audio data provided', type: 'invalid_request_error' } });
        }
        audio = file.data;
        if (parts.language) language = String(parts.language).trim().slice(0, 8);
        if (parts.response_format) responseFormat = String(parts.response_format).trim();
    } else {
        // Raw body — the same shape /api/stt accepts.
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BYTES) {
                return res.status(413).json({ error: { message: 'Audio file too large (max 50MB)', type: 'invalid_request_error' } });
            }
            chunks.push(chunk);
        }
        audio = Buffer.concat(chunks);
        if (!audio.length) {
            return res.status(400).json({ error: { message: 'No audio data provided', type: 'invalid_request_error' } });
        }
        if (req.query.language) language = String(req.query.language).trim().slice(0, 8);
        if (req.query.response_format) responseFormat = String(req.query.response_format).trim();
    }

    try {
        const result = await forwardToWhisper(audio, language);
        if (result.error) {
            return res.status(502).json({ error: { message: `Transcription failed: ${result.error}`, type: 'server_error' } });
        }
        const text = result.text || '';
        if (responseFormat === 'text') {
            return res.type('text/plain').send(text);
        }
        if (responseFormat === 'verbose_json') {
            return res.json({ text, language: result.language || null });
        }
        return res.json({ text });
    } catch (err) {
        return res.status(503).json({ error: { message: `Speech-to-text unavailable: ${err.message}`, type: 'server_error' } });
    }
});

module.exports = router;
