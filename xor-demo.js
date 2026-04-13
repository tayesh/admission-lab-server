// XOR Demo: The magic "light switch" of encryption

const char = 'A';    // Our data
const key = 'K';     // Our secret key

// 1. Get Binary (ASCII)
const charBin = char.charCodeAt(0).toString(2).padStart(8, '0');
const keyBin = key.charCodeAt(0).toString(2).padStart(8, '0');

console.log(`Character: '${char}' -> Binary: ${charBin}`);
console.log(`Key:       '${key}' -> Binary: ${keyBin}`);
console.log('------------------------------------');

// 2. Perform XOR (The Scramble)
// Rule: 1 if bits are different, 0 if they are the same
let scrambledBin = '';
for (let i = 0; i < 8; i++) {
    scrambledBin += (charBin[i] ^ keyBin[i]);
}

const scrambledChar = String.fromCharCode(parseInt(scrambledBin, 2));
console.log(`SCRAMBLED:  Binary: ${scrambledBin} -> Char: '${scrambledChar}'`);
console.log('(Notice how the character is now a weird symbol or unreadable)');
console.log('------------------------------------');

// 3. Perform XOR Again (The Un-Scramble)
// Rule: XORing the scrambled result with the SAME key brings back the original!
let unscrambledBin = '';
for (let i = 0; i < 8; i++) {
    unscrambledBin += (scrambledBin[i] ^ keyBin[i]);
}

const unscrambledChar = String.fromCharCode(parseInt(unscrambledBin, 2));
console.log(`UNSCRAMBLED: Binary: ${unscrambledBin} -> Char: '${unscrambledChar}'`);

if (char === unscrambledChar) {
    console.log('\nSUCCESS: XOR is perfectly reversible!');
}
