// api/lib/kokoro-tts.js — Kokoro TTS wrapper with caching + voice management

const { KPipeline } = require('kokoro');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

class KokoroTTS {
  constructor() {
    this.pipeline = null;
    this.model = null;
    this.ready = false;
    this.initPromise = null;
  }

  async init() {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      console.log('[KokoroTTS] Initializing on CUDA...');
      try {
        this.pipeline = new KPipeline('a'); // American English
        this.ready = true;
        console.log('[KokoroTTS] ✅ Ready');
      } catch (err) {
        console.error('[KokoroTTS] ❌ Failed to init:', err.message);
        throw err;
      }
    })();

    return this.initPromise;
  }

  // Available voices (American English female voices — best sounding)
  getAvailableVoices() {
    return [
      { id: 'af_sarah',  name: 'Sarah',   desc: 'Bright & cheerful',  tags: ['female', 'american'] },
      { id: 'af_bella',  name: 'Bella',    desc: 'Warm & friendly',     tags: ['female', 'american'] },
      { id: 'af_nicole', name: 'Nicole',   desc: 'Calm & professional', tags: ['female', 'american'] },
      { id: 'af_nova',   name: 'Nova',     desc: 'Clear & upbeat',      tags: ['female', 'american'] },
    ];
  }

  // Generate TTS audio, yields chunks for streaming
  async *generate(text, voice = 'af_sarah', speed = 1.0) {
    if (!this.ready) await this.init();

    // Validate voice
    const voices = this.getAvailableVoices();
    const selectedVoice = voices.find(v => v.id === voice)?.id || 'af_sarah';

    try {
      const generator = this.pipeline(text, voice=selectedVoice, speed=speed);

      for await (const result of generator) {
        if (result.audio) {
          // Yield float32 audio chunk
          yield result.audio;
        }
      }
    } catch (err) {
      console.error('[KokoroTTS] Generation error:', err.message);
      throw err;
    }
  }

  // Generate and return complete audio as Buffer (for non-streaming use)
  async generateComplete(text, voice = 'af_sarah', speed = 1.0) {
    const chunks = [];
    for await (const chunk of this.generate(text, voice, speed)) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      throw new Error('No audio generated');
    }

    return Buffer.concat(chunks);
  }
}

// Singleton
const tts = new KokoroTTS();

module.exports = { KokoroTTS, tts };
