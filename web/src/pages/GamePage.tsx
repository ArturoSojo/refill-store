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
import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck,
  ChevronLeft,
  Gamepad2,
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
import { AnimatedBackground } from '@/components/common/Decor';
import { Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, FullPageLoader, EmptyState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import { cn, hexToRgb, onlyDigits } from '@/lib/utils';
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

  const [playerId, setPlayerId] = useState('');
  const [touched, setTouched] = useState(false);
  const [tab, setTab] = useState<Tab>('auto');
  const [quantity, setQuantity] = useState(1);
  const [couponCode, setCouponCode] = useState('');
  const [showCoupon, setShowCoupon] = useState(false);
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

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

  const pattern = useMemo(() => {
    try {
      return new RegExp(game?.playerIdPattern ?? '^\\d{8,12}$');
    } catch {
      return /^\d{8,12}$/;
    }
  }, [game?.playerIdPattern]);

  const idIsValid = pattern.test(playerId);
  const showIdError = touched && playerId.length > 0 && !idIsValid;

  const gameSavedIds = (savedIds.data?.playerIds ?? []).filter(
    (saved) => saved.gameId === game?.id
  );

  // Al cambiar de juego se limpia el paquete: los `package_id` no se comparten.
  const selectGame = (gameId: string) => {
    if (gameId === game?.id) return;
    setSearchParams({}, { replace: true });
    setQuantity(1);
    setPreview(null);
    setTab('auto');
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
        { productId: selected.id, quantity, couponCode: couponCode.trim() || null },
        { onSuccess: setPreview }
      );
    }, 350);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selected?.id, quantity, couponCode]);

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

  const continueDisabled = !selected || !idIsValid;
  const disabledReason = !selected
    ? undefined
    : !idIsValid
      ? `Escribe tu ${game.playerIdLabel} para continuar`
      : undefined;

  const goToPayment = () => {
    if (!selected || !idIsValid) {
      setTouched(true);
      if (!idIsValid) {
        toast.error(`Necesitamos tu ${game.playerIdLabel} para continuar.`);
        document.getElementById('player-id-input')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
      return;
    }

    // El checkout recibe todo hecho: no vuelve a pedir el ID.
    navigate(ROUTES.checkout(selected.id), {
      state: { playerId, quantity, couponCode: couponCode.trim() || null },
    });
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
            {game.playerIdLabel}
          </h2>

          <div
            className="rounded-2xl border p-4 transition-colors"
            style={{
              borderColor: idIsValid ? accent : 'rgb(31 31 48)',
              background: `linear-gradient(180deg, rgba(${hexToRgb(accent)}, 0.06), transparent)`,
            }}
          >
            <Input
              id="player-id-input"
              inputMode="numeric"
              autoComplete="off"
              placeholder={`Ej: 3363122817`}
              value={playerId}
              onChange={(event) => setPlayerId(onlyDigits(event.target.value).slice(0, 20))}
              onBlur={() => setTouched(true)}
              leftIcon={<Gamepad2 className="h-4 w-4" aria-hidden />}
              error={showIdError ? game.playerIdHelp : null}
              className="text-lg font-semibold tracking-wide"
              rightSlot={
                idIsValid ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400"
                  >
                    <BadgeCheck className="h-4 w-4" aria-hidden />
                  </motion.span>
                ) : null
              }
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                className="inline-flex items-center gap-1 text-xs text-neon-crimson hover:underline"
              >
                <HelpCircle className="h-3 w-3" aria-hidden />
                ¿Dónde encuentro mi ID?
              </button>

              {gameSavedIds.length > 0 && (
                <>
                  <span className="text-slate-700">·</span>
                  {gameSavedIds.slice(0, 3).map((saved) => (
                    <button
                      key={saved.id}
                      type="button"
                      onClick={() => {
                        setPlayerId(saved.playerId);
                        setTouched(true);
                      }}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        playerId === saved.playerId
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

      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title={`¿Dónde encuentro mi ${game.playerIdLabel}?`}
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
