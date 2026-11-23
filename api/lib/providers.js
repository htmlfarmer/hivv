const https = require('https');
const { mergeToolCalls } = require('./tool-stream');
const http = require('http');
const crypto = require('crypto');

const PROVIDER_DEFAULTS = {
    'openai': {
        url: 'https://api.openai.com/v1/chat/completions',
        format: 'openai'
    },
    'anthropic': {
        url: 'https://api.anthropic.com/v1/messages',
        format: 'anthropic'
    },
    'google': {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
        format: 'google'
    },
    'minimax': {
        url: 'https://api.minimax.io/v1/chat/completions',
        format: 'openai'
    },
    'mimo': {
        url: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
        format: 'openai'
    },
    'mistral': {
        url: 'https://api.mistral.ai/v1/chat/completions',
        format: 'openai'
    },
    'groq': {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        format: 'openai'
    },
    'deepseek': {
        url: 'https://api.deepseek.com/v1/chat/completions',
        format: 'openai'
    },
    'openrouter': {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        format: 'openai'
    },
    'together': {
        url: 'https://api.together.xyz/v1/chat/completions',
        format: 'openai'
    },
    'qwen': {
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        format: 'openai'
    },
    'minimax': {
        url: 'https://api.minimax.io/v1/chat/completions',
        format: 'openai'
    },
    'lmstudio': {
        url: 'http://localhost:1234/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'ollama': {
        url: 'http://localhost:11434/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'llamacpp': {
        url: 'http://localhost:8080/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'localai': {
        url: 'http://localhost:8080/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'textgen': {
        url: 'http://localhost:5000/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'tabby': {
        url: 'http://localhost:8080/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'vllm': {
        url: 'http://localhost:8000/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'sglang': {
        url: 'http://localhost:8080/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'aphrodite': {
        url: 'http://localhost:8000/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'koboldcpp': {
        url: 'http://localhost:5000/v1/chat/completions',
        format: 'openai',
        isLocal: true
    },
    'oobabooga': {
        url: 'http://localhost:5000/v1/chat/completions',
        format: 'openai',
        isLocal: true
    }
};

function decryptKeyValue(encryptedData) {
    if (!encryptedData) {return null;}
    if (!encryptedData.includes(':')) {return encryptedData;}

    try {
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {return encryptedData;}

        const key = process.env.HIVV_ENCRYPTION_KEY;
        if (!key) {return encryptedData;}

        const keyBuffer = Buffer.from(key, 'hex');
        if (keyBuffer.length !== 32) {return encryptedData;}

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];

        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        return encryptedData;
    }
}

class AIProvider {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.displayName = config.display_name;
        this.format = config.api_format || 'openai';
        this.defaultEndpoint = config.default_endpoint;
        this.isCloud = config.is_cloud !== false;
        this.requiresEndpoint = config.requires_endpoint === true;
        this.supportedModels = config.supported_models || [];
    }
}

class AIKey {
    constructor(config) {
        this.id = config.id;
        this.providerId = config.provider_id;
        this.userId = config.user_id;
        this.keyName = config.key_name;
        this.keyValue = decryptKeyValue(config.key_value);
        this.apiEndpoint = config.api_endpoint;
        this.model = config.model;
        this.priority = config.priority || 50;
        this.weight = config.weight || 1;
        this.maxRequestsPerHour = config.max_requests_per_hour;
        this.maxTokensPerDay = config.max_tokens_per_day;
        this.isActive = config.is_active !== false;
        this.isShared = config.is_shared === true;
        this.costPer1kInput = parseFloat(config.cost_per_1k_input_tokens) || 0;
        this.costPer1kOutput = parseFloat(config.cost_per_1k_output_tokens) || 0;
        this.lastUsedAt = config.last_used_at;
        this.totalRequests = config.total_requests || 0;
        this.totalTokensUsed = config.total_tokens_used || 0;
        this.totalCost = parseFloat(config.total_cost) || 0;
        this.expiresAt = config.expires_at;
        this.notes = config.notes;
    }

    isExpired() {
        return this.expiresAt && new Date(this.expiresAt) < new Date();
    }

    isAvailable() {
        return this.isActive && !this.isExpired();
    }

    calculateCost(inputTokens, outputTokens) {
        return (inputTokens * this.costPer1kInput + outputTokens * this.costPer1kOutput) / 1000;
    }
}

class StreamCapture {
    constructor() {
        this.buffer = '';
        this.fullContent = '';
    }

    write(chunk) {
        this.buffer += chunk.toString();
        this.fullContent += chunk.toString();
        return true;
    }

    end(...args) {
        return;
    }

    setHeader() {
        return this;
    }

    getBuffer() {
        return this.buffer;
    }

    getContent() {
        return this.fullContent;
    }

    parseSSE() {
        const lines = this.buffer.split('\n');
        let content = '';
        let model = null;
        let usage = null;
        let toolCalls = null;
        // Streamed tool calls arrive as DELTAS (choices[0].delta.tool_calls),
        // one fragment per index — the shape every real provider sends. The
        // non-streaming shape (choices[0].message.tool_calls) is the rare
        // one. Looking only at `message` meant the hub's non-streaming tool
        // loop never saw a tool call from a provider that streams them, so
        // the model asked for a tool and the hub shrugged.
        const toolDeltas = [];

        for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const deltaContent = parsed.choices?.[0]?.delta?.content || '';
                    const msgContent = parsed.choices?.[0]?.message?.content || '';
                    content += deltaContent || msgContent || '';
                    if (parsed.model) {model = parsed.model;}
                    if (parsed.usage) {usage = parsed.usage;}
                    if (parsed.choices?.[0]?.delta?.tool_calls) {
                        toolDeltas.push(...parsed.choices[0].delta.tool_calls);
                    }
                    if (parsed.choices?.[0]?.message?.tool_calls) {
                        toolCalls = parsed.choices[0].message.tool_calls;
                    }
                } catch (e) {}
            } else {
                try {
                    const parsed = JSON.parse(line);
                    const msgContent = parsed.choices?.[0]?.message?.content || '';
                    content += msgContent;
                    if (parsed.model) {model = parsed.model;}
                    if (parsed.usage) {usage = parsed.usage;}
                    if (parsed.choices?.[0]?.delta?.tool_calls) {
                        toolDeltas.push(...parsed.choices[0].delta.tool_calls);
                    }
                    if (parsed.choices?.[0]?.message?.tool_calls) {
                        toolCalls = parsed.choices[0].message.tool_calls;
                    }
                } catch (e) {}
            }
        }

        if (toolDeltas.length) {
            const merged = mergeToolCalls(toolDeltas);
            if (merged.length) toolCalls = merged;
        }

        return { content, model, usage, toolCalls };
    }
}

class ProviderClient {
    constructor(key, provider) {
        this.key = key;
        this.provider = provider;
    }

    buildRequestBody(model, messages, stream = true, tools = null, gen = {}, toolChoice = null) {
        const format = this.provider.format || 'openai';

        if (format === 'anthropic') {
            const system = messages.find(m => m.role === 'system')?.content || '';
            let conv = messages.filter(m => m.role !== 'system');
            // Convert OpenAI image_url content to Anthropic image format
            conv = conv.map(m => {
                if (!Array.isArray(m.content)) return m;
                return {
                    ...m,
                    content: m.content.map(part => {
                        if (part.type === 'image_url') {
                            const url = part.image_url?.url || part.image_url;
                            const isData = typeof url === 'string' && url.startsWith('data:');
                            const mediaType = isData ? url.split(';')[0].split(':')[1] : 'image/jpeg';
                            const data = isData ? url.split(',')[1] : url;
                            return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
                        }
                        return part;
                    })
                };
            });
            const body = {
                model: model || this.key.model,
                system,
                messages: conv,
                max_tokens: gen.max_tokens || 4096,
                stream
            };
            if (gen.temperature != null) body.temperature = gen.temperature;
            if (gen.top_p != null) body.top_p = gen.top_p;
            if (gen.stop) body.stop_sequences = Array.isArray(gen.stop) ? gen.stop : [gen.stop];
            return { body: JSON.stringify(body), format };
        }

        if (format === 'google') {
            const contents = messages
                .filter(m => m.role !== 'system')
                .map(m => {
                    const parts = [];
                    if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (part.type === 'image_url') {
                                const url = part.image_url?.url || part.image_url;
                                const isData = typeof url === 'string' && url.startsWith('data:');
                                const mimeType = isData ? url.split(';')[0].split(':')[1] : 'image/jpeg';
                                const data = isData ? url.split(',')[1] : url;
                                parts.push({ inlineData: { mimeType, data } });
                            } else if (part.type === 'text') {
                                parts.push({ text: part.text });
                            }
                        }
                    } else {
                        parts.push({ text: m.content || '' });
                    }
                    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
                });
            const body = { contents };
            const system = messages.find(m => m.role === 'system')?.content;
            if (system) { body.systemInstruction = { parts: [{ text: system }] }; }
            const genConfig = {};
            if (gen.temperature != null) genConfig.temperature = gen.temperature;
            if (gen.top_p != null) genConfig.topP = gen.top_p;
            if (gen.max_tokens) genConfig.maxOutputTokens = gen.max_tokens;
            if (gen.stop) genConfig.stopSequences = Array.isArray(gen.stop) ? gen.stop : [gen.stop];
            if (Object.keys(genConfig).length) body.generationConfig = genConfig;
            return { body: JSON.stringify(body), format };
        }

        // OpenAI-compatible format (default) — handles multimodal content arrays as-is
        const req = { model: model || this.key.model, messages, stream };
        if (tools) { req.tools = tools; }
        if (toolChoice != null) { req.tool_choice = toolChoice; }
        if (gen.temperature != null) req.temperature = gen.temperature;
        if (gen.top_p != null) req.top_p = gen.top_p;
        if (gen.max_tokens) req.max_tokens = gen.max_tokens;
        if (gen.frequency_penalty != null) req.frequency_penalty = gen.frequency_penalty;
        if (gen.presence_penalty != null) req.presence_penalty = gen.presence_penalty;
        if (gen.stop) req.stop = gen.stop;
        return {
            body: JSON.stringify(req),
            format: 'openai'
        };
    }

    buildHeaders(apiKey, format) {
        const headers = { 'Content-Type': 'application/json' };

        if (format === 'anthropic') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else if (format === 'google') {
        } else {
            headers.Authorization = `Bearer ${  apiKey}`;
        }

        return headers;
    }

    async makeRequest(model, messages, streamToRes = null, options = {}) {
        const startTime = Date.now();
        const { body, format } = this.buildRequestBody(model, messages, !!streamToRes, options.tools || null, options.gen || {}, options.toolChoice ?? null);
        const endpoint = this.key.api_endpoint || this.provider.defaultEndpoint;

        if (!endpoint) {
            return { ok: false, error: 'No endpoint configured', status: 0 };
        }

        let url;
        try {
            if (format === 'google') {
                const filled = endpoint.replace('{model}', encodeURIComponent(model || this.key.model));
                url = new URL(`${filled  }?key=${  this.key.keyValue}`);
            } else {
                const filled = endpoint.replace('{model}', encodeURIComponent(model || this.key.model));
                url = new URL(filled);
            }
        } catch (e) {
            return { ok: false, error: `Invalid URL: ${  e.message}`, status: 0 };
        }

        const headers = this.buildHeaders(this.key.keyValue, format);
        const proto = url.protocol === 'https:' ? https : http;
        const timeout = options.timeout || 120000;

        return new Promise((resolve) => {
            const req = proto.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
            }, (response) => {
                const latency = Date.now() - startTime;

                if (response.statusCode !== 200) {
                    let errBody = '';
                    response.on('data', c => errBody += c);
                    response.on('end', () => {
                        const error = `HTTP ${response.statusCode}: ${errBody.slice(0, 300)}`;
                        console.log(`Provider ${this.provider.name} error: ${error}`);
                        resolve({ ok: false, error, status: response.statusCode, latency });
                    });
                    return;
                }

                if (streamToRes) {
                    streamToRes.setHeader('X-AI-Provider', this.provider.name);
                    streamToRes.setHeader('X-AI-Key-Id', String(this.key.id));
                    streamToRes.setHeader('Content-Type', 'text/event-stream');
                    streamToRes.setHeader('Cache-Control', 'no-cache');
                    streamToRes.setHeader('Connection', 'keep-alive');

                    // cheap stream accounting: each non-empty SSE content delta ≈ 1 token
                    let streamTokens = 0;
                    response.on('data', chunk => {
                        streamToRes.write(chunk);
                        const m = chunk.toString().match(/"content":\s*"[^"]+"/g);
                        if (m) {streamTokens += m.length;}
                    });
                    response.on('end', () => {
                        streamToRes.end();
                        resolve({ ok: true, latency, totalTokens: streamTokens });
                    });
                    response.on('error', e => resolve({ ok: false, error: e.message, latency }));
                } else {
                    let data = '';
                    response.on('data', c => data += c);
                    response.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            const usage = parsed.usage || {};
                            resolve({
                                ok: true,
                                data: parsed,
                                latency,
                                usage: {
                                    inputTokens: usage.prompt_tokens || 0,
                                    outputTokens: usage.completion_tokens || 0
                                }
                            });
                        } catch (e) {
                            resolve({ ok: false, error: `Parse error: ${  e.message}`, latency, data });
                        }
                    });
                    response.on('error', e => resolve({ ok: false, error: e.message, latency }));
                }
            });

            req.on('error', e => resolve({ ok: false, error: e.message, latency: Date.now() - startTime }));
            req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, error: 'timeout', latency: timeout }); });

            req.write(body);
            req.end();
        });
    }
}

module.exports = {
    AIProvider,
    AIKey,
    ProviderClient,
    StreamCapture,
    PROVIDER_DEFAULTS
};
