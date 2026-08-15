/**
 * Niveles de fidelidad.
 *
 * La escalera se edita entera y se guarda de una sola vez: los umbrales sólo
 * tienen sentido unos respecto a otros, y guardar un escalón suelto dejaría
 * pasar tramos solapados. Por eso hay un único botón de guardar y la validación
 * se muestra antes de habilitarlo.
 *
 * Los niveles no se crean ni se borran: sus claves están escritas en el perfil
 * de cada usuario y renombrarlas dejaría a la gente con un nivel inexistente.
 * Lo editable es el umbral, el descuento y los textos.
 */
import { useEffect, useMemo, useState } from 'react';
import { Info, RefreshCw, RotateCcw, Save, TrendingUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminTiers, useSaveTiers, useRecalculateTiers, type TierRecalculation } from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Modal';
import { ErrorState, Skeleton } from '@/components/ui/Feedback';
import { TIER_META, formatUsd } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import type { TierDefinition } from '@/types/models';

/** Los campos numéricos se editan como texto: si no, borrar el 0 es imposible. */
interface TierDraft {
  tier: TierDefinition['tier'];
  label: string;
  minSpentUsd: string;
  discountPercent: string;
  profile: string;
}

function toDraft(tiers: TierDefinition[]): TierDraft[] {
  return tiers.map((entry) => ({
    tier: entry.tier,
    label: entry.label,
    minSpentUsd: String(entry.minSpentUsd),
    discountPercent: String(entry.discountPercent),
    profile: entry.profile,
  }));
}

function toPayload(draft: TierDraft[]): TierDefinition[] {
  return draft.map((entry) => ({
    tier: entry.tier,
    label: entry.label.trim(),
    minSpentUsd: Number(entry.minSpentUsd) || 0,
    discountPercent: Number(entry.discountPercent) || 0,
    profile: entry.profile.trim(),
  }));
}

/**
 * Reglas espejo de las que aplica el backend.
 *
 * Se repiten aquí para poder señalar la fila exacta mientras se escribe, en vez
 * de esperar a que el servidor rechace el guardado entero con un solo mensaje.
 */
function validate(draft: TierDraft[]): Map<number, string> {
  const errors = new Map<number, string>();
  const rows = toPayload(draft);

  rows.forEach((row, index) => {
    if (!row.label) {
      errors.set(index, 'El nombre no puede quedar vacío.');
      return;
    }
    if (index === 0 && row.minSpentUsd !== 0) {
      errors.set(index, 'El primer nivel tiene que empezar en $0.');
      return;
    }
    if (index > 0) {
      const previous = rows[index - 1];
      if (row.minSpentUsd <= previous.minSpentUsd) {
        errors.set(index, `Tiene que exigir más de ${formatUsd(previous.minSpentUsd)} (${previous.label}).`);
        return;
      }
      if (row.discountPercent < previous.discountPercent) {
        errors.set(index, `No puede dar menos que ${previous.label} (−${previous.discountPercent}%).`);
        return;
      }
    }
    if (row.discountPercent < 0 || row.discountPercent > 50) {
      errors.set(index, 'El descuento va de 0% a 50%.');
    }
  });

  return errors;
}

function RecalculationReport({ result, applied }: { result: TierRecalculation; applied: boolean }) {
  if (result.changed.length === 0) {
    return (
      <p className="text-sm text-emerald-300">
        Los {result.total} perfiles ya tienen el nivel que les toca. No hay nada que cambiar.
      </p>
    );
  }

  const lose = result.changed.filter((entry) => entry.discountTo < entry.discountFrom);
  const gain = result.changed.filter((entry) => entry.discountTo > entry.discountFrom);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300">
        {applied ? 'Se actualizaron' : 'Se actualizarían'}{' '}
        <span className="font-bold text-white">{result.changed.length}</span> de {result.total} perfiles.{' '}
        <span className="text-emerald-300">{gain.length} suben de descuento</span>
        {' · '}
        <span className="text-amber-300">{lose.length} bajan</span>.
      </p>

      <ul className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-base-600 p-2">
        {result.changed.slice(0, 60).map((entry) => (
          <li key={entry.uid} className="flex items-center justify-between gap-3 px-1.5 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate text-slate-300">{entry.email ?? entry.uid}</span>
            <span className="shrink-0 tabular text-slate-500">{formatUsd(entry.totalSpentUsd)}</span>
            <span className="shrink-0 tabular">
              <span className="text-slate-400">
                {entry.from ? TIER_META[entry.from].label : '—'} −{entry.discountFrom}%
              </span>
              <span className="mx-1 text-slate-600">→</span>
              <span
                className={cn(
                  'font-semibold',
                  entry.discountTo >= entry.discountFrom ? 'text-emerald-400' : 'text-amber-400'
                )}
              >
                {TIER_META[entry.to].label} −{entry.discountTo}%
              </span>
            </span>
          </li>
        ))}
      </ul>

      {result.changed.length > 60 && (
        <p className="text-xs text-slate-500">
          Se muestran los primeros 60 de {result.changed.length}.
        </p>
      )}
    </div>
  );
}

export function AdminTiers() {
  useDocumentTitle('Panel · Niveles');

  const tiers = useAdminTiers();
  const saveTiers = useSaveTiers();
  const recalculate = useRecalculateTiers();

  const [draft, setDraft] = useState<TierDraft[]>([]);
  const [preview, setPreview] = useState<TierRecalculation | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const saved = tiers.data?.tiers;

  useEffect(() => {
    if (saved) setDraft(toDraft(saved));
  }, [saved]);

  const errors = useMemo(() => validate(draft), [draft]);
  const dirty = useMemo(() => {
    if (!saved || draft.length === 0) return false;
    return JSON.stringify(toPayload(draft)) !== JSON.stringify(saved);
  }, [draft, saved]);

  const update = (index: number, patch: Partial<TierDraft>) => {
    setDraft((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const save = () => {
    saveTiers.mutate(toPayload(draft), {
      onSuccess: () => {
        toast.success('Niveles guardados.');
        // Cambiar un umbral no mueve a nadie por sí solo: el nivel guardado en
        // cada perfil sólo se refresca al comprar. Se ofrece el recálculo aquí
        // mismo para que no quede a medias.
        setPreview(null);
        recalculate.mutate(true, {
          onSuccess: (result) => {
            if (result.changed.length > 0) setPreview(result);
          },
        });
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  if (tiers.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-2xl" />
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-20 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (tiers.error) return <ErrorState message="No pudimos cargar los niveles." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Niveles</h1>
          <p className="text-sm text-slate-400">
            Cuánto hay que comprar para cada nivel y qué descuento da
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RotateCcw className="h-4 w-4" aria-hidden />}
            disabled={!dirty}
            onClick={() => saved && setDraft(toDraft(saved))}
          >
            Descartar
          </Button>
          <Button
            size="sm"
            leftIcon={<Save className="h-4 w-4" aria-hidden />}
            disabled={!dirty || errors.size > 0}
            loading={saveTiers.isPending}
            onClick={save}
          >
            Guardar
          </Button>
        </div>
      </div>

      <Card className="flex items-start gap-2.5 border-sky-500/25 bg-sky-500/5">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        <div className="text-xs leading-relaxed text-slate-300">
          <p>
            El descuento se aplica solo a cada compra, sobre el precio del paquete, y se suma al
            cupón si el cliente usa uno.
          </p>
          <p className="mt-1">
            Los nombres de nivel no se pueden agregar ni quitar porque están escritos en el perfil
            de cada usuario, pero sí puedes renombrarlos y mover sus umbrales.
          </p>
        </div>
      </Card>

      <Card className="p-0">
        {/* Encabezado sólo en pantallas anchas: en móvil cada fila se lee sola. */}
        <div className="hidden border-b border-base-600 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 sm:grid sm:grid-cols-[minmax(0,1.4fr)_110px_110px_minmax(0,1.6fr)] sm:gap-3">
          <span>Nivel</span>
          <span>Desde (USD)</span>
          <span>Descuento</span>
          <span>Perfil</span>
        </div>

        <ul>
          {draft.map((row, index) => {
            const meta = TIER_META[row.tier];
            const error = errors.get(index);

            return (
              <li
                key={row.tier}
                className={cn(
                  'border-b border-base-700 px-4 py-3 last:border-b-0',
                  error && 'bg-red-500/5'
                )}
              >
                <div className="sm:grid sm:grid-cols-[minmax(0,1.4fr)_110px_110px_minmax(0,1.6fr)] sm:items-center sm:gap-3">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-lg" aria-hidden>
                      {meta.icon}
                    </span>
                    <Input
                      value={row.label}
                      onChange={(event) => update(index, { label: event.target.value.slice(0, 24) })}
                      aria-label={`Nombre del nivel ${meta.label}`}
                    />
                  </div>

                  <div className="mt-2 sm:mt-0">
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      inputMode="decimal"
                      value={row.minSpentUsd}
                      // El primer escalón es el piso de todos: siempre arranca
                      // en cero y no tiene sentido dejarlo mover.
                      disabled={index === 0}
                      onChange={(event) => update(index, { minSpentUsd: event.target.value })}
                      aria-label={`Gasto mínimo de ${meta.label}`}
                    />
                  </div>

                  <div className="mt-2 sm:mt-0">
                    <Input
                      type="number"
                      min={0}
                      max={50}
                      step="0.1"
                      inputMode="decimal"
                      value={row.discountPercent}
                      onChange={(event) => update(index, { discountPercent: event.target.value })}
                      aria-label={`Descuento de ${meta.label}`}
                    />
                  </div>

                  <div className="mt-2 sm:mt-0">
                    <Input
                      value={row.profile}
                      onChange={(event) => update(index, { profile: event.target.value.slice(0, 80) })}
                      placeholder="Cómo se describe este nivel"
                      aria-label={`Perfil de ${meta.label}`}
                    />
                  </div>
                </div>

                {error && <p className="mt-1.5 text-xs font-medium text-red-300">{error}</p>}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <TrendingUp className="h-4 w-4 text-neon-red" aria-hidden />
              Recalcular los niveles de todos
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              El nivel de cada cliente se guarda en su perfil y sólo se actualiza cuando compra. Si
              acabas de mover un umbral, corre esto para que el cambio le llegue a todos ahora
              mismo. Primero verás qué cambiaría, sin tocar nada.
            </p>
          </div>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
            loading={recalculate.isPending}
            onClick={() =>
              recalculate.mutate(true, {
                onSuccess: (result) => {
                  setPreview(result);
                  if (result.changed.length === 0) toast.success('Todos los perfiles están al día.');
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            Ver qué cambiaría
          </Button>
        </div>

        {preview && (
          <div className="mt-4 border-t border-base-600 pt-4">
            <RecalculationReport result={preview} applied={false} />

            {preview.changed.length > 0 && (
              <Button
                size="sm"
                className="mt-3"
                leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
                onClick={() => setConfirmApply(true)}
              >
                Aplicar a {preview.changed.length} perfil(es)
              </Button>
            )}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmApply}
        onClose={() => setConfirmApply(false)}
        onConfirm={() => {
          recalculate.mutate(false, {
            onSuccess: (result) => {
              toast.success(`${result.changed.length} perfil(es) actualizados.`);
              setPreview(null);
              setConfirmApply(false);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Recalcular los niveles"
        message={
          preview
            ? `Se cambiará el nivel de ${preview.changed.length} perfil(es). ` +
              `${preview.changed.filter((e) => e.discountTo < e.discountFrom).length} de ellos ` +
              'pasarán a tener un descuento menor del que tienen hoy.'
            : ''
        }
        confirmLabel="Sí, recalcular"
        cancelLabel="Volver"
        loading={recalculate.isPending}
      />
    </div>
  );
}
