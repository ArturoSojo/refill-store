import { useState } from 'react';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminCoupons, useSaveCoupon, useDeleteCoupon, useAdminGames } from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { formatDate, formatUsd, toMillis } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import type { Coupon } from '@/types/models';

interface CouponForm {
  code: string;
  description: string;
  type: 'percent' | 'fixed';
  value: string;
  minOrderUsd: string;
  maxDiscountUsd: string;
  usageLimit: string;
  perUserLimit: string;
  validUntil: string;
  gameIds: string[];
  active: boolean;
}

const EMPTY: CouponForm = {
  code: '',
  description: '',
  type: 'percent',
  value: '10',
  minOrderUsd: '0',
  maxDiscountUsd: '',
  usageLimit: '',
  perUserLimit: '1',
  validUntil: '',
  gameIds: [],
  active: true,
};

/** `yyyy-MM-dd` para el input date, o cadena vacía. */
function toDateInput(value: Coupon['validUntil']): string {
  const millis = toMillis(value);
  if (millis === null) return '';
  return new Date(millis).toISOString().slice(0, 10);
}

export function AdminCoupons() {
  useDocumentTitle('Panel · Cupones');
  const { isAdmin } = useAuth();

  const coupons = useAdminCoupons();
  const games = useAdminGames();
  const saveCoupon = useSaveCoupon();
  const deleteCoupon = useDeleteCoupon();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [form, setForm] = useState<CouponForm>(EMPTY);
  const [toDelete, setToDelete] = useState<Coupon | null>(null);

  const submit = () => {
    const data: Record<string, unknown> = {
      description: form.description.trim(),
      type: form.type,
      value: Number(form.value),
      minOrderUsd: Number(form.minOrderUsd) || 0,
      maxDiscountUsd: form.maxDiscountUsd ? Number(form.maxDiscountUsd) : null,
      usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
      perUserLimit: Number(form.perUserLimit) || 0,
      validUntilMillis: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).getTime() : null,
      gameIds: form.gameIds,
      productIds: [],
      active: form.active,
    };

    if (!editing) data.code = form.code.trim().toUpperCase();

    saveCoupon.mutate(
      { code: editing?.code, data },
      {
        onSuccess: () => {
          toast.success(editing ? 'Cupón actualizado.' : 'Cupón creado.');
          setFormOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const list = coupons.data?.coupons ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Cupones</h1>
          <p className="text-sm text-slate-400">{list.length} cupón(es)</p>
        </div>

        {isAdmin && (
          <Button
            size="sm"
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => {
              setEditing(null);
              setForm(EMPTY);
              setFormOpen(true);
            }}
          >
            Nuevo cupón
          </Button>
        )}
      </div>

      {coupons.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Tag className="h-7 w-7" aria-hidden />}
          title="Sin cupones"
          description="Crea códigos de descuento para promociones puntuales."
        />
      ) : (
        <Card className="p-0">
          {list.map((coupon) => {
            const exhausted =
              coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit;

            return (
              <div
                key={coupon.code}
                className="flex flex-wrap items-center gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold text-neon-crimson">
                      {coupon.code}
                    </span>
                    {!coupon.active && <Badge variant="danger">Inactivo</Badge>}
                    {exhausted && <Badge variant="warning">Agotado</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {coupon.type === 'percent'
                      ? `${coupon.value}% de descuento`
                      : `${formatUsd(coupon.value)} de descuento`}
                    {coupon.minOrderUsd > 0 && ` · mínimo ${formatUsd(coupon.minOrderUsd)}`}
                    {coupon.validUntil && ` · hasta ${formatDate(coupon.validUntil)}`}
                  </p>
                </div>

                <div className="text-right text-xs">
                  <p className="tabular text-white">
                    {coupon.usageCount}
                    {coupon.usageLimit !== null ? ` / ${coupon.usageLimit}` : ''} usos
                  </p>
                  <p className="text-slate-500">{coupon.perUserLimit} por usuario</p>
                </div>

                {isAdmin && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(coupon);
                        setForm({
                          code: coupon.code,
                          description: coupon.description ?? '',
                          type: coupon.type,
                          value: String(coupon.value),
                          minOrderUsd: String(coupon.minOrderUsd),
                          maxDiscountUsd:
                            coupon.maxDiscountUsd === null ? '' : String(coupon.maxDiscountUsd),
                          usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
                          perUserLimit: String(coupon.perUserLimit),
                          validUntil: toDateInput(coupon.validUntil),
                          gameIds: coupon.gameIds ?? [],
                          active: coupon.active,
                        });
                        setFormOpen(true);
                      }}
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-base-700 hover:text-white"
                      aria-label={`Editar ${coupon.code}`}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setToDelete(coupon)}
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                      aria-label={`Eliminar ${coupon.code}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar ${editing.code}` : 'Nuevo cupón'}
        size="md"
        footer={
          <Button
            fullWidth
            loading={saveCoupon.isPending}
            disabled={!editing && form.code.trim().length < 3}
            onClick={submit}
          >
            {editing ? 'Guardar cambios' : 'Crear cupón'}
          </Button>
        }
      >
        <div className="space-y-4">
          {!editing && (
            <Input
              label="Código"
              value={form.code}
              onChange={(event) =>
                setForm({ ...form, code: event.target.value.toUpperCase().replace(/\s/g, '') })
              }
              placeholder="BIENVENIDO10"
              className="font-mono uppercase"
              required
            />
          )}

          <Input
            label="Descripción"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="Promoción de lanzamiento"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Tipo"
              value={form.type}
              onChange={(event) =>
                setForm({ ...form, type: event.target.value as 'percent' | 'fixed' })
              }
              options={[
                { value: 'percent', label: 'Porcentaje' },
                { value: 'fixed', label: 'Monto fijo (USD)' },
              ]}
            />
            <Input
              label={form.type === 'percent' ? 'Descuento (%)' : 'Descuento (USD)'}
              type="number"
              step="0.01"
              value={form.value}
              onChange={(event) => setForm({ ...form, value: event.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Compra mínima (USD)"
              type="number"
              step="0.01"
              value={form.minOrderUsd}
              onChange={(event) => setForm({ ...form, minOrderUsd: event.target.value })}
            />
            <Input
              label="Descuento máximo (USD)"
              type="number"
              step="0.01"
              value={form.maxDiscountUsd}
              onChange={(event) => setForm({ ...form, maxDiscountUsd: event.target.value })}
              hint="Opcional, útil con porcentajes"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Límite total de usos"
              type="number"
              value={form.usageLimit}
              onChange={(event) => setForm({ ...form, usageLimit: event.target.value })}
              placeholder="Sin límite"
            />
            <Input
              label="Usos por usuario"
              type="number"
              value={form.perUserLimit}
              onChange={(event) => setForm({ ...form, perUserLimit: event.target.value })}
              hint="0 = sin límite por usuario"
            />
          </div>

          <Input
            label="Válido hasta"
            type="date"
            value={form.validUntil}
            onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
            hint="Vacío = sin fecha de vencimiento"
          />

          <div>
            <p className="label-base">Restringir a juegos</p>
            <div className="flex flex-wrap gap-2">
              {(games.data?.games ?? []).map((game) => {
                const selected = form.gameIds.includes(game.id);
                return (
                  <button
                    key={game.id}
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        gameIds: selected
                          ? form.gameIds.filter((id) => id !== game.id)
                          : [...form.gameIds, game.id],
                      })
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      selected
                        ? 'border-neon-red bg-neon-red/15 text-white'
                        : 'border-base-600 bg-base-900 text-slate-400'
                    }`}
                  >
                    {game.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Sin selección, el cupón aplica a todo el catálogo.
            </p>
          </div>

          <Switch
            checked={form.active}
            onChange={(active) => setForm({ ...form, active })}
            label="Activo"
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          deleteCoupon.mutate(toDelete.code, {
            onSuccess: () => {
              toast.success('Cupón eliminado.');
              setToDelete(null);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Eliminar cupón"
        message={`Se eliminará el código ${toDelete?.code}. Las órdenes que ya lo usaron no cambian.`}
        confirmLabel="Eliminar"
        destructive
        loading={deleteCoupon.isPending}
      />
    </div>
  );
}
