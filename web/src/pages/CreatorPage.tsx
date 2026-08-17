/**
 * Panel del creador de contenido.
 *
 * Muestra su código, sus condiciones y cuánto lleva ganado. Deliberadamente no
 * enseña quién compró: el libro de comisiones no guarda la identidad del
 * comprador, y ésa es también la razón por la que el creador puede leerlo.
 */
import { Coins, Share2, TrendingUp, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/providers/AuthProvider';
import { useCreatorSummary, useCreatorCommissions } from '@/hooks/useAccount';
import { useDocumentTitle, useCopy } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CopyField } from '@/components/common/CopyField';
import { EmptyState, FullPageLoader, Skeleton } from '@/components/ui/Feedback';
import { formatRelative, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CommissionStatus } from '@/types/models';

const ESTADO: Record<CommissionStatus, { label: string; className: string }> = {
  pending: { label: 'Por cobrar', className: 'text-amber-300' },
  paid: { label: 'Pagada', className: 'text-emerald-400' },
  reverted: { label: 'Anulada', className: 'text-slate-500' },
};

function Metric({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <Card className="min-w-0">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
        {icon}
      </span>
      <p className="mt-2.5 text-xs text-slate-400">{label}</p>
      <p className={cn('text-xl font-black tabular text-white', accent)}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export function CreatorPage() {
  useDocumentTitle('Panel de creador');
  const { me, profileLoading } = useAuth();
  const { copy } = useCopy();

  const isCreator = Boolean(me?.isCreator);
  const summary = useCreatorSummary(isCreator);
  const commissions = useCreatorCommissions(isCreator);

  if (profileLoading || !me) return <FullPageLoader />;

  if (!isCreator) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <EmptyState
          icon={<TrendingUp className="h-7 w-7" aria-hidden />}
          title="Todavía no eres creador"
          description="El programa de creadores es por invitación. Si haces contenido de juegos y quieres tu código, escríbenos por soporte."
        />
      </div>
    );
  }

  if (summary.isLoading || !summary.data) return <FullPageLoader label="Cargando tus métricas…" />;

  const creator = summary.data.creator;
  const shareUrl = `${window.location.origin}/?c=${creator.code}`;

  const share = async () => {
    const text =
      `¡Recarga tus juegos en Refill Store con mi código ${creator.code}!` +
      (creator.discountPercent > 0 ? ` Tienes ${creator.discountPercent}% de descuento.` : '') +
      ` ${shareUrl}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Refill Store', text, url: shareUrl });
        return;
      } catch {
        // Canceló el diálogo nativo: se cae al portapapeles.
      }
    }

    if (await copy(text, 'share')) toast.success('Enlace copiado.');
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
          <TrendingUp className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold">Panel de creador</h1>
          <p className="text-sm text-slate-400">
            Ganas {creator.commissionPercent}% de cada recarga hecha con tu código
          </p>
        </div>
      </div>

      <Card>
        <p className="text-sm font-semibold text-white">Tu código</p>
        <p className="mt-1 text-xs text-slate-400">
          Compártelo en tus vídeos o pásalo por el enlace: quien entre por ahí lo lleva ya puesto.
        </p>

        <div className="mt-3 space-y-2">
          <CopyField label="Código" value={creator.code} />
          <CopyField label="Enlace" value={shareUrl} />
        </div>

        <Button
          fullWidth
          className="mt-3"
          leftIcon={<Share2 className="h-4 w-4" aria-hidden />}
          onClick={() => void share()}
        >
          Compartir
        </Button>

        {creator.discountPercent > 0 && (
          <p className="mt-3 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            Quien use tu código recibe {creator.discountPercent}% de descuento.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          icon={<Coins className="h-4 w-4" aria-hidden />}
          label="Por cobrar"
          value={formatUsd(creator.stats.pendingUsd)}
          accent={creator.stats.pendingUsd > 0 ? 'text-emerald-400' : undefined}
        />
        <Metric
          icon={<Coins className="h-4 w-4" aria-hidden />}
          label="Ya cobrado"
          value={formatUsd(creator.stats.paidUsd)}
        />
        <Metric
          icon={<Users className="h-4 w-4" aria-hidden />}
          label="Recargas"
          value={String(creator.stats.orders)}
          hint="con tu código"
        />
        <Metric
          icon={<TrendingUp className="h-4 w-4" aria-hidden />}
          label="Ventas"
          value={formatUsd(creator.stats.salesUsd)}
          hint="que trajiste"
        />
      </div>

      <Card className="text-xs leading-relaxed text-slate-400">
        Lo que está <span className="font-semibold text-amber-300">por cobrar</span> se te acredita
        como saldo en tu cuenta cuando el equipo hace la liquidación. Si una recarga se reembolsa, su
        comisión se anula.
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-white">Tus comisiones</h2>

        {commissions.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-16 rounded-2xl" />
            ))}
          </div>
        ) : (commissions.data?.commissions.length ?? 0) === 0 ? (
          <EmptyState
            title="Todavía no hay ventas con tu código"
            description="Cuando alguien recargue usando tu código, aparecerá aquí."
          />
        ) : (
          <Card className="p-0">
            {commissions.data?.commissions.map((entry) => {
              const estado = ESTADO[entry.status];

              return (
                <div
                  key={entry.orderId}
                  className="flex items-center justify-between gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{entry.productName}</p>
                    <p className="truncate text-xs text-slate-500">
                      {entry.gameName} · {formatRelative(entry.createdAt)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={cn(
                        'text-sm font-bold tabular',
                        entry.status === 'reverted'
                          ? 'text-slate-600 line-through'
                          : 'text-emerald-400'
                      )}
                    >
                      +{formatUsd(entry.amountUsd)}
                    </p>
                    <p className={cn('text-xs', estado.className)}>{estado.label}</p>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>
    </div>
  );
}
