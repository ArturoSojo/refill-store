import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Bot, Save, Upload, X } from 'lucide-react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { app } from '@/lib/firebase';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useAdminConfig, useUpdateConfig } from '@/hooks/useAdmin';
import { FullPageLoader } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { getLocalChatbotConfig } from '@/features/chatbot/useChatbotConfig';

// Bucket real del proyecto (ya tiene CORS activo).
const storage = getStorage(app, 'gs://refill-e254f-catalogo');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function AdminChatbotPage() {
  useDocumentTitle('Panel · Asistente Virtual');

  const configQuery = useAdminConfig();
  const updateConfig = useUpdateConfig();
  const config = configQuery.data?.config;

  const [avatarUrl, setAvatarUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const local = getLocalChatbotConfig();
    setAvatarUrl(local?.avatarUrl ?? config?.chatbot?.avatarUrl ?? '');
  }, [config]);

  if (configQuery.isLoading || !config) return <FullPageLoader />;

  const localInitial = getLocalChatbotConfig();

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Selecciona un archivo de imagen.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('La imagen no debe superar 2 MB.');
      return;
    }

    setUploading(true);
    try {
      // `catalog/` es la ruta que las reglas de Storage autorizan para admins.
      const fileRef = ref(storage, `catalog/chatbot_${Date.now()}`);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      setAvatarUrl(url);
      toast.success('Imagen subida. Recuerda guardar la configuración.');
    } catch (err) {
      console.error('[ChatbotAdmin] Error subiendo avatar:', err);
      const code = (err as { code?: string } | null)?.code ?? '';
      if (code === 'storage/unauthorized' || code === 'storage/unauthenticated') {
        toast.error(
          'Sin permisos para subir el archivo. Usa el campo de URL directa para pegar un link de la imagen.',
          { duration: 7000 }
        );
      } else {
        toast.error(
          'No se pudo subir la imagen. Puedes pegar un link en el campo de URL directa.',
          { duration: 6000 }
        );
      }
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const enabled = data.get('enabled') === 'on';
    const name = data.get('name') as string;
    const welcomeMessage = data.get('welcomeMessage') as string;

    const botConfig = {
      enabled,
      name: name.trim() || 'Asistente Refill',
      avatarUrl: avatarUrl.trim(),
      welcomeMessage:
        welcomeMessage.trim() ||
        '¡Hola! 👋 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.',
    };

    localStorage.setItem('refill_chatbot_config', JSON.stringify(botConfig));

    const patch = { chatbot: botConfig };
    console.log('[ChatbotAdmin] Payload enviado:', patch);

    updateConfig.mutate(patch, {
      onSuccess: () => toast.success('Configuración guardada correctamente.'),
      onError: (err) => {
        console.error('[ChatbotAdmin] Error:', err);
        toast.error(err instanceof Error ? err.message : 'Error al guardar.');
      },
    });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-8 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-500">
          <Bot className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Asistente Virtual</h1>
          <p className="text-slate-400">Configura el comportamiento del chatbot de la tienda.</p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="rounded-2xl border border-base-600 bg-base-800 p-6">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Estado del asistente</h2>
              <p className="text-sm text-slate-400">Activa o desactiva el widget en la página principal.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                name="enabled"
                className="peer sr-only"
                defaultChecked={localInitial?.enabled ?? config.chatbot?.enabled ?? true}
              />
              <div className="peer h-6 w-11 rounded-full bg-base-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-neon-red peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-neon-red/30" />
            </label>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Avatar del asistente</label>
              <div className="flex items-center gap-4">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Avatar del asistente"
                    className="h-16 w-16 rounded-full border border-base-600 object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-700 text-xl font-bold text-white">
                    <Bot className="h-7 w-7" aria-hidden />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    type="url"
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://... o pega un link"
                    className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-neon-red focus:ring-1 focus:ring-neon-red"
                  />
                  <div className="flex flex-wrap gap-2">
                    <label
                      className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-base-600 bg-base-900 px-4 py-2 text-sm font-medium transition hover:bg-base-700 ${
                        uploading ? 'pointer-events-none opacity-50' : ''
                      }`}
                    >
                      <Upload className="h-4 w-4" aria-hidden />
                      {uploading ? 'Subiendo...' : 'Subir imagen'}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={handleFile}
                        disabled={uploading}
                      />
                    </label>
                    {avatarUrl && (
                      <button
                        type="button"
                        onClick={() => setAvatarUrl('')}
                        className="inline-flex items-center gap-1 rounded-xl border border-base-600 px-3 py-2 text-sm text-slate-300 hover:bg-base-700"
                      >
                        <X className="h-4 w-4" aria-hidden /> Quitar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Nombre del Asistente</label>
              <input
                type="text"
                name="name"
                defaultValue={localInitial?.name ?? config.chatbot?.name ?? 'Asistente Refill'}
                className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-neon-red focus:ring-1 focus:ring-neon-red"
                placeholder="Ej. Asistente Refill"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Mensaje de bienvenida (Opcional)</label>
              <textarea
                name="welcomeMessage"
                defaultValue={
                  localInitial?.welcomeMessage ??
                  config.chatbot?.welcomeMessage ??
                  '¡Hola! 👋 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.'
                }
                rows={3}
                className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-neon-red focus:ring-1 focus:ring-neon-red"
              />
            </div>
          </div>
        </section>

        <div className="flex justify-end">
          <Button
            type="submit"
            className="flex items-center gap-2"
            disabled={updateConfig.isPending || uploading}
          >
            <Save className="h-4 w-4" />
            {updateConfig.isPending ? 'Guardando...' : 'Guardar configuración'}
          </Button>
        </div>
      </form>
    </div>
  );
}
