const crypto = require('crypto');

// THE SETUP
const ALGORITHM = 'aes-256-cbc';
const MASTER_KEY_FROM_ENV = 'this_is_exactly_32_char_key_!!!!'; // Exactly 32 bytes
const samplePassword = 'golde6907614d7ad6c@ssl';

console.log('--- STEP 1: INITIALIZATION ---');
console.log('Original Password to hide:', samplePassword);
console.log('Master Key (from .env):', MASTER_KEY_FROM_ENV);

// --- STEP 2: IV GENERATION ---
// We generate a new, random IV for EVERY encryption. 
// This is critical. Even if 10 departments have the SAME password, 
// their encrypted versions will look totally different in the DB.
const iv = crypto.randomBytes(16);
console.log('\n--- STEP 2: IV GENERATION ---');
console.log('Generated Random IV (Hex):', iv.toString('hex'));
console.log('Think of this IV as a unique "salt" that makes this specific encryption unique.');

// --- STEP 3: THE CIPHERING ---
console.log('\n--- STEP 3: THE CIPHERING (THE SCRAMBLING) ---');
const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY_FROM_ENV), iv);

// We feed the password into the cipher
let encrypted = cipher.update(samplePassword, 'utf8', 'hex');
console.log('Partially Scrambled:', encrypted);

// We finish the scrambling process
encrypted += cipher.final('hex');
console.log('Final Scrambled Result (Ciphertext):', encrypted);

// --- STEP 4: STORAGE LOGIC ---
console.log('\n--- STEP 4: STORAGE IN MONGODB ---');
const objectToStoreInDB = {
    departmentName: 'CSE',
    storeId: 'golde6907614d7ad6c',
    encryptedPassword: encrypted,  // The scrambled string
    iv: iv.toString('hex')         // We MUST store the IV next to it, or we can't unlock it!
};
console.log('What we actually save in the Database:');
console.log(JSON.stringify(objectToStoreInDB, null, 2));
console.log('\nNOTE: The original password is now gone. Only the scrambled version exists in the DB.');

// --- STEP 5: UNLOCKING (DECRYPTION) ---
console.log('\n--- STEP 5: UNLOCKING (WHEN A STUDENT PAYS) ---');
console.log('1. Pull encryptedPassword and iv from DB...');
console.log('2. Pull Master Key from .env...');

const ivFromDB = Buffer.from(objectToStoreInDB.iv, 'hex');
const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(MASTER_KEY_FROM_ENV), ivFromDB);

let decrypted = decipher.update(objectToStoreInDB.encryptedPassword, 'hex', 'utf8');
decrypted += decipher.final('utf8');

console.log('3. Deciphering result:', decrypted);
console.log('--- PROCESS COMPLETE ---');
