class UsageTracker {
    constructor(pool) {
        this.pool = pool;
        this.tokenEstimates = {
            'gpt-4o': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gpt-4o-mini': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gpt-4-turbo': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gpt-3.5-turbo': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'claude-sonnet-4': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'claude-3-5-sonnet': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'claude-3-5-haiku': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gemini-2.0-flash': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gemini-1.5-pro': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'gemini-1.5-flash': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'minimax': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'mimo': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'mistral': { inputPerChar: 0.25, outputPerChar: 0.25 },
            'default': { inputPerChar: 0.25, outputPerChar: 0.25 }
        };
    }

    estimateTokens(text, type = 'input') {
        if (!text) {return 0;}
        const s = String(text);
        // BPE-ish heuristic: word-ish runs + punctuation each cost ~1 token;
        // long runs split into ~4-char pieces. Much closer than chars*0.25 for
        // code/JSON (which tokenizes densely) and within ~15% for prose.
        const parts = s.match(/[\w']+|[^\s\w]/g);
        if (!parts) {return Math.ceil(s.length / 4);}
        let t = 0;
        for (const p of parts) {t += p.length <= 4 ? 1 : 1 + Math.ceil((p.length - 4) / 4);}
        return t;
    }

    // Prefer REAL provider counts when the response carries a usage object
    // (OpenAI-compatible: prompt_tokens / completion_tokens / total_tokens).
    static fromUsage(usage) {
        if (!usage || typeof usage !== 'object') {return null;}
        const input = parseInt(usage.prompt_tokens, 10);
        const output = parseInt(usage.completion_tokens, 10);
        if (!Number.isFinite(input) && !Number.isFinite(output)) {return null;}
        return {
            inputTokens: Number.isFinite(input) ? input : 0,
            outputTokens: Number.isFinite(output) ? output : 0,
            estimated: false
        };
    }

    estimateFromCompletion(data, messages) {
        // real usage beats estimation; estimation beats nothing
        const real = UsageTracker.fromUsage(data && data.usage);
        if (real) {return real;}
        const est = this.estimateFromMessages(messages || []);
        const content = data && data.choices && data.choices[0]
            && (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
        if (content) {est.outputTokens = this.estimateTokens(content, 'output');}
        return est;
    }

    estimateFromMessages(messages) {
        let inputTokens = 0;
        const outputTokens = 0;

        for (const msg of messages) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            inputTokens += this.estimateTokens(content, 'input');
        }

        return { inputTokens, outputTokens, estimated: true };
    }

    async logRequest({
        userId,
        keyId,
        providerId,
        model,
        inputTokens,
        outputTokens,
        cost,
        latencyMs,
        status,
        errorMessage,
        ipAddress,
        userAgent,
        endpoint,
        anonymousVisitorId,
        tokensPerSec,
        feature
    }) {
        try {
            await this.pool.query(
                `INSERT INTO usage_logs
                 (user_id, key_id, provider_id, model, input_tokens, output_tokens, cost, latency_ms, status, error_message, ip_address, user_agent, endpoint, anonymous_visitor_id, tokens_per_sec, feature)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
                [
                    userId,
                    keyId,
                    providerId,
                    model,
                    inputTokens || 0,
                    outputTokens || 0,
                    cost || 0,
                    latencyMs || 0,
                    status || 'success',
                    errorMessage,
                    ipAddress,
                    userAgent,
                    endpoint || 'chat/completions',
                    anonymousVisitorId || null,
                    tokensPerSec || null,
                    feature || null
                ]
            );
            return true;
        } catch (err) {
            console.error('Failed to log usage:', err.message);
            return false;
        }
    }

    async getUsageForUser(userId, options = {}) {
        const { startDate, endDate, providerId, limit = 100 } = options;

        let query = `
            SELECT
                u.id, u.provider_id, u.model, u.input_tokens, u.output_tokens,
                u.total_tokens, u.cost, u.latency_ms, u.status, u.created_at,
                p.name as provider_name
            FROM usage_logs u
            LEFT JOIN ai_providers p ON u.provider_id = p.id
            WHERE u.user_id = $1
        `;
        const params = [userId];
        let paramIndex = 2;

        if (startDate) {
            query += ` AND u.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND u.created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        if (providerId) {
            query += ` AND u.provider_id = $${paramIndex}`;
            params.push(providerId);
            paramIndex++;
        }

        query += ` ORDER BY u.created_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        try {
            const result = await this.pool.query(query, params);
            return result.rows;
        } catch (err) {
            console.error('Failed to get user usage:', err.message);
            return [];
        }
    }

    async getAggregates(userId, groupBy = 'day', options = {}) {
        const { startDate, endDate, providerId } = options;

        // Whitelist the date_trunc unit so untrusted groupBy values can't reach SQL.
        const ALLOWED_UNITS = { hour: 'hour', day: 'day', month: 'month' };
        const dateTruncUnit = ALLOWED_UNITS[groupBy] || 'day';

        let query = `
            SELECT
                date_trunc('${dateTruncUnit}', created_at) as bucket,
                provider_id,
                SUM(total_requests) as total_requests,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost) as total_cost,
                AVG(latency_ms)::integer as avg_latency_ms
            FROM usage_logs
            WHERE user_id = $1
        `;
        const params = [userId];
        let paramIndex = 2;

        if (startDate) {
            query += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        if (providerId) {
            query += ` AND provider_id = $${paramIndex}`;
            params.push(providerId);
        }

        query += ' GROUP BY bucket, provider_id ORDER BY bucket DESC';

        try {
            const result = await this.pool.query(query, params);
            return result.rows;
        } catch (err) {
            console.error('Failed to get aggregates:', err.message);
            return [];
        }
    }

    async getTopProviders(userId, limit = 10) {
        try {
            const result = await this.pool.query(`
                SELECT
                    u.provider_id,
                    p.name as provider_name,
                    p.display_name,
                    COUNT(*) as request_count,
                    SUM(u.total_tokens) as total_tokens,
                    SUM(u.cost) as total_cost,
                    AVG(u.latency_ms)::integer as avg_latency_ms
                FROM usage_logs u
                JOIN ai_providers p ON u.provider_id = p.id
                WHERE u.user_id = $1
                GROUP BY u.provider_id, p.name, p.display_name
                ORDER BY total_cost DESC
                LIMIT $2
            `, [userId, limit]);
            return result.rows;
        } catch (err) {
            console.error('Failed to get top providers:', err.message);
            return [];
        }
    }

    async getMonthlyTrend(userId, months = 6) {
        // Clamp `months` to a safe integer so it can't be injected into the SQL.
        const safeMonths = Math.max(1, Math.min(120, parseInt(months, 10) || 6));
        try {
            const result = await this.pool.query(`
                SELECT
                    date_trunc('month', created_at) as month,
                    COUNT(*) as total_requests,
                    SUM(total_tokens) as total_tokens,
                    SUM(cost) as total_cost
                FROM usage_logs
                WHERE user_id = $1
                AND created_at > NOW() - ($2 || ' months')::interval
                GROUP BY month
                ORDER BY month ASC
            `, [userId, safeMonths]);
            return result.rows;
        } catch (err) {
            console.error('Failed to get monthly trend:', err.message);
            return [];
        }
    }
}

module.exports = UsageTracker;
