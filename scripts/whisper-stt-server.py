#!/usr/bin/env python3
"""
Whisper STT microservice — runs on port 3014
POST /transcribe  { audio: binary }  → { text }
GET  /models                          → available models
"""
import os
import io
import json
import subprocess
import numpy as np
import torch
import warnings
warnings.filterwarnings('ignore')

from faster_whisper import WhisperModel

PORT = 3014
# Bind to loopback by default: this service has no authentication and turns
# audio into text, so it should never be reachable from the public internet.
# The gateway proxies to it over 127.0.0.1. Override with HIVV_STT_HOST=0.0.0.0
# only if a remote node genuinely needs to reach it.
HOST = os.environ.get('HIVV_STT_HOST', '127.0.0.1')

print(f"[WhisperSTT] Starting on port {PORT} (host {HOST})...", flush=True)
print(f"[WhisperSTT] CUDA available: {torch.cuda.is_available()}", flush=True)

model_size = os.environ.get('WHISPER_MODEL', 'base')
device = 'cpu'
compute_type = 'int8'
# long interviews: ffmpeg decode budget (was 30s — killed anything over ~5 min of audio)
DECODE_TIMEOUT_S = int(os.environ.get('WHISPER_DECODE_TIMEOUT_S', '900'))

print(f"[WhisperSTT] Loading model: {model_size} on {device}...", flush=True)
model = WhisperModel(model_size, device=device, compute_type=compute_type)
print(f"[WhisperSTT] ✅ Model loaded", flush=True)

AVAILABLE_MODELS = [
    {'id': 'tiny', 'name': 'Tiny', 'params': '39M', 'lang': 'multilingual'},
    {'id': 'base', 'name': 'Base', 'params': '74M', 'lang': 'multilingual'},
    {'id': 'small', 'name': 'Small', 'params': '244M', 'lang': 'multilingual'},
    {'id': 'medium', 'name': 'Medium', 'params': '769M', 'lang': 'multilingual'},
    {'id': 'large-v3', 'name': 'Large v3', 'params': '1550M', 'lang': 'multilingual'},
]

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import urllib.parse

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print(f"[WhisperSTT] {args[0]}", flush=True)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/voices' or self.path == '/models':
            self.send_json({'models': AVAILABLE_MODELS})
        elif self.path == '/health':
            self.send_json({'status': 'healthy', 'model': model_size, 'cuda': torch.cuda.is_available()})
        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        if self.path.startswith('/transcribe'):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            use_vad = 'vad=0' not in self.path and 'interim=1' not in self.path and 'interim=true' not in self.path
            # ?lang=ur  → force a language; absent → auto-detect (multilingual interviews)
            lang = (qs.get('lang', [None])[0] or '').strip().lower() or None
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                return self.send_json({'error': 'No audio data'}, 400)

            audio_data = self.rfile.read(content_length)
            print(f"[WhisperSTT] Received {len(audio_data)} bytes, VAD={use_vad}, lang={lang or 'auto'}", flush=True)

            try:
                p = subprocess.run(
                    # no -f: auto-probe the container so wav/mp3/m4a/webm/ogg all work
                    ['ffmpeg', '-y', '-hide_banner',
                     '-i', 'pipe:0',
                     '-ar', '16000', '-ac', '1',
                     '-acodec', 'pcm_s16le',
                     '-f', 's16le', 'pipe:1'],
                    input=audio_data, capture_output=True, timeout=DECODE_TIMEOUT_S
                )
                if p.returncode != 0:
                    print(f"[WhisperSTT] ffmpeg error: {p.stderr.decode()[:500]}", flush=True)
                    return self.send_json({'error': 'Audio decode failed'}, 500)

                audio_int16 = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0

                if len(audio_int16) < 480:
                    return self.send_json({'text': ''})

                vad_params = dict(min_silence_duration_ms=500) if use_vad else dict(min_silence_duration_ms=999999)
                segments, info = model.transcribe(
                    audio_int16,
                    language=lang,  # None → auto-detect (Urdu/Hindi/Punjabi/… interviews)
                    vad_filter=use_vad,
                    vad_parameters=vad_params,
                    condition_on_previous_text=False,
                )
                text = ' '.join(segment.text for segment in segments).strip()
                print(f"[WhisperSTT] Transcribed ({info.language}, {info.language_probability:.0%}): {text[:80]}...", flush=True)
                self.send_json({'text': text, 'language': info.language})
            except subprocess.TimeoutExpired:
                print(f"[WhisperSTT] ffmpeg timeout", flush=True)
                self.send_json({'error': 'Timeout'}, 500)
            except Exception as e:
                print(f"[WhisperSTT] Error: {e}", flush=True)
                self.send_json({'error': str(e)}, 500)
        else:
            self.send_json({'error': 'Not found'}, 404)

if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"[WhisperSTT] 🖥️  Listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
