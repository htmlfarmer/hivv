// api/lib/tool-stream.js — run a tool loop inside a STREAMING chat response.
//
// THE PROBLEM
// ───────────
// The hub's non-streaming chat path runs a tool loop: the model asks for a
// tool, the hub runs it, feeds the result back, and the model answers. That
// path was easy — the whole response is in memory.
//
// The STREAMING path is the default for /api/chat, and it was never able to
// do that. The router writes provider frames straight to the response
// socket, so by the time we see a tool_call it has already been sent to the
// client. A client that receives an unexpected tool_call will try to execute
// it itself — double execution, and the tool runs on the wrong machine.
//
// WHAT THIS DOES
// ──────────────
// It intercepts the SSE stream and holds back the frames that carry tool
// calls, forwarding content frames to the client as they arrive:
//
//   round 1  → model asks for `current_time`
//              → the tool_call frames are HELD (never reach the client)
//              → the hub runs the tool
//   round 2  → model answers with the time
//              → content frames stream to the client normally
//
// The client sees ONE clean answer. It never sees a tool_call it did not ask
// for, and it never has to implement a tool loop of its own.
//
// This mirrors what LiteLLM's proxy does for OpenAI-compatible clients.
//
// SSE RULES (learned the hard way — see AGENTS.md)
// ───────────────────────────────────────────────
//   · every frame is separated by a blank line (\n\n)
//   · a TCP read can split a frame in half, so lines are BUFFERED
//   · the stream ends with `data: [DONE]`
//   · custom frames stay choice-less (top-level keys, never finish_reason)

// ── frame parsing ───────────────────────────────────────────────────────────

/**
 * Split a buffer into complete SSE frames.
 * @returns {{frames: string[], rest: string}}
 */
function splitFrames(buffer) {
    const frames = [];
    let rest = String(buffer || '');
    let idx;
    while ((idx = rest.indexOf('\n\n')) !== -1) {
        frames.push(rest.slice(0, idx));
        rest = rest.slice(idx + 2);
    }
    return { frames, rest };
}

/**
 * Read the JSON payload out of one SSE frame.
 * @returns {object|null} the parsed `data:` payload, or null
 */
function framePayload(frame) {
    const text = String(frame || '');
    const lines = text.split('\n');
    for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { return JSON.parse(data); } catch (_e) { return null; }
    }
    return null;
}

/**
 * Decide what a frame is.
 * @returns {{kind:'tool'|'content'|'other', toolCalls?:Array, content?:string}}
 */
function classifyFrame(frame) {
    const payload = framePayload(frame);
    if (!payload) return { kind: 'other' };
    const choice = payload.choices && payload.choices[0];
    const delta = choice && choice.delta;
    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        return { kind: 'tool', toolCalls: delta.tool_calls };
    }
    if (delta && typeof delta.content === 'string' && delta.content) {
        return { kind: 'content', content: delta.content };
    }
    return { kind: 'other' };
}

/**
 * Merge OpenAI-style streamed tool_call deltas into complete tool calls.
 * Deltas arrive as {index, id?, type?, function:{name?, arguments?}} and must
 * be concatenated by index.
 */
function mergeToolCalls(deltas) {
    const byIndex = new Map();
    for (const d of (deltas || [])) {
        const idx = typeof d.index === 'number' ? d.index : byIndex.size;
        const cur = byIndex.get(idx) || { index: idx, id: null, type: 'function', function: { name: '', arguments: '' } };
        if (d.id) cur.id = d.id;
        if (d.type) cur.type = d.type;
        if (d.function) {
            if (d.function.name) cur.function.name += d.function.name;
            if (d.function.arguments) cur.function.arguments += d.function.arguments;
        }
        byIndex.set(idx, cur);
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// ── the interceptor ─────────────────────────────────────────────────────────

/**
 * A response-like object the router can write to. It forwards content frames
 * to the real response as they arrive and holds back tool-call frames.
 */
class ToolStreamInterceptor {
    /**
     * @param {object} realRes   the real express response
     * @param {object} opts
     * @param {number} opts.maxRounds  how many model rounds to allow (default 5)
     */
    constructor(realRes, opts = {}) {
        this.real = realRes;
        this.maxRounds = Math.max(1, parseInt(opts.maxRounds) || 5);
        this.buffer = '';             // partial frame, waiting for its separator
        this.heldTools = [];          // tool_call frames (never sent to the client)
        this.heldEnd = [];            // the [DONE] terminator for this round
        this.toolDeltas = [];         // tool_call deltas seen this round
        this.content = '';            // assistant content seen this round
        this.headers = {};
        this.statusCode = 200;
        this.ended = false;
        this.headersSent = false;
        this.round = 0;
        this.framesForwarded = 0;
        this.finished = false;
    }

    // ── the response API the router uses ─────────────────────────────────────
    setHeader(name, value) {
        this.headers[name] = value;
        this.headersSent = true;
        try { this.real.setHeader(name, value); } catch (_e) { /* already sent */ }
    }
    getHeader(name) { return this.headers[name]; }
    removeHeader(name) {
        delete this.headers[name];
        try { this.real.removeHeader(name); } catch (_e) { void _e; }
    }
    write(chunk) {
        this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        this._drain();
        return true;
    }
    end(chunk) {
        if (chunk !== undefined && chunk !== null && chunk !== '') this.write(chunk);
        if (this.buffer.trim()) {
            // a final frame that never got its blank-line separator
            const frame = this.buffer;
            this.buffer = '';
            this._handleFrame(frame);
        }
        this.ended = true;
        // NOTE: we do NOT close the real response here. The router ends every
        // round, but a round that asked for a tool must not close the stream —
        // the hub is going to run the tool and ask the model again. The
        // caller decides when the HTTP response really ends: finish().
    }

    /** Close the real response. Call this exactly once, at the very end. */
    finish() {
        if (this.finished) return;
        this.finished = true;
        try { this.real.end(); } catch (_e) { /* client gone */ }
    }

    // ── internals ───────────────────────────────────────────────────────────
    _drain() {
        const { frames, rest } = splitFrames(this.buffer);
        this.buffer = rest;
        for (const frame of frames) this._handleFrame(frame);
    }

    _handleFrame(frame) {
        const info = classifyFrame(frame);
        if (info.kind === 'tool') {
            this.toolDeltas.push(...info.toolCalls);
            this.heldTools.push(frame);      // hold it back — the client must not see it
            return;
        }
        if (info.kind === 'content') {
            this.content += info.content;
            this._forward(frame);
            return;
        }
        // 'other' — the terminator, the stats frame, provider markers.
        // The terminator belongs to the round we are in: hold it, because if
        // this round turns out to be a tool call the stream must continue.
        if (/data:\s*\[DONE\]/i.test(frame)) {
            this.heldEnd.push(frame);
            return;
        }
        this._forward(frame);
    }

    _forward(frame) {
        this.framesForwarded++;
        try { this.real.write(frame + '\n\n'); } catch (_e) { /* client gone */ }
    }

    /** The tool calls the model asked for this round (complete, merged). */
    toolCalls() {
        return mergeToolCalls(this.toolDeltas);
    }

    /** True when this round asked for at least one tool. */
    hadToolCalls() {
        return this.toolDeltas.length > 0;
    }

    /**
     * The assistant message for this round, in the shape the next request
     * needs: {role:'assistant', content, tool_calls}.
     */
    assistantMessage() {
        const calls = this.toolCalls();
        const msg = { role: 'assistant', content: this.content || null };
        if (calls.length) msg.tool_calls = calls;
        return msg;
    }

    /**
     * End this round's stream: forward the held terminator so the client's
     * SSE closes cleanly. The held TOOL frames are dropped, never sent — the
     * client asked a question, not for a tool call, and it has no idea how to
     * run one.
     */
    release() {
        const held = this.heldEnd;
        this.heldEnd = [];
        this.heldTools = [];
        for (const frame of held) this._forward(frame);
        return held.length;
    }
}

module.exports = {
    splitFrames,
    framePayload,
    classifyFrame,
    mergeToolCalls,
    ToolStreamInterceptor,
};
