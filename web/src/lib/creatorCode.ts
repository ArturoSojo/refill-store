/**
 * Código de creador traído por enlace (`?c=CODIGO`).
 *
 * Se guarda al aterrizar y se precarga en el checkout, porque sin descuento el
 * cliente no tiene ningún motivo para escribirlo a mano: la atribución tiene
 * que viajar sola desde el enlace que compartió el creador.
 *
 * Caduca a los 30 días para que una visita vieja no siga atribuyendo ventas.
 */
const KEY = 'refill.creatorCode';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Guardado {
  code: string;
  at: number;
}

export function rememberCreatorCode(code: string): void {
  const clean = code.trim().toUpperCase().replace(/\s+/g, '').slice(0, 24);
  if (!clean) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: clean, at: Date.now() } satisfies Guardado));
  } catch {
    // Modo privado o almacenamiento lleno: la atribución se pierde, no pasa nada.
  }
}

export function readCreatorCode(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return '';
    const saved = JSON.parse(raw) as Guardado;
    if (!saved?.code || Date.now() - saved.at > TTL_MS) {
      localStorage.removeItem(KEY);
      return '';
    }
    return saved.code;
  } catch {
    return '';
  }
}

/** Lee `?c=` de la URL actual y lo guarda. Devuelve el código si lo había. */
export function captureCreatorCodeFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('c');
  if (!code) return '';
  rememberCreatorCode(code);
  return code.trim().toUpperCase();
}
