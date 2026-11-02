/**
 * Central One en la configuración: saldo, sincronización del catálogo y webhook.
 *
 * Reemplaza el bloque de FazerCards. La diferencia de fondo es que la
 * sincronización ya no la conduce el navegador por lotes: el botón sólo la
 * encola (un trigger la corre en segundo plano, igual que la programada cada
 * hora) y aquí se sigue su avance en el historial. Cerrar la pestaña a mitad
 * ya no deja el catálogo a medias.
 */
import {
  CheckCircle2,
  Copy,
  RefreshCw,
  Send,
  Server,
  Wallet,
  Webhook,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  CENTRAL_ONE_WEBHOOK_URL,
  useCentralOneAccount,
  useCentralOneSyncHistory,
  useSyncCentralOneCatalog,
  useTestCentralOneWebhook,
  type CentralOneSyncRun,
} from '@/hooks/useAdmin';
import { useCopy } from '@/hooks/useMisc';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, Skeleton } from '@/components/ui/Feedback';
import { ApiError } from '@/lib/api';
import { formatDateTime, formatRelative, formatUsd } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import type { CentralOneStatus, ProviderSyncStatus, ProviderSyncTrigger } from '@/types/models';

const SYNC_STATUS: Record<ProviderSyncStatus, { label: string; variant: 'default' | 'info' | 'success' | 'danger' }> = {
  queued: { label: 'En cola', variant: 'default' },
  running: { label: 'Corriendo', variant: 'info' },
  done: { label: 'Terminada', variant: 'success' },
  error: { label: 'Con error', variant: 'danger' },
};

const SYNC_TRIGGER: Record<ProviderSyncTrigger, string> = {
  schedule: 'Automática',
  admin: 'Desde el panel',
  manual: 'Manual',
};

/** Motivos de descarte que reporta la sync, en palabras del panel. */
const SKIP_LABELS: Record<string, string> = {
  invalid: 'ítems ilegibles',
  no_product_id: 'sin product_id',
  inactive: 'inactivos en Central One',
  unknown_category: 'categoría no vendible',
  password_field: 'piden contraseña',
  no_target: 'recarga sin datos del jugador',
  currency: 'moneda distinta de USD',
  duplicate: 'duplicados',
  region: 'región fuera de Latinoamérica',
  invalid_price: 'sin precio válido',
  manual_game: 'juegos manuales (no se tocan)',
};

/** Freno de seguridad que detuvo la sync antes de escribir. */
const ABORT_LABELS: Record<string, string> = {
  empty_catalog: 'Central One devolvió el catálogo vacío',
  catalog_suspicious: 'El catálogo llegó sospechosamente corto: no se tocó nada',
  catalog_error: 'No se pudo leer el catálogo',
  missing_config: 'Falta la API key de Central One',
  exception: 'La sincronización falló por un error inesperado',
};

function balanceClass(value: number): string {
  if (value < 5) return 'font-bold text-red-400';
  if (value < 20) return 'font-bold text-amber-400';
  return 'font-bold text-emerald-400';
}

/** Una línea legible con lo que hizo una sincronización. */
function summaryLine(run: CentralOneSyncRun): string {
  const summary = run.summary;
  if (!summary) return run.error ?? '';
  if (summary.aborted) return ABORT_LABELS[summary.aborted] ?? summary.aborted;
  const parts = [
    `${summary.itemsMapped}/${summary.itemsReceived} ofertas`,
    summary.gamesCreated ? `+${summary.gamesCreated} juegos` : null,
    summary.productsCreated ? `+${summary.productsCreated} productos` : null,
    summary.productsUpdated ? `${summary.productsUpdated} actualizados` : null,
    summary.productsRemoved || summary.gamesRemoved
      ? `${summary.productsRemoved} productos y ${summary.gamesRemoved} juegos retirados`
      : null,
    summary.completed ? null : 'incompleta',
  ];
  return parts.filter(Boolean).join(' · ');
}

function SyncRunRow({ run }: { run: CentralOneSyncRun }) {
  const status = SYNC_STATUS[run.status] ?? { label: run.status, variant: 'default' as const };
  const summary = run.summary;
  const skipped = Object.entries(summary?.skipped ?? {}).filter(([, count]) => count > 0);
  const hasDetail =
    Boolean(run.error) ||
    skipped.length > 0 ||
    (summary?.errors.length ?? 0) > 0 ||
    (summary?.extrasCreated.length ?? 0) > 0 ||
    (summary?.extrasAtLoss?.length ?? 0) > 0 ||
    Boolean(summary?.fazerRetired);

  return (
    <li className="rounded-xl bg-base-900/60 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-slate-300">
          {formatDateTime(run.createdAt)} · <span className="text-slate-500">{SYNC_TRIGGER[run.trigger] ?? run.trigger}</span>
        </span>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      {summaryLine(run) && <p className="mt-1 text-slate-400">{summaryLine(run)}</p>}

      {hasDetail && (
        <details className="mt-1">
          <summary className="cursor-pointer font-semibold text-neon-crimson">Detalle</summary>
          <div className="mt-1 space-y-1 text-slate-400">
            {run.error && <p className="text-red-300">{run.error}</p>}
            {summary?.fazerRetired && (
              <p>
                FazerCards retirado: {summary.fazerRetired.games} juegos y {summary.fazerRetired.products} productos
                ocultos (no se borraron).
              </p>
            )}
            {summary && summary.extrasCreated.length > 0 && (
              <p>
                Extras de Free Fire creados ({summary.extrasCreated.length}):{' '}
                <span className="break-all font-mono text-[11px] text-slate-300">
                  {summary.extrasCreated.join(', ')}
                </span>
              </p>
            )}
            {summary?.extrasAtLoss && summary.extrasAtLoss.length > 0 && (
              <p className="text-amber-300">
                Extras de Free Fire a pérdida (costo ≥ precio; la sync no los reprecia):{' '}
                <span className="break-all font-mono text-[11px]">{summary.extrasAtLoss.join(', ')}</span>
              </p>
            )}
            {skipped.length > 0 && (
              <p>
                Descartados:{' '}
                {skipped.map(([reason, count]) => `${count} ${SKIP_LABELS[reason] ?? reason}`).join(', ')}
              </p>
            )}
            {summary && summary.errors.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-amber-300">
                {summary.errors.slice(0, 10).map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

export function CentralOnePanel({
  isAdmin,
  status,
}: {
  isAdmin: boolean;
  /** Bloque `centralone` de `/admin/providers/status` (puede faltar en backends viejos). */
  status: CentralOneStatus | undefined;
}) {
  const account = useCentralOneAccount();
  const history = useCentralOneSyncHistory();
  const sync = useSyncCentralOneCatalog();
  const testWebhook = useTestCentralOneWebhook();
  const { copy, isCopied } = useCopy();

  const runs = history.data?.items ?? [];
  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running');
  const balance = account.data?.balance ?? null;
  const webhook = account.data?.webhook;
  const deliveries = account.data?.deliveries ?? [];
  const expectedUrl = webhook?.expectedUrl || CENTRAL_ONE_WEBHOOK_URL;
  const registered = webhook?.registered ?? null;

  const requestSync = () => {
    sync.mutate(undefined, {
      onSuccess: () =>
        toast.success('Sincronización en cola. Tarda unos minutos; el historial se actualiza solo.'),
      onError: (error) => {
        // 409 también es «falta la API key» (failed_precondition): sólo el
        // de una sync activa trae `details.syncId`.
        if (error instanceof ApiError && error.status === 409 && error.details?.syncId) {
          toast('Ya hay una sincronización en curso.', { icon: 'ℹ️' });
          return;
        }
        toast.error(errorMessage(error));
      },
    });
  };

  const sendTest = () => {
    testWebhook.mutate(undefined, {
      onSuccess: (result) =>
        result.ok
          ? toast.success(result.message || 'Central One envió el aviso de prueba.')
          : toast.error(result.message || 'Central One no pudo enviar el aviso de prueba.'),
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <Card>
      <CardHeader
        title="Central One"
        description="Proveedor del catálogo de la tienda: saldo, sincronización y webhook"
        icon={<Server className="h-4 w-4" aria-hidden />}
        action={
          <Badge
            variant={!status ? 'default' : !status.configured ? 'danger' : status.reachable ? 'success' : 'warning'}
          >
            {!status ? 'Sin datos' : !status.configured ? 'Falta clave' : status.reachable ? 'Conectado' : 'Sin respuesta'}
          </Badge>
        }
      />

      <div className="space-y-5">
        {/* --- Saldo --- */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-white">
            <Wallet className="h-4 w-4 text-slate-400" aria-hidden /> Saldo
          </h3>
          {account.isLoading ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : balance ? (
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-xl bg-base-900/60 px-3 py-2">
                <dt className="text-xs text-slate-500">Disponible</dt>
                <dd className={balanceClass(balance.availableUsd)}>{formatUsd(balance.availableUsd)}</dd>
              </div>
              {/* Lo retenido son órdenes en curso: vuelve al disponible si fallan. */}
              <div className="rounded-xl bg-base-900/60 px-3 py-2">
                <dt className="text-xs text-slate-500">Retenido</dt>
                <dd className="font-bold text-slate-200">{formatUsd(balance.heldUsd)}</dd>
              </div>
              <div className="rounded-xl bg-base-900/60 px-3 py-2">
                <dt className="text-xs text-slate-500">Total</dt>
                <dd className="font-bold text-slate-200">{formatUsd(balance.totalUsd)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-red-300">
              {account.data?.balanceError ||
                (account.error ? errorMessage(account.error) : status?.message) ||
                'No se pudo leer el saldo.'}
            </p>
          )}
          {balance && balance.availableUsd < 20 && (
            <p className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Saldo bajo en Central One. Sin saldo las órdenes pagadas quedan esperando (no se reembolsan solas)
              hasta que recargues.
            </p>
          )}
        </section>

        {/* --- Sincronización --- */}
        <section className="border-t border-base-600 pt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white">
                <RefreshCw className="h-4 w-4 text-slate-400" aria-hidden /> Catálogo
              </h3>
              <p className="text-xs text-slate-400">
                Se sincroniza solo cada hora. Precios con tu margen salvo los fijados a mano; lo que apagues en
                Productos sigue apagado.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={sync.isPending}
              disabled={!isAdmin || Boolean(activeRun) || status?.configured === false}
              leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
              onClick={requestSync}
            >
              {activeRun ? 'Sincronizando…' : 'Sincronizar ahora'}
            </Button>
          </div>

          {history.isLoading ? (
            <Skeleton className="h-20 rounded-xl" />
          ) : history.error ? (
            <p className="text-xs text-red-300">{errorMessage(history.error)}</p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-slate-500">Todavía no hay sincronizaciones registradas.</p>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto">
              {runs.map((run) => (
                <SyncRunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </section>

        {/* --- Webhook --- */}
        <section className="border-t border-base-600 pt-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-white">
            <Webhook className="h-4 w-4 text-slate-400" aria-hidden /> Webhook
          </h3>
          <p className="text-xs text-slate-400">
            Central One avisa al instante cuando una orden, un precio o el saldo cambian. Regístralo en su
            portal (Integración → Webhooks) con esta URL y guarda el secreto de firma como
            CENTRAL_ONE_WEBHOOK_SECRET.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-base-900 px-3 py-2 font-mono text-xs text-white">
              {expectedUrl}
            </code>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Copy className="h-4 w-4" aria-hidden />}
              onClick={() => void copy(expectedUrl, 'centralone-webhook-url')}
            >
              {isCopied('centralone-webhook-url') ? 'Copiada' : 'Copiar'}
            </Button>
          </div>

          {account.isLoading ? (
            <Skeleton className="mt-3 h-16 rounded-xl" />
          ) : webhook ? (
            <>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate-500">Secreto de firma</dt>
                  <dd className="flex items-center gap-1.5 text-slate-200">
                    {webhook.secretConfigured ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> Configurado
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3.5 w-3.5 text-red-400" aria-hidden /> Sin secreto: los avisos se
                        rechazan
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Último aviso recibido</dt>
                  <dd className="text-slate-200">
                    {webhook.lastWebhookAt
                      ? `${formatDateTime(webhook.lastWebhookAt)} (${formatRelative(webhook.lastWebhookAt)})`
                      : '—'}
                  </dd>
                </div>
                {!registered && webhook.registeredError && (
                  <div>
                    <dt className="text-xs text-slate-500">URL registrada en Central One</dt>
                    <dd className="text-xs text-amber-200">{webhook.registeredError}</dd>
                  </div>
                )}
                {registered && (
                  <>
                    <div>
                      <dt className="text-xs text-slate-500">URL registrada en Central One</dt>
                      <dd className="break-all font-mono text-xs text-slate-200">
                        {registered.exists === false ? 'Sin registrar' : registered.url ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Estado en Central One</dt>
                      <dd className="text-slate-200">{registered.status ?? '—'}</dd>
                    </div>
                  </>
                )}
              </dl>

              {!webhook.secretConfigured && (
                <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  Copia el secreto que muestra el portal y guárdalo con
                  <code className="mt-1 block rounded-lg bg-base-900 px-3 py-2 font-mono text-xs text-white">
                    firebase functions:secrets:set CENTRAL_ONE_WEBHOOK_SECRET
                  </code>
                  <span className="mt-1 block">Después vuelve a desplegar las funciones.</span>
                </div>
              )}

              {registered?.exists !== false &&
                registered?.url &&
                registered.url !== expectedUrl && (
                  <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    La URL registrada en Central One no coincide con la esperada: corrígela en el portal.
                  </p>
                )}

              <div className="mt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={testWebhook.isPending}
                  disabled={!isAdmin}
                  leftIcon={<Send className="h-4 w-4" aria-hidden />}
                  onClick={sendTest}
                >
                  Probar webhook
                </Button>
              </div>

              {deliveries.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-neon-crimson">
                    Últimas entregas ({deliveries.length})
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="py-1.5 pr-3 font-semibold">Evento</th>
                          <th className="py-1.5 pr-3 font-semibold">Estado</th>
                          <th className="py-1.5 pr-3 font-semibold">Intentos</th>
                          <th className="py-1.5 pr-3 font-semibold">HTTP</th>
                          <th className="py-1.5 pr-3 font-semibold">Fecha</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-base-700 text-slate-300">
                        {deliveries.map((delivery) => (
                          <tr key={delivery.id}>
                            <td className="py-1.5 pr-3 font-mono">{delivery.event}</td>
                            <td className="py-1.5 pr-3">
                              {delivery.status}
                              {delivery.lastError && (
                                <span className="block text-[11px] text-red-300">{delivery.lastError}</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 tabular">{delivery.attempts}</td>
                            <td className="py-1.5 pr-3 tabular">{delivery.lastHttpStatus ?? '—'}</td>
                            <td className="py-1.5 pr-3">
                              {formatDateTime(delivery.deliveredAt ?? delivery.createdAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          ) : account.error ? (
            <p className="mt-3 text-xs text-red-300">{errorMessage(account.error)}</p>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
