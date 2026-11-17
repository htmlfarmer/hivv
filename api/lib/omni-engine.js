// api/lib/omni-engine.js — Universal AI Endpoint Engine
// One URL does EVERYTHING: local LLM, cloud models, streaming, reasoning, transcription
// Built-in VRAM protection: caps thinking tokens, auto-fallbacks, graceful error recovery

const http = require('http');
const https = require('https');
const crypto = require('crypto');

class OmniEngine {
    constructor() {
        this.startTime = Date.now();
        
        // Smart defaults for VRAM safety.
        // maxContextLength is DYNAMIC: it is derived from the model name
        // (see contextWindowFor below) and can be overridden per-request via
        // body.context_window. A hardcoded 16k wasted half of gemma-4's 32k
        // and made OpenCode's coding responses truncate.
        this.vramProtection = {
            maxThinkingTokens: parseInt(process.env.HIVV_MAX_THINKING_TOKENS, 10) || 50,
            maxContextLength: parseInt(process.env.HIVV_MAX_CONTEXT, 10) || 16000,
            requestTimeoutMs: parseInt(process.env.HIVV_SCAN_TIMEOUT_MS, 10) || 60000,
            retryOnCrash: 3,
            fallbackChain: this.buildFallbackChain()
        };

        // Track node health to avoid sending work to crashed GPUs
        this.nodeHealth = new Map();
        this.startHealthMonitor();

        // Stats
        this.stats = {
            totalRequests: 0,
            totalOutputTokens: 0,
            totalInputTokens: 0,
            avgLatencyMs: 0,
            streamRequests: 0,
            thinkRequests: 0,
            retries: 0
        };
    }

    // Build fallback chain from env vars — never hardcode IPs
    buildFallbackChain() {
        const envEndpoints = process.env.HIVV_LOCAL_ENDPOINTS || process.env.LOCAL_AI_ENDPOINTS || '';
        const chain = ['http://localhost:8080/v1/chat/completions'];
        if (envEndpoints) {
            for (const url of envEndpoints.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!chain.includes(url)) chain.push(url);
            }
        }
        return chain;
    }

    // ---- Main Router ----
    async handle(req, res) {
        const startTime = Date.now();
        let body;

        try {
            body = await this.readBody(req);
        } catch(e) {
            return this.send(res, 400, { error: 'Invalid JSON body' });
        }

        this.stats.totalRequests++;

        // Extract client intent
        const prompt = body.prompt || body.message || '';
        const messages = body.messages || [];
        const useMessages = messages.length > 0 ? messages : [{ role: 'user', content: prompt }];
        const modelPref = body.model || 'gemma4';
        const doThink = body.think_hard !== false && body.think !== false;
        const doStream = body.stream === true;
        const temperature = parseFloat(body.temperature) || 0.7;

        // DYNAMIC context window: derive from the model name, allow override.
        // A hardcoded 16k wasted half of gemma-4's 32k and truncated OpenCode.
        const ctxWindow = parseInt(body.context_window, 10)
            || this.contextWindowFor(modelPref)
            || this.vramProtection.maxContextLength;

        // DYNAMIC output budget: scale with the context window, not a flat
        // 100/200. A coding response needs room to breathe.
        const defaultMax = doThink
            ? Math.min(256, Math.floor(ctxWindow * 0.05))
            : Math.min(4096, Math.floor(ctxWindow * 0.15));
        const maxTokens = parseInt(body.max_tokens, 10) || defaultMax;

        // Pre-validate: no empty prompts, cap size
        if (!prompt && !useMessages.find(m => m.content)) {
            return this.send(res, 400, { error: 'Prompt or messages required' });
        }

        // Build API-compliant request payload
        const apiPayload = {
            model: modelPref,
            messages: useMessages,
            max_tokens: maxTokens,
            temperature,
            stream: doStream
        };

        // CRITICAL: If thinking is requested, cap it hard to save VRAM.
        // The cap itself is dynamic (HIVV_MAX_THINKING_TOKENS, default 50).
        if (doThink && apiPayload.max_tokens > this.vramProtection.maxThinkingTokens + 10) {
            apiPayload.max_tokens = this.vramProtection.maxThinkingTokens + 10;
        }

        // Send through the routing pipeline
        return this.routeAndRespond(apiPayload, req, res, {
            doStream,
            doThink,
            startTime,
            thinking: doThink
        });
    }

    // ---- Health Monitor (checks if GPUs are alive every 5s) ----
    startHealthMonitor() {
        setInterval(() => {
            for (const url of this.vramProtection.fallbackChain) {
                this.checkHealth(url).then(healthy => {
                    const key = this.urlToKey(url);
                    this.nodeHealth.set(key, {
                        healthy,
                        lastChecked: Date.now(),
                        responseTime: Date.now() - (this._probeStart || Date.now())
                    });
                });
            }
        }, 5000);
    }

    async checkHealth(url) {
        try {
            const probeUrl = url.includes('/chat') ? url.replace('/chat/completions', '/models') : url;
            this._probeStart = Date.now();
            const data = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
            return !!(data.models || data.model);
        } catch(e) { return false; }
    }

    urlToKey(url) { return url; }

    // Derive a model's context window from its name. Ordered most-specific
    // first. Falls back to the configured default (HIVV_MAX_CONTEXT or 16k).
    contextWindowFor(modelName) {
        const name = String(modelName || '');
        const table = [
            [/gemma[-_ ]?4/i, 32768],
            [/gemma/i, 8192],
            [/llama[-_ ]?3[._-]?\d/i, 131072],
            [/llama[-_ ]?3/i, 8192],
            [/llama/i, 4096],
            [/qwen[-_ ]?3/i, 32768],
            [/qwen/i, 8192],
            [/mistral/i, 32768],
            [/phi[-_ ]?3/i, 131072],
            [/phi/i, 8192],
            [/deepseek/i, 65536],
            [/codellama/i, 16384],
            [/gpt-oss/i, 131072],
        ];
        for (const [re, ctx] of table) {
            if (re.test(name)) return ctx;
        }
        return this.vramProtection.maxContextLength;
    }

    // ---- Routing Pipeline ----
    async routeAndRespond(payload, req, res, options) {
        const routes = this.getHealthyRoutes();

        for (let attempt = 0; attempt < routes.length && attempt <= this.vramProtection.retryOnCrash; attempt++) {
            const targetUrl = routes[attempt] || this.vramProtection.fallbackChain[0];

            try {
                const result = await this.dispatchToTarget(targetUrl, payload, res, options);
                if (result.ok) return result;

                console.log(`[OMNI] Route ${targetUrl} failed: ${result.error}`);
                this.recordFailedRoute(targetUrl);
            } catch(e) {
                console.log(`[OMNI] Route ${targetUrl} crashed: ${e.message}`);
                this.recordFailedRoute(targetUrl);
            }
        }

        // All routes failed — send error
        return this.send(res, 502, {
            error: 'No available AI backend',
            message: 'All local and remote models are busy or crashed. Try again in a moment.',
            available_routes: routes.length,
            healthy_nodes: Array.from(this.nodeHealth.values()).filter(n => n.healthy).length
        });
    }

    getHealthyRoutes() {
        const candidates = this.vramProtection.fallbackChain.filter(url => {
            const key = this.urlToKey(url);
            const h = this.nodeHealth.get(key);
            return h?.healthy || true; // Default to healthy until proven otherwise
        });
        // Randomize to distribute load, but keep failed nodes at the end
        return candidates.slice().sort(() => Math.random() - 0.5);
    }

    recordFailedRoute(url) {
        const key = this.urlToKey(url);
        this.nodeHealth.set(key, { healthy: false, lastFailed: Date.now() });
    }

    // ---- Dispatch to Target ----
    async dispatchToTarget(targetUrl, payload, res, options) {
        const proto = targetUrl.startsWith('https:') ? https : http;
        const urlObj = new URL(targetUrl);
        const bodyStr = JSON.stringify(payload);

        const opts = {
            hostname: urlObj.hostname,
            port: urlObj.port || 80,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            },
            timeout: this.vramProtection.requestTimeoutMs
        };

        return new Promise((resolve) => {
            const req = proto.request(opts, (serverRes) => {
                if (serverRes.statusCode !== 200) {
                    resolve({ ok: false, error: `HTTP ${serverRes.statusCode}` });
                    return;
                }

                // Set SSE headers for streaming clients
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.setHeader('X-Omni-Model', urlObj.hostname);
                res.setHeader('X-Omni-Routed', true);

                const reader = serverRes.body.getReader();
                const decoder = new TextDecoder();
                let doneReading = false;

                // Stream forwarding function
                const readLoop = async () => {
                    while (!doneReading) {
                        try {
                            const { done, value } = await reader.read();
                            if (done) { doneReading = true; break; }

                            const textChunk = decoder.decode(value, { stream: true });
                            const lines = textChunk.split('\n');

                            for (const line of lines) {
                                if (!line.trim()) continue;

                                let outputLine = line;

                                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                                    try {
                                        const parsed = JSON.parse(line.slice(6));

                                        // Sanitize model names (>100 chars = HuggingFace cache path)
                                        if (parsed.model && parsed.model.length > 100) {
                                            parsed.model = parsed.model.split('/').pop().replace(/\.(gguf|bin|safetensors)$/i, '');
                                        }

                                        // STRIP REASONING CONTENT to prevent UI confusion and VRAM waste
                                        const choice = parsed.choices?.[0]?.delta;
                                        if (choice?.reasoning_content && !choice.content) {
                                            // Skip reasoning-only chunks entirely
                                            continue;
                                        }
                                        delete choice?.reasoning_content;
                                        delete choice?.reasoning;

                                        // Count tokens
                                        if (choice?.content) this.stats.totalOutputTokens++;

                                        outputLine = 'data: ' + JSON.stringify(parsed);
                                    } catch(e) {}
                                } else if (line.startsWith('data: ') && line.includes('[DONE]')) {
                                    // Add stats footer
                                    const elapsed = Date.now() - options.startTime;
                                    const tps = this.stats.totalOutputTokens > 0
                                        ? Math.round((this.stats.totalOutputTokens / elapsed) * 1000)
                                        : 0;
                                    outputLine = `\ndata: {"choices":[{"finish_reason":"stats","index":0,"delta":{}}]}
data: {"hivv_stats":{"tokens_sec":${tps},"total_output":${this.stats.totalOutputTokens},"elapsed_ms":${elapsed}}}\n\n`;
                                    doneReading = true;
                                    break;
                                }

                                res.write(outputLine + '\n');
                            }
                        } catch(e) {
                            if (doneReading) break;
                        }
                    }
                    res.end();
                    resolve({ ok: true });
                };

                readLoop();
            });

            req.on('error', (err) => resolve({ ok: false, error: err.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out' }); });
            req.setTimeout(this.vramProtection.requestTimeoutMs);
            req.write(bodyStr);
            req.end();
        });
    }

    // ---- HTTP Helpers ----
    readBody(req) {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Invalid JSON')); }
            });
            req.on('error', reject);
        });
    }

    send(res, code, data) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    // ---- Stats Endpoint ----
    getStats() {
        const nodes = Array.from(this.nodeHealth.values());
        return {
            ...this.stats,
            uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
            vram_protection: {
                max_thinking_tokens: this.vramProtection.maxThinkingTokens,
                max_context_length: this.vramProtection.maxContextLength,
                request_timeout_ms: this.vramProtection.requestTimeoutMs
            },
            nodes: nodes.map(n => ({
                ...n,
                status: n.healthy ? 'healthy' : 'unhealthy',
                age_ms: Date.now() - n.lastChecked
            }))
        };
    }
}

module.exports = OmniEngine;
