/**
 * Pantalla de compra.
 *
 * Todo ocurre aquí sin cambiar de página: eliges juego, escribes tu ID,
 * seleccionas paquete y la barra inferior te lleva al pago. Antes había que
 * navegar juego → producto → checkout, y en cada salto se perdía el contexto
 * (sobre todo el ID, que el cliente tenía que volver a escribir si se
 * arrepentía del paquete).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import {
  AlertTriangle,
  ChevronLeft,
  HelpCircle,
  Loader2,
  Sparkles,
  Tag,
  Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useCatalog, groupProducts } from '@/hooks/useCatalog';
import { usePricePreview } from '@/hooks/useOrders';
import { useSavedPlayerIds } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { GameSelector } from '@/features/catalog/GameSelector';
import { PackageCard } from '@/features/catalog/PackageCard';
import { PurchaseBar } from '@/features/catalog/PurchaseBar';
import {
  PlayerFields,
  cleanValues,
  fieldsAreValid,
  gameFields,
} from '@/features/catalog/PlayerFields';
import { AnimatedBackground } from '@/components/common/Decor';
import { Input, Switch } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { ErrorState, FullPageLoader, EmptyState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import { formatUsd } from '@/lib/format';
import { cn, hexToRgb } from '@/lib/utils';
import type { PricePreview, PublicProduct } from '@/types/models';

type Tab = 'auto' | 'manual';

export function GamePage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { config } = useConfig();

  const catalog = useCatalog();
  const savedIds = useSavedPlayerIds();
  const pricePreview = usePricePreview();

  const [playerValues, setPlayerValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [tab, setTab] = useState<Tab>('auto');
  const [quantity, setQuantity] = useState(1);
  const [couponCode, setCouponCode] = useState('');
  const [showCoupon, setShowCoupon] = useState(false);
  const [useWallet, setUseWallet] = useState(false);
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const games = catalog.data?.games ?? [];
  const game = games.find((item) => item.id === slug) ?? games[0];
  const selectedProductId = searchParams.get('pkg') ?? '';

  const products = useMemo(
    () => (catalog.data?.products ?? []).filter((item) => item.gameId === game?.id),
    [catalog.data, game?.id]
  );

  const { automatic, manual } = groupProducts(products);
  const visible = tab === 'auto' ? automatic : manual;
  const selected = products.find((item) => item.id === selectedProductId) ?? null;

  useDocumentTitle(game ? `Recargar ${game.name}` : 'Recargar');

  const fields = useMemo(() => gameFields(game), [game]);
  const idIsValid = fieldsAreValid(fields, playerValues);
  const primaryField = fields[0];

  const gameSavedIds = (savedIds.data?.playerIds ?? []).filter(
    (saved) => saved.gameId === game?.id
  );

  // Al cambiar de juego se limpia el paquete Y los datos del jugador: ni los
  // `package_id` ni los campos se comparten entre juegos.
  const selectGame = (gameId: string) => {
    if (gameId === game?.id) return;
    setSearchParams({}, { replace: true });
    setQuantity(1);
    setPreview(null);
    setTab('auto');
    setPlayerValues({});
    setTouched(false);
    navigate(ROUTES.game(gameId));
  };

  const selectProduct = (product: PublicProduct) => {
    const next = new URLSearchParams(searchParams);
    if (selectedProductId === product.id) next.delete('pkg');
    else next.set('pkg', product.id);
    setSearchParams(next, { replace: true });
    setQuantity(1);
  };

  // El total real lo calcula el servidor: es el único que conoce el nivel del
  // usuario y puede validar el cupón.
  useEffect(() => {
    if (!user || !selected) {
      setPreview(null);
      return undefined;
    }

    const timeout = setTimeout(() => {
      pricePreview.mutate(
        {
          productId: selected.id,
          quantity,
          couponCode: couponCode.trim() || null,
          useWallet,
          // Sólo cuando el ID está completo: así el cupón se valida contra esa
          // cuenta del juego antes de llegar al pago.
          playerId: idIsValid ? (playerValues[primaryField.key] ?? null) : null,
        },
        { onSuccess: setPreview }
      );
    }, 350);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selected?.id, quantity, couponCode, useWallet, idIsValid, playerValues]);

  if (catalog.isLoading) return <FullPageLoader label="Cargando el catálogo…" />;

  if (catalog.error || !game) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState
          title="No pudimos cargar el catálogo"
          message="Revisa tu conexión e intenta de nuevo."
          action={
            <ButtonLink to={ROUTES.home} variant="secondary">
              Volver al inicio
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const accent = game.accentColor || '#F03030';

  const missingLabel = fields
    .filter((field) => field.required && !(playerValues[field.key] ?? '').trim())
    .map((field) => field.label)
    .join(' y ');

  const continueDisabled = !selected || !idIsValid;
  const disabledReason = !selected
    ? undefined
    : !idIsValid
      ? `Completa ${missingLabel || primaryField.label} para continuar`
      : undefined;

  const startCheckout = () => {
    if (!selected) return;

    // El checkout recibe todo hecho: no vuelve a pedir los datos del jugador.
    navigate(ROUTES.checkout(selected.id), {
      state: {
        playerFields: cleanValues(fields, playerValues),
        quantity,
        couponCode: couponCode.trim() || null,
        useWallet,
      },
    });
  };

  const goToPayment = () => {
    if (!selected || !idIsValid) {
      setTouched(true);
      if (!idIsValid) {
        toast.error(`Necesitamos tu ${missingLabel || primaryField.label} para continuar.`);
        document.getElementById(`compra-${primaryField.key}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
      return;
    }

    // El proveedor de estos juegos acepta cualquier número y cobra igual: un
    // dígito mal escrito se pierde. Por eso se pide confirmar antes de cobrar.
    if (game.validatesPlayerId === false) {
      setConfirmOpen(true);
      return;
    }

    startCheckout();
  };

  return (
    <div className="relative pb-40">
      <AnimatedBackground className="h-[420px]" />

      <div className="relative mx-auto max-w-3xl px-4 pt-4">
        <button
          type="button"
          onClick={() => navigate(ROUTES.home)}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Inicio
        </button>

        {/* Paso 1 — juego */}
        <section className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
              1
            </span>
            Selecciona el juego
          </h2>
          <GameSelector games={games} selectedId={game.id} onSelect={selectGame} />
        </section>

        {/* Paso 2 — ID de jugador */}
        <section className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
              2
            </span>
            {fields.length > 1
              ? `${fields.map((field) => field.label).join(' + ')}`
              : primaryField.label}
          </h2>

          <div
            className="rounded-2xl border p-4 transition-colors"
            style={{
              borderColor: idIsValid ? accent : 'rgb(31 31 48)',
              background: `linear-gradient(180deg, rgba(${hexToRgb(accent)}, 0.06), transparent)`,
            }}
          >
            <PlayerFields
              fields={fields}
              values={playerValues}
              onChange={setPlayerValues}
              showErrors={touched}
              onBlur={() => setTouched(true)}
              idPrefix="compra"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                className="inline-flex items-center gap-1 text-xs text-neon-crimson hover:underline"
              >
                <HelpCircle className="h-3 w-3" aria-hidden />
                ¿Dónde encuentro mis datos?
              </button>

              {gameSavedIds.length > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  {gameSavedIds.slice(0, 3).map((saved) => (
                    <button
                      key={saved.id}
                      type="button"
                      onClick={() => {
                        // Un acceso guardado trae el ID y sus campos extra.
                        setPlayerValues({
                          ...(saved.playerFields ?? {}),
                          [primaryField.key]: saved.playerId,
                        });
                        setTouched(true);
                      }}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        playerValues[primaryField.key] === saved.playerId
                          ? 'border-neon-red bg-neon-red/15 text-white'
                          : 'border-base-600 bg-base-900 text-slate-400 hover:text-white'
                      )}
                    >
                      {saved.label}
                    </button>
                  ))}
                </>
              )}
            </div>

            {game.validatesPlayerId === false && (
              <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  En {game.name} la recarga entra en la cuenta que indiques sin comprobación
                  previa. Revisa bien tus datos: una vez enviada no se puede revertir.
                </span>
              </p>
            )}
          </div>
        </section>

        {/* Paso 3 — paquete */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
                3
              </span>
              Elige tu paquete
            </h2>

            {manual.length > 0 && (
              <div className="inline-flex rounded-xl border border-base-600 bg-base-800 p-1">
                <button
                  type="button"
                  onClick={() => setTab('auto')}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition',
                    tab === 'auto'
                      ? 'bg-brand-gradient text-white shadow-glow'
                      : 'text-slate-400 hover:text-white'
                  )}
                >
                  <Zap className="h-3 w-3" aria-hidden />
                  {game.currencyLabel}
                </button>
                <button
                  type="button"
                  onClick={() => setTab('manual')}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition',
                    tab === 'manual'
                      ? 'bg-brand-gradient text-white shadow-glow'
                      : 'text-slate-400 hover:text-white'
                  )}
                >
                  <Sparkles className="h-3 w-3" aria-hidden />
                  Especiales
                </button>
              </div>
            )}
          </div>

          {tab === 'manual' && (
            <p className="mb-3 rounded-xl border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs text-green-200">
              Estos productos los activa un asesor por WhatsApp. Pagas igual desde la web y al
              verificarse el pago se abre el chat con todos tus datos ya cargados.
            </p>
          )}

          {visible.length === 0 ? (
            <EmptyState
              title="Sin paquetes disponibles"
              description="Estamos actualizando el catálogo de este juego."
            />
          ) : (
            <AnimatePresence mode="popLayout">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((product, index) => (
                  <PackageCard
                    key={product.id}
                    product={product}
                    game={game}
                    index={index}
                    selected={product.id === selectedProductId}
                    onSelect={() => selectProduct(product)}
                  />
                ))}
              </div>
            </AnimatePresence>
          )}
        </section>

        {/* Cupón */}
        {config?.features.couponsEnabled && user && selected && (
          <section className="mt-5">
            {showCoupon ? (
              <div className="rounded-2xl border border-base-600 bg-base-800/70 p-3">
                <Input
                  label="Código de descuento"
                  placeholder="CODIGO"
                  value={couponCode}
                  onChange={(event) =>
                    setCouponCode(event.target.value.toUpperCase().slice(0, 24))
                  }
                  leftIcon={<Tag className="h-4 w-4" aria-hidden />}
                  className="uppercase"
                  error={preview?.couponError ?? null}
                  hint={preview?.couponCode ? `Cupón ${preview.couponCode} aplicado.` : undefined}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCoupon(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-neon-crimson hover:underline"
              >
                <Tag className="h-3.5 w-3.5" aria-hidden />
                ¿Tienes un código de descuento?
              </button>
            )}
          </section>
        )}

        {/* Saldo a favor */}
        {preview && preview.walletEnabled && preview.walletBalanceUsd > 0 && selected && (
          <section className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <Switch
              checked={useWallet}
              onChange={setUseWallet}
              label={`Usar mi saldo a favor (${formatUsd(preview.walletBalanceUsd)})`}
              description={
                useWallet && preview.walletAppliedUsd > 0
                  ? preview.amountDueUsd === 0
                    ? 'Tu saldo cubre la compra completa: no tendrás que transferir nada.'
                    : `Se descontarán ${formatUsd(preview.walletAppliedUsd)} y transferirás el resto.`
                  : 'Descuenta primero de tu saldo y transfiere sólo la diferencia.'
              }
            />
          </section>
        )}

        {preview && preview.tierPercent > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Descuento de nivel {preview.tier}: −{preview.tierPercent}% ya aplicado.
          </p>
        )}

        {pricePreview.isPending && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Actualizando precio…
          </p>
        )}
      </div>

      <PurchaseBar
        product={selected}
        quantity={quantity}
        onQuantityChange={setQuantity}
        totalBs={preview?.totalBs ?? null}
        totalUsd={preview?.totalUsd ?? null}
        discountUsd={preview?.discountUsd ?? 0}
        onContinue={goToPayment}
        loading={false}
        disabled={continueDisabled}
        disabledReason={disabledReason}
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          startCheckout();
        }}
        title="Confirma tus datos"
        message={
          <div className="space-y-3">
            <p>
              {game.name} acredita la recarga en la cuenta que indiques{' '}
              <strong className="text-white">sin verificarla antes</strong>. Si algún dato está
              mal, la recarga se pierde.
            </p>
            <dl className="space-y-1.5 rounded-xl bg-base-900 px-4 py-3">
              {fields.map((field) => (
                <div key={field.key} className="flex items-center justify-between gap-3">
                  <dt className="text-xs text-slate-400">{field.label}</dt>
                  <dd className="tabular text-sm font-semibold text-white">
                    {field.type === 'password' ? '••••••' : (playerValues[field.key] ?? '—')}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        }
        confirmLabel="Están correctos, continuar"
        cancelLabel="Volver a revisar"
      />

      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title={`¿Dónde encuentro mis datos de ${game.name}?`}
        size="sm"
      >
        <ol className="space-y-3">
          {(game.howToFindId.length > 0
            ? game.howToFindId
            : ['Abre el juego.', 'Entra a tu perfil.', 'Copia el ID numérico.']
          ).map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neon-red/20 text-xs font-bold text-neon-crimson">
                {index + 1}
              </span>
              <span className="text-sm text-slate-300">{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-5 rounded-xl bg-base-900 px-4 py-3 text-xs text-slate-400">
          {game.playerIdHelp}
        </p>
      </Modal>
    </div>
  );
}
