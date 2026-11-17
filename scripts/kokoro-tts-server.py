#!/usr/bin/env python3
"""
Kokoro TTS microservice — runs on port 3012
POST /tts  { text, voice, speed }  → audio/wav
GET  /voices                           → available voices
"""
import os
import sys
import io
import wave
import json
import threading
import warnings
warnings.filterwarnings('ignore')

# Suppress torch warnings before importing kokoro
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

from kokoro import KPipeline
import torch

PORT = 3013

print(f"[KokoroTTS] Starting on port {PORT}...", flush=True)
print(f"[KokoroTTS] CUDA available: {torch.cuda.is_available()}", flush=True)

# Pipelines are per-language and created lazily — a KPipeline holds a
# tokenizer/voice set for one language, and loading them all up front would
# cost seconds of start-up and VRAM for nothing.
_pipelines = {}
_pipeline_lock = threading.Lock()


def get_pipeline(lang='a'):
    """Return (creating on first use) the KPipeline for a language code."""
    lang = (lang or 'a').lower()
    with _pipeline_lock:
        if lang in _pipelines:
            return _pipelines[lang]
        print(f"[KokoroTTS] Loading pipeline for lang='{lang}' ...", flush=True)
        pipe = KPipeline(lang)
        _pipelines[lang] = pipe
        print(f"[KokoroTTS] ✅ Pipeline '{lang}' ready", flush=True)
        return pipe


# Warm the default language at start-up so the first request is not slow.
pipeline = get_pipeline('a')
print("[KokoroTTS] ✅ Model loaded", flush=True)

# Language codes and the voices each one supports. The prefix is the
# Kokoro voice prefix: <lang><gender>_<name>.
LANGUAGES = {
    'a': {'name': 'American English', 'voices': [
        ('af_sarah', 'Sarah', 'Bright & cheerful'),
        ('af_bella', 'Bella', 'Warm & friendly'),
        ('af_nicole', 'Nicole', 'Calm & professional'),
        ('af_nova', 'Nova', 'Clear & upbeat'),
        ('af_heart', 'Heart', 'Warm & gentle'),
        ('af_sky', 'Sky', 'Bright & light'),
    ]},
    'b': {'name': 'British English', 'voices': [
        ('bf_emma', 'Emma', 'Calm & composed'),
        ('bf_isabella', 'Isabella', 'Warm & refined'),
        ('bf_alice', 'Alice', 'Clear & direct'),
    ]},
    'e': {'name': 'Spanish', 'voices': [
        ('ef_dora', 'Dora', 'Warm & expressive'),
        ('em_alex', 'Alex', 'Clear & direct'),
        ('em_santa', 'Santa', 'Friendly & bright'),
    ]},
    'f': {'name': 'French', 'voices': [
        ('ff_siwis', 'Siwis', 'Calm & measured'),
    ]},
    'h': {'name': 'Hindi', 'voices': [
        ('hf_alpha', 'Alpha', 'Clear & neutral'),
        ('hf_omega', 'Omega', 'Warm & steady'),
    ]},
    'i': {'name': 'Italian', 'voices': [
        ('if_sara', 'Sara', 'Expressive & bright'),
        ('im_nicola', 'Nicola', 'Calm & warm'),
    ]},
    'p': {'name': 'Portuguese', 'voices': [
        ('pf_dora', 'Dora', 'Soft & warm'),
        ('pm_alex', 'Alex', 'Neutral & clear'),
    ]},
    'z': {'name': 'Mandarin Chinese', 'voices': [
        ('zf_xiaobei', 'Xiaobei', 'Clear & bright'),
        ('zf_xiaoni', 'Xiaoni', 'Calm & gentle'),
        ('zm_yunjian', 'Yunjian', 'Deep & steady'),
    ]},
    'j': {'name': 'Japanese', 'voices': [
        ('jf_alpha', 'Alpha', 'Neutral & clear'),
        ('jf_gongitsune', 'Gongitsune', 'Gentle & airy'),
        ('jm_kumo', 'Kumo', 'Young & bright'),
    ]},
}

DEFAULT_LANG = 'a'
DEFAULT_VOICE = 'af_sarah'


def voices_for(lang):
    entry = LANGUAGES.get((lang or DEFAULT_LANG).lower())
    if not entry:
        entry = LANGUAGES[DEFAULT_LANG]
    return [{'id': v[0], 'name': v[1], 'desc': v[2]} for v in entry['voices']]


def resolve_voice(lang, voice):
    """Map a requested voice onto one the language actually has."""
    lang = (lang or DEFAULT_LANG).lower()
    if lang not in LANGUAGES:
        lang = DEFAULT_LANG
    ids = [v['id'] for v in voices_for(lang)]  # voices_for returns dicts
    if voice in ids:
        return lang, voice
    return lang, ids[0]


VOICES = voices_for(DEFAULT_LANG)

def generate_wav(text, voice='af_sarah', speed=1.0, lang='a'):
    """Generate WAV bytes from text."""
    pipe = get_pipeline(lang)
    chunks = []
    for result in pipe(text, voice=voice, speed=speed):
        if result.audio is not None:
            chunks.append(result.audio)

    if not chunks:
        raise ValueError("No audio generated")

    audio = torch.cat(chunks, dim=0).numpy()
    int16 = (audio * 32767).astype('int16')

    buffer = io.BytesIO()
    with wave.open(buffer, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(int16.tobytes())

    return buffer.getvalue()


def handle_request(client_socket, path, method, headers, body):
    """Handle a single HTTP request."""
    try:
        # CORS headers
        cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }

        if method == 'OPTIONS':
            response = b'HTTP/1.1 204 No Content\r\n'
            for k, v in cors.items():
                response += f'{k}: {v}\r\n'.encode()
            response += b'\r\n'
            client_socket.sendall(response)
            return

        # GET /voices
        if path == '/voices' or path == '/voices/':
            resp_body = json.dumps({
                'voices': VOICES,
                'default': DEFAULT_VOICE,
                'languages': {
                    code: {'name': meta['name'], 'voices': voices_for(code)}
                    for code, meta in LANGUAGES.items()
                },
            }).encode()
            response = b'HTTP/1.1 200 OK\r\n'
            response += b'Content-Type: application/json\r\n'
            for k, v in cors.items():
                response += f'{k}: {v}\r\n'.encode()
            response += f'Content-Length: {len(resp_body)}\r\n'.encode()
            response += b'\r\n' + resp_body
            client_socket.sendall(response)
            return

        # POST /tts
        if path == '/tts' or path == '/tts/':
            if method != 'POST':
                client_socket.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
                return

            try:
                data = json.loads(body) if body else {}
            except:
                client_socket.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
                return

            text = data.get('text', '').strip()
            if not text:
                client_socket.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
                return

            # Sanitize + limit
            text = text[:5000]
            lang, voice = resolve_voice(data.get('lang', DEFAULT_LANG),
                                        data.get('voice', DEFAULT_VOICE))
            speed = float(data.get('speed', 1.0))
            speed = max(0.5, min(2.0, speed))

            # Generate
            wav_bytes = generate_wav(text, voice, speed, lang)

            response = b'HTTP/1.1 200 OK\r\n'
            response += b'Content-Type: audio/wav\r\n'
            for k, v in cors.items():
                response += f'{k}: {v}\r\n'.encode()
            response += f'Content-Length: {len(wav_bytes)}\r\n'.encode()
            response += b'\r\n'
            client_socket.sendall(response)
            client_socket.sendall(wav_bytes)
            print(f"[KokoroTTS] ✅ {voice} ({lang}) @ {speed}x — {len(text)} chars → {len(wav_bytes)} bytes", flush=True)
            return

        # 404
        client_socket.sendall(b'HTTP/1.1 404 Not Found\r\n\r\n')

    except Exception as e:
        print(f"[KokoroTTS] ❌ Error: {e}", flush=True)
        try:
            client_socket.sendall(b'HTTP/1.1 500 Internal Server Error\r\n\r\n')
        except:
            pass


def handle_client(client_socket, client_addr):
    """Handle a client connection in a thread."""
    try:
        # Read request
        data = b''
        client_socket.settimeout(5.0)
        while True:
            chunk = client_socket.recv(4096)
            if not chunk:
                break
            data += chunk
            # Simple body detection — if Content-Length present, read exactly that many bytes
            if b'\r\n\r\n' in data:
                header_end = data.index(b'\r\n\r\n')
                headers_part = data[:header_end].decode('utf-8', errors='ignore')
                body_start = header_end + 4

                # Parse Content-Length
                content_length = 0
                for line in headers_part.split('\r\n'):
                    if line.lower().startswith('content-length:'):
                        content_length = int(line.split(':')[1].strip())
                        break

                # Read body if needed
                if content_length > 0:
                    while len(data) < body_start + content_length:
                        chunk = client_socket.recv(4096)
                        if not chunk:
                            break
                        data += chunk

                # Parse request
                request_line = headers_part.split('\r\n')[0]
                parts = request_line.split(' ')
                if len(parts) >= 3:
                    method, path = parts[0], parts[1]
                    body = data[body_start:body_start+content_length] if content_length > 0 else b''
                    handle_request(client_socket, path, method, {}, body)
                break
    except Exception as e:
        print(f"[KokoroTTS] Client error: {e}", flush=True)
    finally:
        client_socket.close()


def main():
    import socket

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', PORT))
    server.listen(50)

    print(f"[KokoroTTS] 🟢 Listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"[KokoroTTS] Languages: {', '.join(LANGUAGES)}", flush=True)

    while True:
        client_socket, client_addr = server.accept()
        thread = threading.Thread(target=handle_client, args=(client_socket, client_addr))
        thread.daemon = True
        thread.start()


if __name__ == '__main__':
    main()
