/**
 * Encryption Module - AES-256-GCM Implementation
 * 
 * Provides secure encryption and decryption for sensitive data like API keys.
 * Uses AES-256-GCM (Galois/Counter Mode) for authenticated encryption.
 * 
 * Format: iv:authTag:encryptedData (all hex encoded)
 */

import crypto from 'crypto';
import { config } from './config.js';

// Error classes for better error handling
export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function getCipherKey(): Buffer {
  const rawKey = config.encryption.key;
  if (!rawKey && config.security.requireEncryptionKey) {
    throw new EncryptionError(
      'ENCRYPTION_KEY is not set and REQUIRE_ENCRYPTION_KEY is enabled. ' +
      'Set ENCRYPTION_KEY in your .env file before using encryption in production.'
    );
  }
  return crypto.createHash('sha256').update(String(rawKey), 'utf8').digest();
}

/**
 * Encrypts text using AES-256-GCM
 * @param text - The plaintext to encrypt
 * @returns Encrypted string in format: iv:authTag:encryptedData (hex encoded)
 * @throws EncryptionError if encryption fails
 */
export function encrypt(text: string): string {
  try {
    const { algorithm, ivLength, authTagLength } = config.encryption;
    
    // Generate random IV for each encryption
    const iv = crypto.randomBytes(ivLength);
    
    // Create cipher with AES-256-GCM
    const cipher = crypto.createCipheriv(algorithm, getCipherKey(), iv, {
      authTagLength,
    });
    
    // Encrypt the text
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    
    // Get authentication tag
    const authTag = cipher.getAuthTag();
    
    // Return format: iv:authTag:encryptedData (all hex encoded)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    throw new EncryptionError(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Decrypts text that was encrypted with encrypt()
 * @param encryptedText - The encrypted string in format: iv:authTag:encryptedData
 * @returns Decrypted plaintext
 * @throws DecryptionError if decryption fails (including tampering detection)
 */
export function decrypt(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    
    if (parts.length !== 3) {
      throw new DecryptionError('Invalid encrypted text format');
    }
    
    const [ivHex, authTagHex, encryptedHex] = parts;
    
    // Parse hex strings back to buffers
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    const { algorithm, authTagLength } = config.encryption;
    
    // Create decipher
    const decipher = crypto.createDecipheriv(algorithm, getCipherKey(), iv, {
      authTagLength,
    });
    
    // Set the authentication tag to verify
    decipher.setAuthTag(authTag);
    
    // Decrypt
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
    
    return decrypted;
  } catch (error) {
    // If it's already a DecryptionError, rethrow it
    if (error instanceof DecryptionError) {
      throw error;
    }
    // Authentication tag mismatch or other decryption errors
    throw new DecryptionError(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}. The data may have been tampered with.`);
  }
}

/**
 * Validates if a string appears to be encrypted (format check)
 * @param text - The string to validate
 * @returns true if the string matches encrypted format
 */
export function isEncrypted(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  const parts = text.split(':');
  if (parts.length !== 3) {
    return false;
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  
  // Check if all parts are valid hex strings
  // IV: 12 bytes = 24 hex chars, AuthTag: 16 bytes = 32 hex chars
  return /^[a-fA-F0-9]{24}$/.test(ivHex) && 
         /^[a-fA-F0-9]{32}$/.test(authTagHex) && 
         /^[a-fA-F0-9]+$/.test(encryptedHex);
}

/**
 * Convenience function to encrypt an object (serializes to JSON first)
 * @param obj - The object to encrypt
 * @returns Encrypted string
 */
export function encryptObject(obj: object): string {
  return encrypt(JSON.stringify(obj));
}

/**
 * Convenience function to decrypt to an object (parses JSON)
 * @param encryptedText - The encrypted string
 * @returns Parsed object
 */
export function decryptObject<T>(encryptedText: string): T {
  const decrypted = decrypt(encryptedText);
  return JSON.parse(decrypted) as T;
}

// Export utility functions
export default {
  encrypt,
  decrypt,
  encryptObject,
  decryptObject,
  isEncrypted,
  EncryptionError,
  DecryptionError,
};
