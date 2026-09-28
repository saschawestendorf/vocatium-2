// Kryptografische Hilfsfunktionen für Codes und Zugriffstoken.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const generateCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');

export const generateToken = () => randomBytes(32).toString('base64url');

// HMAC statt reinem Hash: ohne APP_SECRET sind 6-stellige Codes nicht per Brute-Force aus der DB rückrechenbar.
export const hmac = (secret, value) => createHmac('sha256', secret).update(String(value)).digest('hex');

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
