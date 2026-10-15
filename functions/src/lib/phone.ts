/**
 * Utilidades para normalización y validación de números telefónicos.
 */

/**
 * Normaliza teléfonos venezolanos e internacionales a formato estándar E.164.
 * Ejemplos:
 *  - '04121234567' -> '+584121234567'
 *  - '4121234567'  -> '+584121234567'
 *  - '0412-123.45.67' -> '+584121234567'
 *  - '+584121234567' -> '+584121234567'
 *  - '584121234567'  -> '+584121234567'
 *  - '+1 305 555 1234' -> '+13055551234'
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let cleaned = raw.trim();
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }
  const hasPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';

  // Si ya tiene el código de Venezuela (58)
  if (digits.startsWith('58')) {
    if (digits.length >= 11 && digits.length <= 13) {
      return `+${digits}`;
    }
  }

  // Número venezolano con cero inicial (ej. 04121234567, 0414..., 0424..., 0416..., 0426..., 0212...)
  if (digits.startsWith('0') && digits.length === 11) {
    return `+58${digits.slice(1)}`;
  }

  // Número venezolano sin cero inicial (ej. 4121234567, 4141234567, 424..., 416..., 426...)
  if (digits.length === 10 && (digits.startsWith('4') || digits.startsWith('2'))) {
    return `+58${digits}`;
  }

  // Si tenía prefijo internacional explícito con +
  if (hasPlus) {
    return `+${digits}`;
  }

  // Si son 11 dígitos y empieza con 1 (US / Canadá)
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // Por defecto, si tiene 10 dígitos y no tenía +, asumimos Venezuela
  if (digits.length === 10) {
    return `+58${digits}`;
  }

  return `+${digits}`;
}

export function isValidPhone(raw: string | null | undefined): boolean {
  const normalized = normalizePhone(raw);
  return /^\+[1-9]\d{7,14}$/.test(normalized);
}

export function isPhoneInput(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.includes('@')) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && /^[\d+\s().-]+$/.test(trimmed);
}

export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return '***';
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  if (user.length <= 2) {
    return `${user[0]}***@${domain}`;
  }
  return `${user.slice(0, 2)}***@${domain}`;
}
