import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Landmark,
  Megaphone,
  Percent,
  RefreshCw,
  Save,
  Send,
  Settings2,
  TrendingUp,
  Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminConfig,
  useUpdateConfig,
  useSetRate,
  useSetRateAuto,
  useRefreshRate,
  useRateHistory,
  useProvidersStatus,
  useTestAlert,
} from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch, Textarea } from '@/components/ui/Field';
import { Badge, FullPageLoader } from '@/components/ui/Feedback';
import { formatBs, formatDateTime, formatUsd } from '@/lib/format';
import { errorMessage } from '@/lib/utils';

export function AdminSettings() {
  useDocumentTitle('Panel · Configuración');
  const { isAdmin } = useAuth();

  const configQuery = useAdminConfig();
  const updateConfig = useUpdateConfig();
  const setRate = useSetRate();
  const setRateAuto = useSetRateAuto();
  const refreshRate = useRefreshRate();
  const rateHistory = useRateHistory();
  const providers = useProvidersStatus();
  const testAlert = useTestAlert();

  const [rateValue, setRateValue] = useState('');
  const [form, setForm] = useState<Record<string, unknown>>({});

  const config = configQuery.data?.config;

  useEffect(() => {
    if (config) setRateValue(String(config.rate.value));
  }, [config]);

  if (configQuery.isLoading || !config) return <FullPageLoader />;

  /** Mezcla superficial: sólo se manda al backend lo que cambió. */
  const patch = (section: string, values: Record<string, unknown>) => {
    setForm((current) => ({
      ...current,
      [section]: { ...((current[section] as object) ?? {}), ...values },
    }));
  };

  const sectionValue = <T,>(section: string, key: string, fallback: T): T => {
    const local = (form[section] as Record<string, unknown> | undefined)?.[key];
    if (local !== undefined) return local as T;
    return fallback;
  };

  const save = () => {
    if (Object.keys(form).length === 0) {
      toast('No hay cambios que guardar.');
      return;
    }

    updateConfig.mutate(form, {
      onSuccess: () => {
        toast.success('Configuración guardada.');
        setForm({});
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  const dirty = Object.keys(form).length > 0;

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Configuración</h1>
          <p className="text-sm text-slate-400">
            Última edición: {formatDateTime(config.updatedAt ?? null)}
          </p>
        </div>
      </div>

      {/* --- Estado de las integraciones --- */}
      <Card>
        <CardHeader
          title="Integraciones"
          description="Las credenciales viven en Secret Manager, no aquí"
          icon={<Zap className="h-4 w-4" aria-hidden />}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl bg-base-900/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-white">Pabilo</p>
              <p className="text-xs text-slate-400">Verificación de Pago Móvil</p>
            </div>
            <Badge variant={providers.data?.pabilo.configured ? 'success' : 'danger'}>
              {providers.data?.pabilo.configured ? 'Configurado' : 'Falta clave'}
            </Badge>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-base-900/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-white">Inefable</p>
              <p className="text-xs text-slate-400">Despacho automático</p>
              {/* El saldo es lo primero que hay que mirar cuando las recargas
                  empiezan a fallar: si se agota, fallan todas. */}
              {providers.data?.inefable.balanceUsd !== null &&
                providers.data?.inefable.balanceUsd !== undefined && (
                  <p className="mt-1 text-xs">
                    <span className="text-slate-400">Saldo: </span>
                    <span
                      className={
                        providers.data.inefable.balanceUsd < 5
                          ? 'font-bold text-red-400'
                          : providers.data.inefable.balanceUsd < 20
                            ? 'font-bold text-amber-400'
                            : 'font-bold text-emerald-400'
                      }
                    >
                      {formatUsd(providers.data.inefable.balanceUsd)}
                    </span>
                    {providers.data.inefable.accountName && (
                      <span className="text-slate-500"> · {providers.data.inefable.accountName}</span>
                    )}
                  </p>
                )}
            </div>
            <Badge
              variant={
                !providers.data?.inefable.configured
                  ? 'danger'
                  : providers.data.inefable.reachable
                    ? 'success'
                    : 'warning'
              }
            >
              {!providers.data?.inefable.configured
                ? 'Falta clave'
                : providers.data.inefable.reachable
                  ? 'Conectado'
                  : 'Sin respuesta'}
            </Badge>
          </div>
        </div>

        {providers.data?.inefable.balanceUsd !== null &&
          providers.data?.inefable.balanceUsd !== undefined &&
          providers.data.inefable.balanceUsd < 20 && (
            <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Saldo bajo en el proveedor. Cuando llegue a cero, todas las recargas automáticas
              fallarán aunque el pago del cliente se verifique correctamente.
            </p>
          )}
        <p className="mt-3 rounded-xl bg-base-900 px-3 py-2 text-xs text-slate-400">
          Para cambiarlas:{' '}
          <code className="text-neon-crimson">firebase functions:secrets:set PABILO_API_KEY</code> y
          vuelve a desplegar las funciones.
        </p>
      </Card>

      {/* --- Tasa --- */}
      <Card>
        <CardHeader
          title="Tasa de cambio"
          description="Determina el monto en bolívares de cada orden"
          icon={<TrendingUp className="h-4 w-4" aria-hidden />}
        />

        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Bolívares por dólar"
            type="number"
            step="0.01"
            value={rateValue}
            onChange={(event) => setRateValue(event.target.value)}
            containerClassName="max-w-[200px]"
            disabled={!isAdmin}
          />
          <Button
            loading={setRate.isPending}
            disabled={!isAdmin || Number(rateValue) === config.rate.value || !Number(rateValue)}
            onClick={() =>
              setRate.mutate(Number(rateValue), {
                onSuccess: (result) =>
                  toast.success(`Tasa: ${result.previous} → ${result.current}`),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            Fijar tasa
          </Button>
          <Button
            variant="secondary"
            loading={refreshRate.isPending}
            disabled={!isAdmin}
            leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
            onClick={() =>
              refreshRate.mutate(undefined, {
                onSuccess: (result) => toast.success(result.reason),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            Traer del BCV
          </Button>
        </div>

        <p className="mt-2 text-xs text-slate-400">
          Actual: <strong className="text-white">{formatBs(config.rate.value)}</strong> ·{' '}
          {config.rate.source === 'auto' ? 'automática' : 'manual'} · actualizada{' '}
          {formatDateTime(config.rate.updatedAt)}
        </p>

        <div className="mt-4 space-y-3 border-t border-base-600 pt-4">
          <Switch
            checked={config.rate.autoRefresh}
            onChange={(autoRefresh) =>
              setRateAuto.mutate(
                { autoRefresh },
                {
                  onSuccess: () =>
                    toast.success(
                      autoRefresh
                        ? 'Auto-refresco activado (cada hora).'
                        : 'Auto-refresco desactivado.'
                    ),
                }
              )
            }
            disabled={!isAdmin}
            label="Actualizar la tasa automáticamente cada hora"
            description="Consulta una fuente pública del BCV y le suma el margen configurado."
          />

          {config.rate.autoRefresh && (
            <Input
              label="Margen sobre la tasa BCV (%)"
              type="number"
              step="0.1"
              defaultValue={config.rate.markupPercent}
              onBlur={(event) =>
                setRateAuto.mutate({
                  autoRefresh: true,
                  markupPercent: Number(event.target.value),
                })
              }
              containerClassName="max-w-[200px]"
              disabled={!isAdmin}
            />
          )}
        </div>

        {(rateHistory.data?.history.length ?? 0) > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-semibold text-neon-crimson">
              Ver historial de tasas
            </summary>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl bg-base-900 p-3 text-xs">
              {rateHistory.data!.history.map((entry) => (
                <li key={entry.id} className="flex justify-between gap-3">
                  <span className="text-slate-400">
                    {formatDateTime(entry.createdAt as never)}
                  </span>
                  <span className="tabular text-slate-300">
                    {entry.previous} → <span className="text-white">{entry.value}</span> (
                    {entry.source})
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {/* --- Datos bancarios --- */}
      <Card>
        <CardHeader
          title="Datos del Pago Móvil"
          description="Se muestran al cliente y se congelan en cada orden"
          icon={<Landmark className="h-4 w-4" aria-hidden />}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Código del banco"
            defaultValue={config.bank.code}
            onChange={(event) => patch('bank', { code: event.target.value })}
            disabled={!isAdmin}
          />
          <Input
            label="Nombre del banco"
            defaultValue={config.bank.name}
            onChange={(event) => patch('bank', { name: event.target.value })}
            disabled={!isAdmin}
          />
          <Input
            label="Cédula / RIF"
            defaultValue={config.bank.idNumber}
            onChange={(event) => patch('bank', { idNumber: event.target.value })}
            disabled={!isAdmin}
          />
          <Input
            label="Teléfono"
            defaultValue={config.bank.phone}
            onChange={(event) => patch('bank', { phone: event.target.value })}
            disabled={!isAdmin}
          />
          <Input
            label="Titular"
            defaultValue={config.bank.holder}
            onChange={(event) => patch('bank', { holder: event.target.value })}
            disabled={!isAdmin}
            containerClassName="sm:col-span-2"
          />
        </div>
      </Card>

      {/* --- WhatsApp --- */}
      <Card>
        <CardHeader title="WhatsApp" description="Sin signos: código de país + número" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Número para productos manuales"
            defaultValue={config.whatsapp.adminNumber}
            onChange={(event) => patch('whatsapp', { adminNumber: event.target.value })}
            hint="Recibe las órdenes de Categoría B"
            disabled={!isAdmin}
          />
          <Input
            label="Número de soporte"
            defaultValue={config.whatsapp.supportNumber}
            onChange={(event) => patch('whatsapp', { supportNumber: event.target.value })}
            hint="Enlace de ayuda en la tienda"
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Checkout --- */}
      <Card>
        <CardHeader
          title="Checkout"
          description="Reglas del proceso de pago"
          icon={<Settings2 className="h-4 w-4" aria-hidden />}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Minutos para pagar"
            type="number"
            defaultValue={config.checkout.orderExpiryMinutes}
            onChange={(event) =>
              patch('checkout', { orderExpiryMinutes: Number(event.target.value) })
            }
            hint="Pasado ese tiempo la orden expira"
            disabled={!isAdmin}
          />
          <Input
            label="Tolerancia del monto (%)"
            type="number"
            step="0.1"
            defaultValue={config.checkout.amountTolerancePercent}
            onChange={(event) =>
              patch('checkout', { amountTolerancePercent: Number(event.target.value) })
            }
            hint="Diferencia admitida entre lo pagado y lo esperado"
            disabled={!isAdmin}
          />
          <Input
            label="Intentos de verificación"
            type="number"
            defaultValue={config.checkout.maxVerifyAttempts}
            onChange={(event) =>
              patch('checkout', { maxVerifyAttempts: Number(event.target.value) })
            }
            disabled={!isAdmin}
          />
          <Input
            label="Órdenes sin pagar por usuario"
            type="number"
            defaultValue={config.checkout.maxOpenOrdersPerUser}
            onChange={(event) =>
              patch('checkout', { maxOpenOrdersPerUser: Number(event.target.value) })
            }
            disabled={!isAdmin}
          />
          <Input
            label="Longitud mínima de referencia"
            type="number"
            defaultValue={config.checkout.referenceMinLength}
            onChange={(event) =>
              patch('checkout', { referenceMinLength: Number(event.target.value) })
            }
            disabled={!isAdmin}
          />
          <Input
            label="Longitud máxima de referencia"
            type="number"
            defaultValue={config.checkout.referenceMaxLength}
            onChange={(event) =>
              patch('checkout', { referenceMaxLength: Number(event.target.value) })
            }
            disabled={!isAdmin}
          />
        </div>

        <div className="mt-4 border-t border-base-600 pt-4">
          <Switch
            checked={sectionValue(
              'checkout',
              'walletEnabled',
              config.checkout.walletEnabled !== false
            )}
            onChange={(walletEnabled) => patch('checkout', { walletEnabled })}
            label="Permitir pagar con saldo a favor"
            description="El cliente puede aplicar su saldo (reembolsos, referidos) al total y transferir sólo la diferencia. Si lo apagas, el saldo se sigue acumulando pero no se puede gastar."
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Avisos al equipo --- */}
      <Card>
        <CardHeader
          title="Avisos"
          description="Cómo te enteras cuando algo necesita a una persona"
          icon={<BellRing className="h-4 w-4" aria-hidden />}
          action={
            isAdmin ? (
              <Button
                size="sm"
                variant="secondary"
                loading={testAlert.isPending}
                leftIcon={<Send className="h-4 w-4" aria-hidden />}
                onClick={() =>
                  testAlert.mutate(undefined, {
                    onSuccess: (data) =>
                      toast.success(
                        data.delivery?.telegram === 'sent' || data.delivery?.webhook === 'sent'
                          ? 'Aviso de prueba enviado.'
                          : 'Guardado en el panel, pero no salió por Telegram ni webhook. Revisa los datos y guarda primero los cambios.'
                      ),
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                Probar
              </Button>
            ) : undefined
          }
        />

        <Switch
          checked={sectionValue('alerts', 'enabled', config.alerts?.enabled !== false)}
          onChange={(enabled) => patch('alerts', { enabled })}
          label="Enviar avisos fuera del panel"
          description="Si lo apagas, los avisos se siguen guardando en la sección Avisos pero no se envían por Telegram ni webhook."
          disabled={!isAdmin}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Input
            label="Chat de Telegram"
            defaultValue={config.alerts?.telegramChatId ?? ''}
            onChange={(event) => patch('alerts', { telegramChatId: event.target.value.trim() })}
            placeholder="123456789"
            hint="Escríbele a tu bot y saca el chat_id de api.telegram.org/bot<token>/getUpdates. El token va en el secreto TELEGRAM_BOT_TOKEN."
            disabled={!isAdmin}
          />
          <Input
            label="Webhook (correo, WhatsApp…)"
            defaultValue={config.alerts?.webhookUrl ?? ''}
            onChange={(event) => patch('alerts', { webhookUrl: event.target.value.trim() })}
            placeholder="https://hook.eu2.make.com/…"
            hint="Recibe el aviso en JSON. Úsalo para enrutarlo a correo o WhatsApp desde Make, Zapier o n8n."
            disabled={!isAdmin}
          />
          <Input
            label="Avisar si el saldo del proveedor baja de (USD)"
            type="number"
            step="1"
            defaultValue={config.alerts?.lowBalanceThresholdUsd ?? 10}
            onChange={(event) =>
              patch('alerts', { lowBalanceThresholdUsd: Number(event.target.value) })
            }
            hint="0 desactiva este aviso."
            disabled={!isAdmin}
          />
        </div>

        <div className="mt-4 space-y-3 border-t border-base-600 pt-4">
          <Switch
            checked={sectionValue(
              'alerts',
              'notifyOnDispatchFailed',
              config.alerts?.notifyOnDispatchFailed !== false
            )}
            onChange={(notifyOnDispatchFailed) => patch('alerts', { notifyOnDispatchFailed })}
            label="Recarga fallida"
            description="El cliente ya pagó y la entrega no salió. Es el aviso más urgente."
            disabled={!isAdmin}
          />
          <Switch
            checked={sectionValue(
              'alerts',
              'notifyOnManualOrder',
              config.alerts?.notifyOnManualOrder !== false
            )}
            onChange={(notifyOnManualOrder) => patch('alerts', { notifyOnManualOrder })}
            label="Producto manual pagado"
            description="Alguien pagó un producto que se entrega por WhatsApp."
            disabled={!isAdmin}
          />
          <Switch
            checked={sectionValue(
              'alerts',
              'notifyOnNewTicket',
              config.alerts?.notifyOnNewTicket !== false
            )}
            onChange={(notifyOnNewTicket) => patch('alerts', { notifyOnNewTicket })}
            label="Consultas de soporte"
            description="Tickets nuevos y respuestas de clientes."
            disabled={!isAdmin}
          />
          <Switch
            checked={sectionValue(
              'alerts',
              'notifyOnPaymentRejected',
              config.alerts?.notifyOnPaymentRejected === true
            )}
            onChange={(notifyOnPaymentRejected) => patch('alerts', { notifyOnPaymentRejected })}
            label="Pagos rechazados"
            description="Suele ser el cliente escribiendo mal la referencia: actívalo sólo si quieres verlos todos."
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Precios --- */}
      <Card>
        <CardHeader
          title="Precios"
          description="Margen por defecto y redondeo"
          icon={<Percent className="h-4 w-4" aria-hidden />}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Margen por defecto (%)"
            type="number"
            step="0.5"
            defaultValue={config.pricing.defaultMarginPercent}
            onChange={(event) =>
              patch('pricing', { defaultMarginPercent: Number(event.target.value) })
            }
            disabled={!isAdmin}
          />
          <Input
            label="Redondeo en USD"
            type="number"
            step="0.01"
            defaultValue={config.pricing.roundToUsd}
            onChange={(event) => patch('pricing', { roundToUsd: Number(event.target.value) })}
            hint="0.05 = múltiplos de 5 centavos"
            disabled={!isAdmin}
          />
          <Input
            label="Redondeo en Bs"
            type="number"
            step="0.01"
            defaultValue={config.pricing.roundToBs}
            onChange={(event) => patch('pricing', { roundToBs: Number(event.target.value) })}
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Funcionalidades --- */}
      <Card>
        <CardHeader
          title="Funcionalidades"
          description="Interruptores para operar la tienda"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
        />
        <div className="space-y-4">
          <Switch
            checked={sectionValue('features', 'maintenanceMode', config.features.maintenanceMode)}
            onChange={(maintenanceMode) => patch('features', { maintenanceMode })}
            disabled={!isAdmin}
            label="Modo mantenimiento"
            description="Bloquea la creación de órdenes para los clientes. El staff sigue pudiendo comprar."
          />
          <Switch
            checked={sectionValue(
              'features',
              'autoDispatchEnabled',
              config.features.autoDispatchEnabled
            )}
            onChange={(autoDispatchEnabled) => patch('features', { autoDispatchEnabled })}
            disabled={!isAdmin}
            label="Despacho automático"
            description="Si lo apagas, los pagos se verifican pero las recargas quedan pendientes de acción manual."
          />
          <Switch
            checked={sectionValue(
              'features',
              'manualProductsEnabled',
              config.features.manualProductsEnabled
            )}
            onChange={(manualProductsEnabled) => patch('features', { manualProductsEnabled })}
            disabled={!isAdmin}
            label="Productos manuales"
            description="Permite comprar los productos que se entregan por WhatsApp."
          />
          <Switch
            checked={sectionValue('features', 'couponsEnabled', config.features.couponsEnabled)}
            onChange={(couponsEnabled) => patch('features', { couponsEnabled })}
            disabled={!isAdmin}
            label="Cupones"
          />
          <Switch
            checked={sectionValue('features', 'referralsEnabled', config.features.referralsEnabled)}
            onChange={(referralsEnabled) => patch('features', { referralsEnabled })}
            disabled={!isAdmin}
            label="Programa de referidos"
          />

          <Textarea
            label="Mensaje de mantenimiento"
            defaultValue={config.features.maintenanceMessage}
            onChange={(event) => patch('features', { maintenanceMessage: event.target.value })}
            rows={2}
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Anuncio --- */}
      <Card>
        <CardHeader
          title="Aviso en la tienda"
          description="Barra superior visible para todos"
          icon={<Megaphone className="h-4 w-4" aria-hidden />}
        />
        <div className="space-y-4">
          <Switch
            checked={sectionValue('announcement', 'enabled', config.announcement.enabled)}
            onChange={(enabled) => patch('announcement', { enabled })}
            disabled={!isAdmin}
            label="Mostrar aviso"
          />
          <Input
            label="Texto"
            defaultValue={config.announcement.text}
            onChange={(event) => patch('announcement', { text: event.target.value })}
            placeholder="Ej: Promoción de fin de semana en Free Fire"
            disabled={!isAdmin}
          />
          <Select
            label="Estilo"
            defaultValue={config.announcement.type}
            onChange={(event) => patch('announcement', { type: event.target.value })}
            options={[
              { value: 'info', label: 'Informativo (azul)' },
              { value: 'success', label: 'Positivo (verde)' },
              { value: 'warning', label: 'Advertencia (ámbar)' },
            ]}
            containerClassName="max-w-xs"
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {/* --- Identidad --- */}
      <Card>
        <CardHeader title="Identidad y contacto" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nombre de la tienda"
            defaultValue={config.storeName}
            onChange={(event) => setForm((current) => ({ ...current, storeName: event.target.value }))}
            disabled={!isAdmin}
          />
          <Input
            label="Eslogan"
            defaultValue={config.tagline}
            onChange={(event) => setForm((current) => ({ ...current, tagline: event.target.value }))}
            disabled={!isAdmin}
          />
          <Input
            label="Correo de contacto"
            defaultValue={config.contact.email}
            onChange={(event) => patch('contact', { email: event.target.value })}
            disabled={!isAdmin}
          />
          <Input
            label="Instagram"
            defaultValue={config.contact.instagram}
            onChange={(event) => patch('contact', { instagram: event.target.value })}
            placeholder="@refillstore"
            disabled={!isAdmin}
          />
        </div>
      </Card>

      {isAdmin && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-base-600 bg-base-900/95 p-3 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              {dirty ? 'Tienes cambios sin guardar' : 'Todo guardado'}
            </p>
            <Button
              disabled={!dirty}
              loading={updateConfig.isPending}
              leftIcon={<Save className="h-4 w-4" aria-hidden />}
              onClick={save}
            >
              Guardar configuración
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
