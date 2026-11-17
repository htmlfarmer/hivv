const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const CircuitBreaker = require('../lib/circuit-breaker');

describe('CircuitBreaker', () => {
    let cb;

    beforeEach(() => {
        cb = new CircuitBreaker({
            failureThreshold: 3,
            successThreshold: 2,
            timeout: 1000
        });
    });

    it('should start in CLOSED state', () => {
        const state = cb.getState('test-provider');
        assert.strictEqual(state.state, 'CLOSED');
        assert.strictEqual(state.failures, 0);
    });

    it('should execute function and return result on success', async () => {
        const result = await cb.execute('test', async () => 'success');
        assert.strictEqual(result, 'success');
    });

    it('should record failures and open circuit after threshold', async () => {
        const failingFn = async () => {
            throw new Error('Provider failed');
        };

        for (let i = 0; i < 3; i++) {
            try {
                await cb.execute('failing-provider', failingFn);
            } catch (e) {}
        }

        const state = cb.getState('failing-provider');
        assert.strictEqual(state.state, 'OPEN');
        assert.strictEqual(state.failures, 3);
    });

    it('should reject calls immediately when OPEN', async () => {
        const failingFn = async () => {
            throw new Error('Provider failed');
        };

        for (let i = 0; i < 3; i++) {
            try {
                await cb.execute('open-provider', failingFn);
            } catch (e) {}
        }

        await assert.rejects(
            cb.execute('open-provider', async () => 'should fail'),
            /Circuit breaker OPEN/
        );
    });

    it('should reset circuit after timeout in half-open state', async () => {
        cb = new CircuitBreaker({
            failureThreshold: 2,
            successThreshold: 2,
            timeout: 100
        });

        const failingFn = async () => {
            throw new Error('Provider failed');
        };

        for (let i = 0; i < 2; i++) {
            try {
                await cb.execute('timeout-provider', failingFn);
            } catch (e) {}
        }

        assert.strictEqual(cb.getState('timeout-provider').state, 'OPEN');

        await new Promise(resolve => setTimeout(resolve, 150));

        await cb.execute('timeout-provider', async () => 'recovered');

        assert.strictEqual(cb.getState('timeout-provider').state, 'HALF_OPEN');
    });

    it('should track successes in half-open state', async () => {
        cb = new CircuitBreaker({
            failureThreshold: 2,
            successThreshold: 2,
            timeout: 50
        });

        const failingFn = async () => {
            throw new Error('Provider failed');
        };

        for (let i = 0; i < 2; i++) {
            try {
                await cb.execute('half-open-provider', failingFn);
            } catch (e) {}
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        await cb.execute('half-open-provider', async () => 'success 1');
        await cb.execute('half-open-provider', async () => 'success 2');

        assert.strictEqual(cb.getState('half-open-provider').state, 'CLOSED');
    });

    it('should report if circuit is open', async () => {
        cb = new CircuitBreaker({ failureThreshold: 1, timeout: 1000 });

        assert.strictEqual(cb.isOpen('unknown'), false);

        try {
            await cb.execute('quick-fail', async () => { throw new Error('fail'); });
        } catch (e) {}

        assert.strictEqual(cb.isOpen('quick-fail'), true);
    });

    it('should allow manual reset', async () => {
        cb = new CircuitBreaker({ failureThreshold: 1, timeout: 1000 });

        try {
            await cb.execute('reset-me', async () => { throw new Error('fail'); });
        } catch (e) {}

        assert.strictEqual(cb.isOpen('reset-me'), true);

        cb.reset('reset-me');

        assert.strictEqual(cb.isOpen('reset-me'), false);
    });
});
