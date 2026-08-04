/**
 * Selector de imagen con subida a Cloud Storage.
 *
 * Antes el panel sólo aceptaba una URL pegada a mano, lo que obligaba a subir
 * la imagen a otro sitio primero. Aquí se elige el archivo y se sube; la URL se
 * rellena sola.
 *
 * La imagen se reescala en el navegador antes de subirla. Un icono de producto
 * se ve a 44 px, y mandar la foto original de 4 MB desde un móvil sería lento
 * para quien la sube y para todos los que luego cargan la tienda.
 *
 * Se sigue admitiendo pegar una URL: las rutas locales (`/coins/…`) no están en
 * Storage y tienen que poder escribirse.
 */
import { useRef, useState } from 'react';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { storage } from '@/lib/firebase';
import { Input } from '@/components/ui/Field';
import { cn, errorMessage } from '@/lib/utils';

/** Lado máximo del icono ya reescalado, en píxeles. */
const MAX_SIDE = 256;

/**
 * Reduce la imagen y la convierte a WebP.
 *
 * Devuelve el original si el navegador no puede procesarla (un SVG, por
 * ejemplo, no se dibuja bien en un canvas y no hace falta reescalarlo).
 */
async function shrink(file: File): Promise<Blob> {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.9)
    );

    // Si el reescalado no ahorró nada, se sube el original.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

interface ImageUploadProps {
  label: string;
  value: string;
  onChange: (url: string) => void;
  /** Carpeta dentro de `catalog/`: `productos`, `juegos`, `monedas`… */
  folder: string;
  hint?: string;
  disabled?: boolean;
}

export function ImageUpload({
  label,
  value,
  onChange,
  folder,
  hint,
  disabled,
}: ImageUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Ese archivo no es una imagen.');
      return;
    }

    setUploading(true);
    try {
      const blob = await shrink(file);
      const extension = blob.type === 'image/webp' ? 'webp' : file.name.split('.').pop() || 'png';
      // El nombre lleva la marca de tiempo para que reemplazar una imagen no
      // quede escondida detrás de la caché del navegador.
      const path = `catalog/${folder}/${Date.now()}.${extension}`;

      const destination = storageRef(storage, path);
      await uploadBytes(destination, blob, { contentType: blob.type, cacheControl: 'public, max-age=31536000' });
      onChange(await getDownloadURL(destination));

      toast.success('Imagen subida.');
    } catch (error) {
      toast.error(errorMessage(error, 'No se pudo subir la imagen.'));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <span className="label-base">{label}</span>

      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled || uploading}
          className={cn(
            'flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed transition',
            value
              ? 'border-base-500 bg-base-900'
              : 'border-base-500 bg-base-900 text-slate-500 hover:border-neon-red hover:text-neon-crimson',
            (disabled || uploading) && 'cursor-not-allowed opacity-60'
          )}
          aria-label={`Subir ${label}`}
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden />
          ) : value ? (
            <img src={value} alt="" className="h-full w-full object-contain p-1.5" />
          ) : (
            <ImagePlus className="h-6 w-6" aria-hidden />
          )}
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={disabled || uploading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-base-500 bg-base-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-base-600 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden />
              {uploading ? 'Subiendo…' : 'Subir imagen'}
            </button>

            {value && (
              <button
                type="button"
                onClick={() => onChange('')}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Quitar
              </button>
            )}
          </div>

          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="…o pega una URL"
            disabled={disabled || uploading}
            hint={hint}
            className="text-xs"
          />
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
