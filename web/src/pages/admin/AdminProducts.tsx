import { useEffect, useMemo, useState } from 'react';
import { Calculator, Package, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminGames,
  useAdminProducts,
  useDeleteProduct,
  useReprice,
  useSaveProduct,
  useSeedCatalog,
} from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch, Textarea } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { ImageUpload } from '@/components/common/ImageUpload';
import { formatBs, formatUsd } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import type { DispatchCall, ManualFlow, Product } from '@/types/models';

interface ProductFormState {
  gameId: string;
  sku: string;
  name: string;
  description: string;
  fulfillment: 'auto' | 'manual';
  manualFlow: ManualFlow;
  kind: 'package' | 'combo' | 'special';
  amount: string;
  bonus: string;
  costUsd: string;
  priceUsd: string;
  compareAtUsd: string;
  imageUrl: string;
  badge: string;
  active: boolean;
  featured: boolean;
  sortOrder: string;
  stock: string;
  deliveryEtaMinutes: string;
  calls: DispatchCall[];
}

const EMPTY_FORM: ProductFormState = {
  gameId: '',
  sku: '',
  name: '',
  description: '',
  fulfillment: 'auto',
  manualFlow: 'notify',
  kind: 'package',
  amount: '0',
  bonus: '0',
  costUsd: '0',
  priceUsd: '0',
  compareAtUsd: '',
  imageUrl: '',
  badge: '',
  active: true,
  featured: false,
  sortOrder: '99',
  stock: '',
  deliveryEtaMinutes: '2',
  calls: [{ packageId: 1, quantity: 1 }],
};

function toForm(product: Product): ProductFormState {
  return {
    gameId: product.gameId,
    sku: product.sku,
    name: product.name,
    description: product.description ?? '',
    fulfillment: product.fulfillment,
    manualFlow: product.manualFlow ?? 'notify',
    kind: product.kind,
    amount: String(product.amount),
    bonus: String(product.bonus),
    costUsd: String(product.costUsd),
    priceUsd: String(product.priceUsd),
    compareAtUsd: product.compareAtUsd === null ? '' : String(product.compareAtUsd),
    imageUrl: product.imageUrl ?? '',
    badge: product.badge ?? '',
    active: product.active,
    featured: product.featured,
    sortOrder: String(product.sortOrder),
    stock: product.stock === null ? '' : String(product.stock),
    deliveryEtaMinutes: String(product.deliveryEtaMinutes),
    calls: product.calls.length > 0 ? product.calls : [],
  };
}

/** Editor de la secuencia de llamadas: es lo que define cómo se arma un combo. */
function CallsEditor({
  calls,
  onChange,
}: {
  calls: DispatchCall[];
  onChange: (calls: DispatchCall[]) => void;
}) {
  const total = calls.reduce((sum, call) => sum + call.quantity, 0);

  return (
    <div>
      <p className="label-base">Llamadas al proveedor (package_id)</p>
      <p className="mb-2 text-xs text-slate-500">
        Se ejecutan en orden. Para el combo 830+83 💎: paquete 3, luego paquete 2.
      </p>

      <div className="space-y-2">
        {calls.map((call, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-center text-xs text-slate-500">{index + 1}</span>
            <input
              type="number"
              value={call.packageId}
              onChange={(event) => {
                const next = [...calls];
                next[index] = { ...call, packageId: Number(event.target.value) };
                onChange(next);
              }}
              placeholder="package_id"
              className="input-base flex-1 py-2"
            />
            <input
              type="number"
              min={1}
              max={10}
              value={call.quantity}
              onChange={(event) => {
                const next = [...calls];
                next[index] = { ...call, quantity: Math.max(1, Number(event.target.value)) };
                onChange(next);
              }}
              className="input-base w-20 py-2"
              title="Veces seguidas"
            />
            <button
              type="button"
              onClick={() => onChange(calls.filter((_, i) => i !== index))}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
              aria-label="Quitar llamada"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Plus className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => onChange([...calls, { packageId: 1, quantity: 1 }])}
        >
          Añadir llamada
        </Button>
        <span className="text-xs text-slate-500">
          {total} recarga{total === 1 ? '' : 's'} en total
        </span>
      </div>
    </div>
  );
}

export function AdminProducts() {
  useDocumentTitle('Panel · Productos');
  const { isAdmin } = useAuth();
  const { rate } = useConfig();

  const [gameFilter, setGameFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM);
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [repriceOpen, setRepriceOpen] = useState(false);
  const [margin, setMargin] = useState('25');
  const [seedOpen, setSeedOpen] = useState(false);

  const games = useAdminGames();
  const products = useAdminProducts(gameFilter || undefined);
  const saveProduct = useSaveProduct();
  const deleteProduct = useDeleteProduct();
  const reprice = useReprice();
  const seed = useSeedCatalog();

  const gameOptions = useMemo(
    () => (games.data?.games ?? []).map((game) => ({ value: game.id, label: game.name })),
    [games.data]
  );

  useEffect(() => {
    if (formOpen && !editing && gameOptions.length > 0 && !form.gameId) {
      setForm((current) => ({ ...current, gameId: gameFilter || gameOptions[0].value }));
    }
  }, [formOpen, editing, gameOptions, gameFilter, form.gameId]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, gameId: gameFilter || gameOptions[0]?.value || '' });
    setFormOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setForm(toForm(product));
    setFormOpen(true);
  };

  const submit = () => {
    const payload: Record<string, unknown> = {
      gameId: form.gameId,
      sku: form.sku.trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      fulfillment: form.fulfillment,
      manualFlow: form.manualFlow,
      kind: form.kind,
      amount: Number(form.amount) || 0,
      bonus: Number(form.bonus) || 0,
      costUsd: Number(form.costUsd) || 0,
      priceUsd: Number(form.priceUsd) || 0,
      compareAtUsd: form.compareAtUsd ? Number(form.compareAtUsd) : null,
      calls: form.fulfillment === 'auto' ? form.calls : [],
      imageUrl: form.imageUrl.trim(),
      badge: form.badge.trim() || null,
      active: form.active,
      featured: form.featured,
      sortOrder: Number(form.sortOrder) || 99,
      stock: form.stock === '' ? null : Number(form.stock),
      deliveryEtaMinutes: Number(form.deliveryEtaMinutes) || 2,
    };

    saveProduct.mutate(
      { id: editing?.id, data: payload },
      {
        onSuccess: () => {
          toast.success(editing ? 'Producto actualizado.' : 'Producto creado.');
          setFormOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const list = products.data?.products ?? [];
  const marginOf = (product: Product) =>
    product.costUsd > 0
      ? Math.round(((product.priceUsd - product.costUsd) / product.costUsd) * 100)
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Productos</h1>
          <p className="text-sm text-slate-400">{list.length} producto(s) en el catálogo</p>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Sparkles className="h-4 w-4" aria-hidden />}
              onClick={() => setSeedOpen(true)}
            >
              Sembrar catálogo
            </Button>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Calculator className="h-4 w-4" aria-hidden />}
              onClick={() => setRepriceOpen(true)}
            >
              Recalcular precios
            </Button>
            <Button size="sm" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={openCreate}>
              Nuevo
            </Button>
          </div>
        )}
      </div>

      <Select
        value={gameFilter}
        onChange={(event) => setGameFilter(event.target.value)}
        placeholder="Todos los juegos"
        options={gameOptions}
        containerClassName="max-w-xs"
      />

      {products.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Package className="h-7 w-7" aria-hidden />}
          title="Catálogo vacío"
          description="Siembra el catálogo del documento técnico o crea productos manualmente."
          action={
            isAdmin ? <Button onClick={() => setSeedOpen(true)}>Sembrar catálogo</Button> : undefined
          }
        />
      ) : (
        <Card className="p-0">
          {list.map((product) => (
            <div
              key={product.id}
              className="flex flex-wrap items-center gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">{product.name}</span>
                  {!product.active && <Badge variant="danger">Inactivo</Badge>}
                  {product.featured && <Badge variant="brand">Destacado</Badge>}
                  {product.badge && <Badge>{product.badge}</Badge>}
                  <Badge variant={product.fulfillment === 'auto' ? 'info' : 'success'}>
                    {product.fulfillment === 'auto'
                      ? `${product.calls.reduce((sum, call) => sum + call.quantity, 0)} llamada(s)`
                      : 'Manual'}
                  </Badge>
                </div>
                <p className="mt-0.5 font-mono text-xs text-slate-500">
                  {product.sku} · {product.gameId}
                  {product.stock !== null && ` · stock ${product.stock}`}
                </p>
              </div>

              <div className="text-right">
                <p className="text-sm font-bold tabular text-white">
                  {formatUsd(product.priceUsd)}
                </p>
                <p className="text-xs tabular text-slate-500">{formatBs(product.priceUsd * rate)}</p>
                <p
                  className={cn(
                    'text-xs tabular',
                    marginOf(product) >= 15 ? 'text-emerald-400' : 'text-amber-400'
                  )}
                >
                  costo {formatUsd(product.costUsd)} · +{marginOf(product)}%
                </p>
              </div>

              {isAdmin && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(product)}
                    className="rounded-lg p-2 text-slate-400 transition hover:bg-base-700 hover:text-white"
                    aria-label={`Editar ${product.name}`}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setToDelete(product)}
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                    aria-label={`Eliminar ${product.name}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* --- Formulario --- */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar ${editing.name}` : 'Nuevo producto'}
        size="lg"
        footer={
          <Button
            fullWidth
            loading={saveProduct.isPending}
            disabled={!form.gameId || form.sku.length < 2 || form.name.length < 2}
            onClick={submit}
          >
            {editing ? 'Guardar cambios' : 'Crear producto'}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Juego"
              value={form.gameId}
              onChange={(event) => setForm({ ...form, gameId: event.target.value })}
              options={gameOptions}
              required
            />
            <Input
              label="SKU"
              value={form.sku}
              onChange={(event) => setForm({ ...form, sku: event.target.value.toUpperCase() })}
              placeholder="FF-D-341"
              required
            />
          </div>

          <Input
            label="Nombre"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="310 + 31 Diamantes"
            required
          />

          <Textarea
            label="Descripción"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            rows={2}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Modalidad de entrega"
              value={form.fulfillment}
              onChange={(event) =>
                setForm({
                  ...form,
                  fulfillment: event.target.value as 'auto' | 'manual',
                  kind: event.target.value === 'manual' ? 'special' : form.kind,
                  deliveryEtaMinutes: event.target.value === 'manual' ? '15' : '2',
                })
              }
              options={[
                { value: 'auto', label: 'Automática (API Inefable)' },
                { value: 'manual', label: 'Manual (la entrega el equipo)' },
              ]}
            />
            <Select
              label="Tipo"
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as ProductFormState['kind'] })
              }
              options={[
                { value: 'package', label: 'Paquete individual' },
                { value: 'combo', label: 'Combo (varias llamadas)' },
                { value: 'special', label: 'Especial / manual' },
              ]}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Cantidad base"
              type="number"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
            <Input
              label="Bono"
              type="number"
              value={form.bonus}
              onChange={(event) => setForm({ ...form, bonus: event.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Costo (USD)"
              type="number"
              step="0.001"
              value={form.costUsd}
              onChange={(event) => setForm({ ...form, costUsd: event.target.value })}
              hint="Lo que cobra el proveedor"
            />
            <Input
              label="Precio (USD)"
              type="number"
              step="0.01"
              value={form.priceUsd}
              onChange={(event) => setForm({ ...form, priceUsd: event.target.value })}
              hint={
                Number(form.costUsd) > 0
                  ? `Margen ${Math.round(
                      ((Number(form.priceUsd) - Number(form.costUsd)) / Number(form.costUsd)) * 100
                    )}%`
                  : undefined
              }
            />
            <Input
              label="Precio tachado"
              type="number"
              step="0.01"
              value={form.compareAtUsd}
              onChange={(event) => setForm({ ...form, compareAtUsd: event.target.value })}
              hint="Opcional"
            />
          </div>

          {form.fulfillment === 'manual' && (
            <Select
              label="Qué ve el cliente al pagar"
              value={form.manualFlow}
              onChange={(event) =>
                setForm({ ...form, manualFlow: event.target.value as ManualFlow })
              }
              hint={
                form.manualFlow === 'notify'
                  ? 'No hace nada: se le avisa por notificación y correo cuando lo completes.'
                  : form.manualFlow === 'phone'
                    ? 'Se le pide el teléfono al comprar y te llega en el aviso para que le escribas tú.'
                    : 'Se le ofrece el botón para abrir el chat contigo, como antes.'
              }
              options={[
                { value: 'notify', label: 'Sólo avisarle cuando esté lista' },
                { value: 'phone', label: 'Pedirle su teléfono para escribirle yo' },
                { value: 'whatsapp', label: 'Mandarlo a WhatsApp' },
              ]}
            />
          )}

          {form.fulfillment === 'auto' && (
            <CallsEditor calls={form.calls} onChange={(calls) => setForm({ ...form, calls })} />
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Desempate"
              type="number"
              value={form.sortOrder}
              onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
              hint="La tienda ordena sola de menor a mayor cantidad. Esto sólo decide entre dos productos que den lo mismo."
            />
            <Input
              label="Stock"
              type="number"
              value={form.stock}
              onChange={(event) => setForm({ ...form, stock: event.target.value })}
              placeholder="Ilimitado"
              hint="Vacío = ilimitado"
            />
            <Input
              label="Entrega (min)"
              type="number"
              value={form.deliveryEtaMinutes}
              onChange={(event) => setForm({ ...form, deliveryEtaMinutes: event.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Etiqueta"
              value={form.badge}
              onChange={(event) => setForm({ ...form, badge: event.target.value.toUpperCase() })}
              placeholder="POPULAR"
            />
          </div>

          <ImageUpload
            label="Icono del producto"
            value={form.imageUrl}
            onChange={(imageUrl) => setForm({ ...form, imageUrl })}
            folder="productos"
            hint="Si lo dejas vacío se usa el ícono de la moneda del juego. Para pases y tarjetas conviene poner uno propio."
          />

          <div className="space-y-3 border-t border-base-600 pt-4">
            <Switch
              checked={form.active}
              onChange={(active) => setForm({ ...form, active })}
              label="Activo"
              description="Visible y comprable en la tienda."
            />
            <Switch
              checked={form.featured}
              onChange={(featured) => setForm({ ...form, featured })}
              label="Destacado"
              description="Aparece en 'Los más pedidos' de la portada."
            />
          </div>
        </div>
      </Modal>

      {/* --- Recalcular precios --- */}
      <Modal
        open={repriceOpen}
        onClose={() => {
          setRepriceOpen(false);
          reprice.reset();
        }}
        title="Recalcular precios por margen"
        description="Aplica un margen sobre el costo de cada producto."
        size="md"
      >
        <div className="space-y-4">
          <Input
            label="Margen (%)"
            type="number"
            value={margin}
            onChange={(event) => setMargin(event.target.value)}
            hint={
              gameFilter
                ? `Se aplicará sólo a los productos de ${gameFilter}.`
                : 'Se aplicará a todos los productos.'
            }
          />

          <div className="flex gap-2">
            <Button
              variant="secondary"
              fullWidth
              loading={reprice.isPending}
              onClick={() =>
                reprice.mutate({
                  marginPercent: Number(margin),
                  gameId: gameFilter || undefined,
                  dryRun: true,
                })
              }
            >
              Previsualizar
            </Button>
            <Button
              fullWidth
              loading={reprice.isPending}
              onClick={() =>
                reprice.mutate(
                  { marginPercent: Number(margin), gameId: gameFilter || undefined },
                  {
                    onSuccess: (result) => {
                      toast.success(`${result.updated ?? 0} precio(s) actualizados.`);
                      setRepriceOpen(false);
                    },
                    onError: (error) => toast.error(errorMessage(error)),
                  }
                )
              }
            >
              Aplicar
            </Button>
          </div>

          {reprice.data?.dryRun && (
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-xl bg-base-900 p-3 text-xs">
              {reprice.data.changes.map((change) => (
                <li key={change.id} className="flex justify-between gap-3">
                  <span className="truncate text-slate-300">{change.name ?? change.id}</span>
                  <span className="tabular text-slate-400">
                    {formatUsd(change.from)} → <span className="text-white">{formatUsd(change.to)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={seedOpen}
        onClose={() => setSeedOpen(false)}
        onConfirm={() =>
          seed.mutate(false, {
            onSuccess: (result) => {
              toast.success(
                `${result.productsCreated} creados, ${result.productsUpdated} actualizados.`
              );
              setSeedOpen(false);
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
        title="Sembrar catálogo"
        message="Crea los juegos y productos del documento técnico (Free Fire y Blood Strike) con sus costos y package_id. Los productos existentes se actualizan sin pisar los precios que ya editaste."
        confirmLabel="Sembrar"
        loading={seed.isPending}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          deleteProduct.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success('Producto eliminado.');
              setToDelete(null);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Eliminar producto"
        message={`Se eliminará "${toDelete?.name}" del catálogo. Las órdenes anteriores conservan sus datos.`}
        confirmLabel="Eliminar"
        destructive
        loading={deleteProduct.isPending}
      />
    </div>
  );
}
