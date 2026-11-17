const crypto = require('crypto');

class CacheLayer {
    constructor(options = {}) {
        this.redis = null;
        this.localCache = new Map();
        this.ttl = options.ttl || 60000;
        this.localTtl = options.localTtl || 300000;
        this.enabled = false;
        this.redisAvailable = false;
    }

    async connect(redisConfig) {
        if (!redisConfig || !redisConfig.host) {
            console.log('Redis not configured, using in-memory cache only');
            this.enabled = true;
            this.startLocalCleanup();
            return;
        }

        try {
            const Redis = require('ioredis');
            this.redis = new Redis({
                host: redisConfig.host,
                port: redisConfig.port || 6379,
                password: redisConfig.password || undefined,
                maxRetriesPerRequest: 3,
                retryDelayOnFailover: 100,
                lazyConnect: true
            });

            this.redis.on('error', (err) => {
                if (this.redisAvailable) {
                    console.error('Redis error:', err.message);
                }
                this.redisAvailable = false;
            });

            this.redis.on('connect', () => {
                console.log('Redis connected');
                this.redisAvailable = true;
            });

            await this.redis.connect();
            this.enabled = true;
            this.redisAvailable = true;
            this.startLocalCleanup();
        } catch (err) {
            console.log('Redis connection failed, using in-memory cache:', err.message);
            this.enabled = true;
            this.startLocalCleanup();
        }
    }

    startLocalCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.localCache) {
                if (now - entry.timestamp > this.localTtl) {
                    this.localCache.delete(key);
                }
            }
        }, 60000);
    }

    generateKey(prefix, ...args) {
        const argsStr = args.map(a => {
            if (a === null || a === undefined) { return ''; }
            if (typeof a === 'object') { return JSON.stringify(a); }
            return String(a);
        }).join(':');
        return `${prefix}:${crypto.createHash('sha256').update(argsStr).digest('hex').slice(0, 16)}`;
    }

    async get(key) {
        if (!this.enabled) { return null; }

        if (this.localCache.has(key)) {
            const entry = this.localCache.get(key);
            if (Date.now() - entry.timestamp < this.ttl) {
                return entry.value;
            }
            this.localCache.delete(key);
        }

        if (this.redis && this.redisAvailable) {
            try {
                const value = await this.redis.get(key);
                if (value !== null) {
                    const parsed = JSON.parse(value);
                    this.localCache.set(key, { value: parsed, timestamp: Date.now() });
                    return parsed;
                }
            } catch (err) {
                console.error('Redis get error:', err.message);
            }
        }

        return null;
    }

    async set(key, value, ttl = this.ttl) {
        if (!this.enabled) { return; }

        this.localCache.set(key, { value, timestamp: Date.now() });

        if (this.redis && this.redisAvailable) {
            try {
                await this.redis.setex(key, Math.floor(ttl / 1000), JSON.stringify(value));
            } catch (err) {
                console.error('Redis set error:', err.message);
            }
        }
    }

    async del(key) {
        if (!this.enabled) { return; }

        this.localCache.delete(key);

        if (this.redis && this.redisAvailable) {
            try {
                await this.redis.del(key);
            } catch (err) {
                console.error('Redis del error:', err.message);
            }
        }
    }

    async invalidatePrefix(prefix) {
        if (!this.enabled) { return; }

        for (const key of this.localCache.keys()) {
            if (key.startsWith(prefix)) {
                this.localCache.delete(key);
            }
        }

        if (this.redis && this.redisAvailable) {
            try {
                const pattern = `${prefix}:*`;
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                }
            } catch (err) {
                console.error('Redis invalidate error:', err.message);
            }
        }
    }

    getStats() {
        return {
            localCacheSize: this.localCache.size,
            redisAvailable: this.redisAvailable,
            enabled: this.enabled
        };
    }
}

function createCache(options) {
    return new CacheLayer(options);
}

module.exports = { CacheLayer, createCache };
