/**
 * Modales de la tienda: ventanas superpuestas que explican algo al cliente.
 *
 * Nacieron para el tutorial de «cómo recargar», que hasta ahora había que
 * explicar por WhatsApp uno por uno. Se guardan en su propia colección, y no en
 * la configuración, porque son varios y el administrador los crea y borra como
 * los cupones.
 */
import { modals, now } from '../config/firebase';
import { notFound } from '../lib/errors';
import { slugify } from '../lib/ids';
import type { StoreModal } from '../types/models';

/** Campos que pueden faltar en documentos creados antes de añadirlos. */
function toModal(id: string, data: FirebaseFirestore.DocumentData): StoreModal {
  return {
    id,
    title: '',
    body: '',
    videoUrl: '',
    imageUrl: '',
    ctaLabel: '',
    ctaUrl: '',
    active: false,
    frequency: 'once',
    placement: 'home',
    sortOrder: 99,
    createdAt: now(),
    updatedAt: now(),
    ...data,
  } as StoreModal;
}

export async function list(options: { onlyActive?: boolean } = {}): Promise<StoreModal[]> {
  const snap = await modals().get();
  const all = snap.docs.map((doc) => toModal(doc.id, doc.data()));
  const filtered = options.onlyActive ? all.filter((modal) => modal.active) : all;
  return filtered.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export async function get(id: string): Promise<StoreModal> {
  const snap = await modals().doc(id).get();
  if (!snap.exists) throw notFound('Ese modal no existe.');
  return toModal(snap.id, snap.data() ?? {});
}

export interface ModalInput {
  title: string;
  body: string;
  videoUrl: string;
  imageUrl: string;
  ctaLabel: string;
  ctaUrl: string;
  active: boolean;
  frequency: StoreModal['frequency'];
  placement: StoreModal['placement'];
  sortOrder: number;
}

export async function save(id: string | undefined, input: ModalInput): Promise<StoreModal> {
  const docId = id ?? (slugify(input.title) || `modal-${Date.now()}`);
  const ref = modals().doc(docId);
  const existing = await ref.get();

  await ref.set(
    {
      ...input,
      ...(existing.exists ? {} : { createdAt: now() }),
      updatedAt: now(),
    },
    { merge: true }
  );

  return get(docId);
}

export async function remove(id: string): Promise<void> {
  await get(id); // Lanza si no existe: borrar algo inexistente debe avisar.
  await modals().doc(id).delete();
}

/**
 * Convierte cualquier enlace de YouTube en uno incrustable.
 *
 * El administrador va a pegar lo que le dé el botón de compartir —un `youtu.be`
 * o un Short—, no la URL de incrustación. Traducirlo aquí evita que el modal
 * salga en blanco por pegar el enlace «equivocado».
 */
export function toEmbedUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';

  const patterns = [
    /youtu\.be\/([\w-]{6,})/i,
    /youtube\.com\/shorts\/([\w-]{6,})/i,
    /youtube\.com\/embed\/([\w-]{6,})/i,
    /[?&]v=([\w-]{6,})/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return `https://www.youtube.com/embed/${match[1]}`;
  }

  // No se reconoce: se devuelve vacío en vez de incrustar una URL cualquiera,
  // que es como se cuela contenido de terceros en la tienda.
  return '';
}
