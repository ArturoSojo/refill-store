/** Generadores de identificadores legibles. */
import { randomBytes, randomInt } from 'node:crypto';

/** Sin I, O, 0, 1 para que nadie se confunda dictando un código por teléfono. */
const SAFE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomFromAlphabet(length: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Código de orden que ve el cliente: `RF-8K3M2Q`. */
export function generateOrderCode(): string {
  return `RF-${randomFromAlphabet(6, SAFE_ALPHABET)}`;
}

/** Código de referido personal: `REF-J7K2M9`. */
export function generateReferralCode(): string {
  return `REF-${randomFromAlphabet(6, SAFE_ALPHABET)}`;
}

/** Token opaco para operaciones internas. */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Normaliza una referencia bancaria: sólo dígitos.
 * Los clientes suelen pegarla con espacios, guiones o el prefijo "Ref.".
 */
export function normalizeReference(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Slug apto para ID de documento. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
