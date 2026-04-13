const crypto = require('crypto');

// 1. The Ingredients
const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = crypto.randomBytes(32); // In real app, this goes in .env
const IV = crypto.randomBytes(16);         // A new one is generated for every encryption

const samplePassword = 'my_secure_store_password_123';

console.log('--- ENCRYPTION PROCESS ---');
console.log('Original Password:', samplePassword);

// 2. Encryption (The Lock)
const encrypt = (text) => {
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, IV);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
};

const encryptedData = encrypt(samplePassword);
console.log('Encrypted (stored in DB):', encryptedData);
console.log('IV (also stored in DB):', IV.toString('hex'));

console.log('\n--- DECRYPTION PROCESS ---');

// 3. Decryption (The Unlock)
const decrypt = (encryptedText, ivHex) => {
    const ivBuffer = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, ivBuffer);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
};

const decryptedData = decrypt(encryptedData, IV.toString('hex'));
console.log('Decrypted Password:', decryptedData);

if (samplePassword === decryptedData) {
    console.log('\nSUCCESS: The passwords match!');
} else {
    console.log('\nFAILURE: Something went wrong.');
}
