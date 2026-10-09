import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, Save, Upload, MessageSquare, ShoppingCart } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminChatbotConfig, useUpdateChatbotConfig } from '@/hooks/useAdmin';
import { Button } from '@/components/ui/Button';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { app } from '@/lib/firebase';
import { FullPageLoader } from '@/components/ui/Feedback';
import { ChatbotConfig, SupportBotConfig } from '@/features/chatbot/useChatbotConfig';

export function AdminChatbotPage() {
  const configQuery = useAdminChatbotConfig();
  const updateConfig = useUpdateChatbotConfig();
  const dualConfig = configQuery.data?.config;
  
  const [activeTab, setActiveTab] = useState<'refill' | 'support'>('refill');
  
  const [refillAvatarUrl, setRefillAvatarUrl] = useState('');
  const [supportAvatarUrl, setSupportAvatarUrl] = useState('');
  
  const [uploading, setUploading] = useState(false);
  const legacyMigrationAttempted = useRef(false);
  const avatarDraftsInitialized = useRef(false);

  useEffect(() => {
    // Refetches (including focus/reconnect) must not overwrite an image URL
    // uploaded or edited locally but not yet saved.
    if (!dualConfig || avatarDraftsInitialized.current) return;
    setRefillAvatarUrl(dualConfig.chatbot.avatarUrl || '');
    setSupportAvatarUrl(dualConfig.supportBot.avatarUrl || '');
    avatarDraftsInitialized.current = true;
  }, [dualConfig]);

  useEffect(() => {
    const settings = configQuery.data;
    if (!settings || legacyMigrationAttempted.current) return;
    legacyMigrationAttempted.current = true;

    let legacyValue: string | null = null;
    try {
      legacyValue = localStorage.getItem('refill_dualbot_config');
    } catch {
      return;
    }
    if (!legacyValue) return;

    if (settings.configured) {
      localStorage.removeItem('refill_dualbot_config');
      return;
    }

    try {
      const legacy = JSON.parse(legacyValue) as {
        chatbot?: Partial<ChatbotConfig>;
        supportBot?: Partial<SupportBotConfig>;
      };
      const profile = (value: Partial<ChatbotConfig> | undefined, fallback: ChatbotConfig): ChatbotConfig => ({
        enabled: typeof value?.enabled === 'boolean' ? value.enabled : fallback.enabled,
        name: typeof value?.name === 'string' ? value.name : fallback.name,
        avatarUrl: typeof value?.avatarUrl === 'string' ? value.avatarUrl : fallback.avatarUrl,
        welcomeMessage: typeof value?.welcomeMessage === 'string' ? value.welcomeMessage : fallback.welcomeMessage,
      });
      const migrated: { chatbot: ChatbotConfig; supportBot: SupportBotConfig } = {
        chatbot: profile(legacy.chatbot, dualConfig!.chatbot),
        supportBot: {
          ...profile(legacy.supportBot, dualConfig!.supportBot),
          instructions: typeof legacy.supportBot?.instructions === 'string' ? legacy.supportBot.instructions : '',
        },
      };

      updateConfig.mutate(migrated, {
        onSuccess: (result) => {
          setRefillAvatarUrl(result.config.chatbot.avatarUrl || '');
          setSupportAvatarUrl(result.config.supportBot.avatarUrl || '');
          localStorage.removeItem('refill_dualbot_config');
          toast.success('La configuración anterior de los asistentes se guardó en la tienda.');
        },
        onError: () => toast.error('No se pudo migrar la configuración anterior. Puedes guardarla manualmente.'),
      });
    } catch {
      localStorage.removeItem('refill_dualbot_config');
    }
  }, [configQuery.data, dualConfig, updateConfig]);

  if (configQuery.isLoading || !dualConfig) return <FullPageLoader />;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>, type: 'refill' | 'support') => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Selecciona un archivo de imagen.');
      e.target.value = '';
      return;
    }
    
    if (file.size > 2 * 1024 * 1024) {
      toast.error('La imagen no debe superar los 2MB');
      return;
    }

    setUploading(true);
    try {
      const storage = getStorage(app, 'gs://refill-e254f-catalogo');
      const fileRef = ref(storage, `catalog/chatbot_${type}_${Date.now()}`);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);
      
      if (type === 'refill') setRefillAvatarUrl(url);
      else setSupportAvatarUrl(url);
      
      toast.success('Imagen subida. Recuerda guardar la configuración.');
    } catch (err) {
      console.error(`[ChatbotAdmin] Error subiendo avatar para ${type}:`, err);
      toast.error('No se pudo subir la imagen. Verifica los permisos.');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    
    const refillConfig: ChatbotConfig = {
      enabled: data.get('refill_enabled') === 'on',
      name: (data.get('refill_name') as string).trim() || 'Asistente Refill',
      avatarUrl: refillAvatarUrl.trim(),
      welcomeMessage: (data.get('refill_welcomeMessage') as string).trim() || '¡Hola! 🤖 Soy el asistente de Refill Store.',
    };

    const supportConfig: SupportBotConfig = {
      enabled: data.get('support_enabled') === 'on',
      name: (data.get('support_name') as string).trim() || 'Soporte Refill',
      avatarUrl: supportAvatarUrl.trim(),
      welcomeMessage: (data.get('support_welcomeMessage') as string).trim() || '¡Hola! 💬 ¿En qué te puedo ayudar hoy?',
      instructions: (data.get('support_instructions') as string).trim(),
    };

    const payload = {
      chatbot: refillConfig,
      supportBot: supportConfig
    };

    updateConfig.mutate(payload, {
      onSuccess: (result) => {
        const savedRefillAvatar = result.config.chatbot.avatarUrl || '';
        const savedSupportAvatar = result.config.supportBot.avatarUrl || '';
        if (savedRefillAvatar !== refillConfig.avatarUrl || savedSupportAvatar !== supportConfig.avatarUrl) {
          toast.error('El servidor no confirmó las imágenes. No cierres la página y vuelve a guardar.');
          return;
        }
        setRefillAvatarUrl(savedRefillAvatar);
        setSupportAvatarUrl(savedSupportAvatar);
        toast.success('Configuración e imágenes de los asistentes guardadas.');
      },
      onError: (err) => {
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
          <h1 className="text-2xl font-bold">Asistentes Virtuales</h1>
          <p className="text-slate-400">Configura los chatbots de Recargas y Soporte.</p>
        </div>
      </header>
      
      <div className="mb-6 flex space-x-2 border-b border-base-600 pb-px">
        <button
          onClick={() => setActiveTab('refill')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'refill'
              ? 'border-neon-red text-neon-red'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ShoppingCart className="h-4 w-4" />
          Asistente de Recargas
        </button>
        <button
          onClick={() => setActiveTab('support')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'support'
              ? 'border-neon-red text-neon-red'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          Asistente de Soporte
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* TAB: REFILL */}
        <section className={`rounded-2xl border border-base-600 bg-base-800 p-6 ${activeTab === 'refill' ? 'block' : 'hidden'}`}>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Estado del asistente (Recargas)</h2>
              <p className="text-sm text-slate-400">Activa o desactiva el flujo de compras.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                name="refill_enabled"
                className="peer sr-only"
                defaultChecked={dualConfig.chatbot.enabled}
              />
              <div className="peer h-6 w-11 rounded-full bg-base-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-neon-red peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-neon-red/30" />
            </label>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Avatar</label>
              <div className="flex items-center gap-4">
                {refillAvatarUrl ? (
                  <img src={refillAvatarUrl} alt="Avatar" className="h-16 w-16 rounded-full border border-base-600 object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-700 text-white"><Bot /></div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <input type="url" value={refillAvatarUrl} onChange={(e) => setRefillAvatarUrl(e.target.value)} placeholder="URL de la imagen" className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
                  <div className="flex flex-wrap gap-2">
                    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-base-600 bg-base-900 px-4 py-2 text-sm font-medium transition hover:bg-base-700 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
                      <Upload className="h-4 w-4" /> Subir imagen
                      <input type="file" accept="image/*" className="sr-only" onChange={(e) => handleFile(e, 'refill')} disabled={uploading} />
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Nombre</label>
              <input type="text" name="refill_name" defaultValue={dualConfig.chatbot.name} className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Mensaje de bienvenida</label>
              <textarea name="refill_welcomeMessage" defaultValue={dualConfig.chatbot.welcomeMessage} rows={3} className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
            </div>
          </div>
        </section>

        {/* TAB: SUPPORT */}
        <section className={`rounded-2xl border border-base-600 bg-base-800 p-6 ${activeTab === 'support' ? 'block' : 'hidden'}`}>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Estado del asistente (Soporte)</h2>
              <p className="text-sm text-slate-400">Activa o desactiva el bot de preguntas.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                name="support_enabled"
                className="peer sr-only"
                defaultChecked={dualConfig.supportBot.enabled}
              />
              <div className="peer h-6 w-11 rounded-full bg-base-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-neon-red peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-neon-red/30" />
            </label>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Avatar</label>
              <div className="flex items-center gap-4">
                {supportAvatarUrl ? (
                  <img src={supportAvatarUrl} alt="Avatar" className="h-16 w-16 rounded-full border border-base-600 object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-700 text-white"><Bot /></div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <input type="url" value={supportAvatarUrl} onChange={(e) => setSupportAvatarUrl(e.target.value)} placeholder="URL de la imagen" className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
                  <div className="flex flex-wrap gap-2">
                    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-base-600 bg-base-900 px-4 py-2 text-sm font-medium transition hover:bg-base-700 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
                      <Upload className="h-4 w-4" /> Subir imagen
                      <input type="file" accept="image/*" className="sr-only" onChange={(e) => handleFile(e, 'support')} disabled={uploading} />
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Nombre</label>
              <input type="text" name="support_name" defaultValue={dualConfig.supportBot.name} className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Mensaje de bienvenida</label>
              <textarea name="support_welcomeMessage" defaultValue={dualConfig.supportBot.welcomeMessage} rows={2} className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
            </div>
            
            <div>
              <label className="mb-1 block text-sm font-medium">Instrucciones / Información de la tienda (FAQ)</label>
              <textarea name="support_instructions" defaultValue={dualConfig.supportBot.instructions} rows={5} placeholder="Ej: Aceptamos Pago Móvil, Binance. Trabajamos 24/7..." className="w-full rounded-xl border border-base-600 bg-base-900 px-4 py-2.5 text-sm outline-none focus:border-neon-red focus:ring-1 focus:ring-neon-red" />
              <p className="mt-1 text-xs text-slate-400">Esta información la usará el asistente para responder a los clientes.</p>
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
