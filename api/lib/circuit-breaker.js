class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 3;
        this.timeout = options.timeout || 60000;
        this.providers = new Map();
    }

    getProviderState(name) {
        if (!this.providers.has(name)) {
            this.providers.set(name, {
                state: 'CLOSED',
                failures: 0,
                successes: 0,
                nextAttempt: 0
            });
        }
        return this.providers.get(name);
    }

    async execute(name, fn) {
        const state = this.getProviderState(name);

        if (state.state === 'OPEN') {
            if (Date.now() < state.nextAttempt) {
                throw new Error(`Circuit breaker OPEN for ${name}. Retry after ${new Date(state.nextAttempt).toISOString()}`);
            }
            state.state = 'HALF_OPEN';
        }

        try {
            const result = await fn();
            this.onSuccess(name);
            return result;
        } catch (error) {
            this.onFailure(name);
            throw error;
        }
    }

    onSuccess(name) {
        const state = this.getProviderState(name);
        state.failures = 0;

        if (state.state === 'HALF_OPEN') {
            state.successes++;
            if (state.successes >= this.successThreshold) {
                state.state = 'CLOSED';
                state.successes = 0;
            }
        }
    }

    onFailure(name) {
        const state = this.getProviderState(name);
        state.failures++;
        state.successes = 0;

        if (state.failures >= this.failureThreshold) {
            state.state = 'OPEN';
            state.nextAttempt = Date.now() + this.timeout;
        }
    }

    getState(name) {
        return this.getProviderState(name);
    }

    reset(name) {
        if (name) {
            this.providers.delete(name);
        } else {
            this.providers.clear();
        }
    }

    isOpen(name) {
        const state = this.getProviderState(name);
        return state.state === 'OPEN';
    }
}

module.exports = CircuitBreaker;
