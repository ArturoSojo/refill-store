import { FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Bot, Save } from 'lucide-react';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useAdminConfig, useUpdateConfig } from '@/hooks/useAdmin';
import { FullPageLoader } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { getLocalChatbotConfig } from '@/features/chatbot/useChatbotConfig';

export function AdminChatbotPage() {
  useDocumentTitle('Panel · Asistente Virtual');

  const configQuery = useAdminConfig();
  const updateConfig = useUpdateConfig();
  const config = configQuery.data?.config;

  if (configQuery.isLoading || !config) return <FullPageLoader />;

  const localInitial = getLocalChatbotConfig();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const enabled = data.get('enabled') === 'on';
    const name = data.get('name') as string;
    const welcomeMessage = data.get('welcomeMessage') as string;

    const botConfig = {
      enabled,
      name: name.trim() || 'Asistente Refill',
      welcomeMessage: welcomeMessage.trim() || '¡Hola! 👋 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.',
    };

    localStorage.setItem('refill_chatbot_config', JSON.stringify(botConfig));

    const patch = { chatbot: botConfig };
    console.log('[ChatbotAdmin] Payload enviado:', patch);

    updateConfig.mutate(patch, {
      onSuccess: () => {
        toast.success('Configuración guardada correctamente.');
      },
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
                defaultValue={localInitial?.welcomeMessage ?? config.chatbot?.welcomeMessage ?? '¡Hola! 👋 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.'}
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
            disabled={updateConfig.isPending}
          >
            <Save className="h-4 w-4" />
            {updateConfig.isPending ? 'Guardando...' : 'Guardar configuración'}
          </Button>
        </div>
      </form>
    </div>
  );
}
