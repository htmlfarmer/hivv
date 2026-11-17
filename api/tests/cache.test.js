const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const { CacheLayer, createCache } = require('../lib/cache');

describe('CacheLayer', () => {
    let cache;

    beforeEach(() => {
        cache = createCache({ ttl: 100, localTtl: 200 });
        cache.enabled = true;
    });

    describe('generateKey', () => {
        it('should generate consistent keys for same input', () => {
            const key1 = cache.generateKey('prefix', 'arg1', 'arg2');
            const key2 = cache.generateKey('prefix', 'arg1', 'arg2');
            assert.strictEqual(key1, key2);
        });

        it('should generate different keys for different arguments', () => {
            const key1 = cache.generateKey('prefix', 'arg1');
            const key2 = cache.generateKey('prefix', 'arg2');
            assert.notStrictEqual(key1, key2);
        });

        it('should generate different keys for different prefixes', () => {
            const key1 = cache.generateKey('prefix1', 'arg');
            const key2 = cache.generateKey('prefix2', 'arg');
            assert.notStrictEqual(key1, key2);
        });

        it('should handle object arguments', () => {
            const key = cache.generateKey('prefix', { a: 1, b: 2 });
            assert.ok(key.startsWith('prefix:'));
        });
    });

    describe('local cache', () => {
        it('should store and retrieve values', async () => {
            await cache.set('test-key', { value: 'test-data' });
            const result = await cache.get('test-key');
            assert.deepStrictEqual(result, { value: 'test-data' });
        });

        it('should return null for missing keys', async () => {
            const result = await cache.get('non-existent-key');
            assert.strictEqual(result, null);
        });

        it('should delete values', async () => {
            await cache.set('delete-key', 'value');
            await cache.del('delete-key');
            const result = await cache.get('delete-key');
            assert.strictEqual(result, null);
        });

        it('should expire values after TTL', async () => {
            await cache.set('expire-key', 'value');

            const beforeExpire = await cache.get('expire-key');
            assert.strictEqual(beforeExpire, 'value');

            await new Promise(resolve => setTimeout(resolve, 150));

            const afterExpire = await cache.get('expire-key');
            assert.strictEqual(afterExpire, null);
        });

        it('should overwrite existing values', async () => {
            await cache.set('overwrite-key', 'value1');
            await cache.set('overwrite-key', 'value2');

            const result = await cache.get('overwrite-key');
            assert.strictEqual(result, 'value2');
        });
    });

    describe('invalidatePrefix', () => {
        it('should invalidate all keys with matching prefix', async () => {
            await cache.set('users:1', 'user1');
            await cache.set('users:2', 'user2');
            await cache.set('products:1', 'product1');

            await cache.invalidatePrefix('users');

            assert.strictEqual(await cache.get('users:1'), null);
            assert.strictEqual(await cache.get('users:2'), null);
            assert.strictEqual(await cache.get('products:1'), 'product1');
        });
    });

    describe('getStats', () => {
        it('should return cache statistics', async () => {
            await cache.set('stat-key', 'value');

            const stats = cache.getStats();

            assert.strictEqual(stats.enabled, true);
            assert.strictEqual(stats.localCacheSize, 1);
            assert.strictEqual(stats.redisAvailable, false);
        });
    });

    describe('disabled state', () => {
        it('should return null for get when disabled', async () => {
            cache.enabled = false;
            const result = await cache.get('any-key');
            assert.strictEqual(result, null);
        });

        it('should not store values when disabled', async () => {
            cache.enabled = false;
            await cache.set('any-key', 'value');
            assert.strictEqual(await cache.get('any-key'), null);
        });
    });
});

describe('createCache', () => {
    it('should create cache instance with default options', () => {
        const cache = createCache();
        assert.ok(cache instanceof CacheLayer);
        assert.strictEqual(cache.ttl, 60000);
        assert.strictEqual(cache.localTtl, 300000);
    });

    it('should create cache instance with custom options', () => {
        const cache = createCache({ ttl: 5000, localTtl: 10000 });
        assert.ok(cache instanceof CacheLayer);
        assert.strictEqual(cache.ttl, 5000);
        assert.strictEqual(cache.localTtl, 10000);
    });
});
