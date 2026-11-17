const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getEncryptionKey() {
    const key = process.env.HIVV_ENCRYPTION_KEY;
    if (!key) {
        throw new Error('HIVV_ENCRYPTION_KEY environment variable is required for key encryption');
    }
    const buffer = Buffer.from(key, 'hex');
    if (buffer.length !== KEY_LENGTH) {
        throw new Error('HIVV_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return buffer;
}

function encryptKey(plaintext) {
    if (plaintext === null || plaintext === undefined) {return null;}

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')  }:${  authTag.toString('hex')  }:${  encrypted}`;
}

function decryptKey(encryptedData) {
    if (!encryptedData) {return null;}

    try {
        const key = getEncryptionKey();
        const parts = encryptedData.split(':');

        if (parts.length !== 3) {
            return encryptedData;
        }

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return null;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

function generateEncryptionKey() {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

module.exports = {
    encryptKey,
    decryptKey,
    hashToken,
    generateSecureToken,
    generateEncryptionKey,
    ALGORITHM
};
