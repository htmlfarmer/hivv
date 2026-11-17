// api/lib/context-manager.js — Context window manager for max-safe LLM operation
// Manages per-model context limits, smart token budgeting, overflow protection

class ContextManager {
    constructor(pool) {
        this.pool = pool;
        // Default profile: balanced (safe)
        this.config = {
            // Maximum context window per model (tokens)
            // Higher = longer conversations, more risk of OOM
            maxContextWindows: {
                'gemma4': 16384,       // Current safe default
                'default': 8192,       // Fallback for unknown models
                'custom': 32768        // Custom endpoints can specify
            },
            
            // Hard cap on OUTPUT tokens per request (prevents infinite generation crashing GPU)
            maxOutputTokens: {
                low: 500,      // Short answers, summaries
                normal: 1000,  // Standard chat
                high: 2000,    // Long-form reasoning
                research: 4000 // Deep analysis (risky on small GPUs!)
            },
            
            // Token budget allocation
            // When prompt exceeds this, truncate oldest messages instead of failing
            softContextLimit: 0.85,   // Truncate at 85% of max window
            hardContextLimit: 0.95,   // Force stop at 95%
            
            // Streaming behavior
            streamChunkSize: 256,     // Bytes per SSE frame flush
            maxStreamingTimeMs: 120000, // Kill streams after 2 minutes
            
            // Automatic fallback behavior
            onOomDetect: 'fallback',  // 'fallback' | 'retry' | 'truncate'
            retryCount: 2,            // How many times to retry after OOM
            retryBackoffMs: 1000      // Delay between retries
        };

        // Runtime state — tracks each node's remaining VRAM estimate
        this.nodeVramEstimates = new Map();
        
        // Start monitoring loop
        this.startHealthMonitor();
    }

    // ---- Per-Model Configuration ----
    
    setMaxContext(modelName, maxTokens) {
        if (this.config.maxContextWindows[modelName]) {
            this.config.maxContextWindows[modelName] = Math.min(maxTokens, 131072); // Cap at 128K
        } else {
            this.config.maxContextWindows[modelName] = maxTokens;
        }
        return this.config.maxContextWindows[modelName];
    }

    getMaxContext(modelName) {
        return this.config.maxContextWindows[modelName] || this.config.maxContextWindows['default'];
    }

    setProfile(name, profile) {
        this.config[name] = { ...this.config[name], ...profile };
    }

    getProfile(name) {
        return JSON.parse(JSON.stringify(this.config[name]));
    }

    // ---- Smart Request Builder ----
    // Takes a prompt and builds the safest possible API request

    buildSafeRequest(messages, options = {}) {
        const totalPromptTokens = this.estimateTokenCount(messages);
        const maxAllowed = this.getMaxContext('default') * (this.config.softContextLimit);

        // Check if prompt alone would exceed safe limits
        if (totalPromptTokens > maxAllowed) {
            messages = this.truncateToSafeWindow(messages, maxAllowed * this.config.hardContextLimit);
        }

        // Determine appropriate output cap based on intent
        const intent = options.intent || 'normal'; // short | normal | long | research
        const baseCap = this.config.maxOutputTokens[intent] || this.config.maxOutputTokens.normal;
        
        // Never let output exceed 30% of context window (safety buffer)
        const hardCap = Math.floor(this.getMaxContext('default') * 0.3);
        const finalMaxTokens = Math.min(baseCap, hardCap);

        // Build payload respecting all constraints
        return {
            messages,
            max_tokens: finalMaxTokens,
            temperature: options.temperature ?? 0.7,
            top_p: options.top_p ?? 0.95,
            stream: options.stream ?? false,
            stop_sequences: options.stop_sequences || null
        };
    }

    // ---- VRAM Protection ----

    recordNodeVram(nodeId, usagePercent) {
        this.nodeVramEstimates.set(nodeId, {
            used_percent: usagePercent,
            timestamp: Date.now()
        });
    }

    getNodeAvailableVram(nodeId) {
        const vram = this.nodeVramEstimates.get(nodeId);
        if (!vram) return 100; // Assume full availability if unknown
        
        const available = 100 - vram.used_percent;
        return Math.max(available, 0);
    }

    shouldRouteToNode(nodeId, requestedTokens) {
        const available = this.getNodeAvailableVram(nodeId);
        // Don't route to nodes with < 20% VRAM free (protecting against OOM)
        return available >= 20 && (requestedTokens <= available * 10);
    }

    // ---- Health Monitor ----
    startHealthMonitor() {
        // Every 10 seconds, probe each backend to see if it responds within time
        setInterval(async () => {
            const http = require('http');
            
            const envEndpoints = process.env.HIVV_LOCAL_ENDPOINTS || process.env.LOCAL_AI_ENDPOINTS || '';
            const healthUrls = ['http://localhost:8080/v1/models'];
            if (envEndpoints) {
                for (const u of envEndpoints.split(',').map(s => s.trim()).filter(Boolean)) {
                    const probe = u.includes('/chat/completions') ? u.replace('/chat/completions', '/models') : u;
                    if (!healthUrls.includes(probe)) healthUrls.push(probe);
                }
            }
            for (const url of healthUrls) {
                try {
                    const t0 = Date.now();
                    await fetch(url, { signal: AbortSignal.timeout(2000) });
                    
                    const elapsed = Date.now() - t0;
                    const nodeId = url.includes(':8080') ? 'local' : url.split(':')[2].replace('/', '');
                    
                    // Slow response suggests near-OOM state
                    const stressLevel = elapsed > 1000 ? Math.min((elapsed - 1000) / 5000, 1) : 0;
                    const estimatedVramUsage = stressLevel * 90; // Stress correlates roughly with VRAM pressure
                    
                    this.recordNodeVram(nodeId, estimatedVramUsage);
                } catch(e) {
                    // Node unreachable → mark as exhausted
                    const nodeId = url.includes(':8080') ? 'local' : url.split(':')[2].replace('/', '');
                    this.recordNodeVram(nodeId, 100); // Exhausted
                }
            }
        }, 10000);
    }

    // ---- Utility ----
    
    estimateTokenCount(messages) {
        let count = 0;
        for (const m of messages) {
            count += Math.ceil(m.content?.length / 4); // Rough estimate
        }
        return count;
    }

    truncateToSafeWindow(messages, targetTokens) {
        // Remove oldest messages until within limit
        while (messages.length > 1 && this.estimateTokenCount(messages) > targetTokens) {
            messages.shift();
        }
        return messages;
    }
}

module.exports = ContextManager;
