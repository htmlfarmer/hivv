const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.HIVV_ENCRYPTION_KEY = 'a'.repeat(64);

const { encryptKey, decryptKey, hashToken, generateSecureToken, generateEncryptionKey } = require('../lib/crypto-utils');

describe('Crypto Utils', () => {
    describe('encryptKey / decryptKey', () => {
        it('should encrypt and decrypt a string', () => {
            const plaintext = 'sk-test-api-key-12345';
            const encrypted = encryptKey(plaintext);

            assert.notStrictEqual(encrypted, plaintext);
            assert.ok(encrypted.includes(':'));

            const decrypted = decryptKey(encrypted);
            assert.strictEqual(decrypted, plaintext);
        });

        it('should return null for null input', () => {
            assert.strictEqual(encryptKey(null), null);
            assert.strictEqual(decryptKey(null), null);
        });

        it('should return original value if not encrypted format', () => {
            const plaintext = 'plain-old-value';
            assert.strictEqual(decryptKey(plaintext), plaintext);
        });

        it('should produce different ciphertext each time (random IV)', () => {
            const plaintext = 'same-text';
            const encrypted1 = encryptKey(plaintext);
            const encrypted2 = encryptKey(plaintext);

            assert.notStrictEqual(encrypted1, encrypted2);

            assert.strictEqual(decryptKey(encrypted1), plaintext);
            assert.strictEqual(decryptKey(encrypted2), plaintext);
        });

        it('should handle empty string', () => {
            const encrypted = encryptKey('');
            const decrypted = decryptKey(encrypted);
            assert.strictEqual(decrypted, '');
        });

        it('should handle unicode characters', () => {
            const plaintext = 'Hello 世界 🌍';
            const encrypted = encryptKey(plaintext);
            const decrypted = decryptKey(encrypted);
            assert.strictEqual(decrypted, plaintext);
        });

        it('should handle long strings', () => {
            const plaintext = 'x'.repeat(10000);
            const encrypted = encryptKey(plaintext);
            const decrypted = decryptKey(encrypted);
            assert.strictEqual(decrypted, plaintext);
        });
    });

    describe('hashToken', () => {
        it('should produce consistent hashes', () => {
            const token = 'my-secret-token';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);

            assert.strictEqual(hash1, hash2);
        });

        it('should produce different hashes for different inputs', () => {
            const hash1 = hashToken('token1');
            const hash2 = hashToken('token2');

            assert.notStrictEqual(hash1, hash2);
        });

        it('should produce hex string', () => {
            const hash = hashToken('test');
            assert.ok(/^[a-f0-9]+$/.test(hash));
        });

        it('should produce 64-char hash (SHA-256)', () => {
            const hash = hashToken('test');
            assert.strictEqual(hash.length, 64);
        });
    });

    describe('generateSecureToken', () => {
        it('should generate token of specified length', () => {
            const token = generateSecureToken(16);
            assert.strictEqual(token.length, 32);
        });

        it('should generate different tokens each call', () => {
            const token1 = generateSecureToken();
            const token2 = generateSecureToken();
            assert.notStrictEqual(token1, token2);
        });

        it('should generate hex string', () => {
            const token = generateSecureToken();
            assert.ok(/^[a-f0-9]+$/.test(token));
        });
    });

    describe('generateEncryptionKey', () => {
        it('should generate 64-char hex key', () => {
            const key = generateEncryptionKey();
            assert.strictEqual(key.length, 64);
            assert.ok(/^[a-f0-9]+$/.test(key));
        });

        it('should generate different keys each call', () => {
            const key1 = generateEncryptionKey();
            const key2 = generateEncryptionKey();
            assert.notStrictEqual(key1, key2);
        });
    });
});
