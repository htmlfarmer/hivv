class RateLimiter {
    constructor(pool) {
        this.pool = pool;
        this.inMemoryLimits = new Map();
        this.windowMs = 60 * 1000;
        this.defaultLimits = {
            requestsPerMinute: 60,
            requestsPerHour: 1000,
            requestsPerDay: 10000
        };
    }

    async getUserQuota(userId, providerId = null) {
        try {
            const result = await this.pool.query(
                'SELECT * FROM user_quotas WHERE user_id = $1 AND (provider_id = $2 OR provider_id IS NULL)',
                [userId, providerId]
            );
            if (result.rows.length > 0) {
                return result.rows[0];
            }
        } catch (err) {
            console.error('Failed to get user quota:', err.message);
        }
        return null;
    }

    async getUserUsage(userId, providerId = null) {
        const now = new Date();
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const dayAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1);

        try {
            const [hourResult, dayResult, monthResult] = await Promise.all([
                this.pool.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(total_tokens), 0) as tokens
                    FROM usage_logs
                    WHERE user_id = $1 AND created_at > $2
                    ${providerId ? 'AND provider_id = $3' : ''}
                `, providerId ? [userId, hourAgo, providerId] : [userId, hourAgo]),

                this.pool.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(total_tokens), 0) as tokens
                    FROM usage_logs
                    WHERE user_id = $1 AND created_at > $2
                    ${providerId ? 'AND provider_id = $3' : ''}
                `, providerId ? [userId, dayAgo, providerId] : [userId, dayAgo]),

                this.pool.query(`
                    SELECT COUNT(*) as count, COALESCE(SUM(total_tokens), 0) as tokens
                    FROM usage_logs
                    WHERE user_id = $1 AND created_at > $2
                    ${providerId ? 'AND provider_id = $3' : ''}
                `, providerId ? [userId, monthAgo, providerId] : [userId, monthAgo])
            ]);

            return {
                requestsThisHour: parseInt(hourResult.rows[0].count),
                requestsToday: parseInt(dayResult.rows[0].count),
                requestsThisMonth: parseInt(monthResult.rows[0].count),
                tokensThisHour: parseInt(hourResult.rows[0].tokens),
                tokensToday: parseInt(dayResult.rows[0].tokens),
                tokensThisMonth: parseInt(monthResult.rows[0].tokens)
            };
        } catch (err) {
            console.error('Failed to get user usage:', err.message);
            return {
                requestsThisHour: 0,
                requestsToday: 0,
                requestsThisMonth: 0,
                tokensThisHour: 0,
                tokensToday: 0,
                tokensThisMonth: 0
            };
        }
    }

    async checkLimit(userId, providerId = null) {
        const quota = await this.getUserQuota(userId, providerId);
        const usage = await this.getUserUsage(userId, providerId);

        const limits = {
            requestsPerHour: quota?.requests_per_hour || this.defaultLimits.requestsPerHour,
            requestsPerDay: quota?.requests_per_day || this.defaultLimits.requestsPerDay,
            requestsPerMonth: quota?.requests_per_month || this.defaultLimits.requestsPerMonth,
            tokensPerHour: quota?.tokens_per_hour || 100000,
            tokensPerDay: quota?.tokens_per_day || 500000,
            tokensPerMonth: quota?.tokens_per_month || 2000000
        };

        const remaining = {
            requestsPerHour: Math.max(0, limits.requestsPerHour - usage.requestsThisHour),
            requestsPerDay: Math.max(0, limits.requestsPerDay - usage.requestsToday),
            requestsPerMonth: Math.max(0, limits.requestsPerMonth - usage.requestsThisMonth),
            tokensPerHour: Math.max(0, limits.tokensPerHour - usage.tokensThisHour),
            tokensPerDay: Math.max(0, limits.tokensPerDay - usage.tokensToday),
            tokensPerMonth: Math.max(0, limits.tokensPerMonth - usage.tokensThisMonth)
        };

        const allowed = {
            requests: remaining.requestsPerHour > 0 && remaining.requestsPerDay > 0 && remaining.requestsPerMonth > 0,
            tokens: remaining.tokensPerHour > 0 && remaining.tokensPerDay > 0 && remaining.tokensPerMonth > 0
        };

        return {
            allowed: allowed.requests && allowed.tokens,
            limits,
            remaining,
            usage,
            quota
        };
    }

    checkInMemoryLimit(key, maxRequests, windowMs) {
        const now = Date.now();
        const keyData = this.inMemoryLimits.get(key) || { requests: [], tokens: 0 };

        keyData.requests = keyData.requests.filter(t => now - t < windowMs);

        if (keyData.requests.length >= maxRequests) {
            return { allowed: false, remaining: 0, resetAt: keyData.requests[0] + windowMs };
        }

        keyData.requests.push(now);
        this.inMemoryLimits.set(key, keyData);

        return {
            allowed: true,
            remaining: maxRequests - keyData.requests.length,
            resetAt: now + windowMs
        };
    }

    getInMemoryStatus(key, maxRequests, windowMs) {
        const now = Date.now();
        const keyData = this.inMemoryLimits.get(key) || { requests: [], tokens: 0 };

        const validRequests = keyData.requests.filter(t => now - t < windowMs);

        return {
            current: validRequests.length,
            max: maxRequests,
            remaining: Math.max(0, maxRequests - validRequests.length),
            resetAt: validRequests.length > 0
                ? Math.min(...validRequests) + windowMs
                : now
        };
    }
}

class IPBasedLimiter {
    constructor() {
        this.requests = new Map();
        this.windowMs = 60 * 1000;
        this.maxRequests = 60;
    }

    check(ip) {
        const now = Date.now();
        const key = `ip:${ip}`;
        const data = this.requests.get(key) || [];

        const valid = data.filter(t => now - t < this.windowMs);
        valid.push(now);
        this.requests.set(key, valid);

        if (valid.length > this.maxRequests) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: valid[0] + this.windowMs
            };
        }

        return {
            allowed: true,
            remaining: this.maxRequests - valid.length,
            resetAt: now + this.windowMs
        };
    }

    cleanup() {
        const now = Date.now();
        for (const [key, times] of this.requests) {
            const valid = times.filter(t => now - t < this.windowMs * 2);
            if (valid.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, valid);
            }
        }
    }
}

module.exports = { RateLimiter, IPBasedLimiter };
