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
  AlertTriangle,
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  HelpCircle,
  Loader2,
  Sparkles,
  Tag,
  TrendingUp,
  Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api, isFazerCardsStorefront, ApiError } from '@/lib/api';
import { useCatalog, useFamilyCatalog, useGameCatalog } from '@/hooks/useCatalog';
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
import { resolveFazerValidationCategory } from '@/features/catalog/validation';
import { stepIndex, useRechargeTour } from '@/features/tour/useRechargeTour';
import { AnimatedBackground } from '@/components/common/Decor';
import { Input } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { ErrorState, FullPageLoader, EmptyState } from '@/components/ui/Feedback';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import { readCreatorCode } from '@/lib/creatorCode';
import { cn, hexToRgb } from '@/lib/utils';
import type { PricePreview, PublicProduct } from '@/types/models';

type Tab = 'auto' | 'manual' | 'level_up';

/**
 * Determina si un producto es un pase único de temporada o una subida de nivel
 * no repetible (se limitan a 1 unidad por cuenta/temporada en la UI).
 * Los paquetes de moneda (diamantes, oro) y las tarjetas semanales/mensuales
 * permiten elegir hasta 10 unidades.
 */
function isNonRepeatablePass(product: { id: string; name?: string; kind?: string } | null | undefined): boolean {
  if (!product) return false;
  if (product.kind === 'level_up' || (product.kind as string) === 'pass') {
    return true;
  }

  const id = product.id.toLowerCase();
  const name = (product.name || '').toLowerCase();

  // Las tarjetas semanales y mensuales son acumulables (extienden días de suscripción)
  if (name.includes('tarjeta') || id.includes('tarjeta')) {
    return false;
  }
  if (name.includes('semanal') || id.includes('semanal') || name.includes('mensual') || id.includes('mensual')) {
    return false;
  }

  // Pases únicos por temporada (Pase Booyah, Pase Elite, Pase Premium, Battle Pass, etc.)
  if (id.includes('booyah') || name.includes('booyah')) {
    return true;
  }
  if (id.includes('pase') || name.includes('pase')) {
    return true;
  }
  if (id.includes('battle-pass') || name.includes('battle pass') || id.includes('battle_pass')) {
    return true;
  }

  return false;
}

export function GamePage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { config } = useConfig();
  const { start: startTour, notify: notifyTour } = useRechargeTour();

  const catalog = useGameCatalog(slug);
  const storefrontCatalog = useCatalog();
  const [carouselStarted, setCarouselStarted] = useState(false);
  const family = catalog.data?.game?.providerFamily ?? 'topup';
  const familyCatalog = useFamilyCatalog(catalog.data?.game ? family : undefined, 12, carouselStarted);
  const savedIds = useSavedPlayerIds();
  const pricePreview = usePricePreview();

  const [playerValues, setPlayerValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [tab, setTab] = useState<Tab>('auto');
  const [quantity, setQuantity] = useState(1);
  const [couponCode, setCouponCode] = useState('');
  // Precargado desde el enlace del creador: sin esto nadie lo escribiría.
  const [creatorCode, setCreatorCode] = useState(() => readCreatorCode());
  const [codesOpen, setCodesOpen] = useState(false);
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [playerValidation, setPlayerValidation] = useState<{
    values: Record<string, string>;
    playerName: string | null;
    region: string | null;
  } | null>(null);
  const [validatingPlayer, setValidatingPlayer] = useState(false);

  const game = catalog.data?.game;
  const games = useMemo(() => {
    if (!game) return [];
    const family = game.providerFamily ?? 'topup';
    const candidates = [...(storefrontCatalog.data?.games ?? []), ...(familyCatalog.data?.games ?? [])].filter(
      (item) => (item.providerFamily ?? 'topup') === family
    );
    // La portada entrega una muestra pequeña y priorizada por familia. Añade
    // siempre el juego actual si no está en esa muestra (p. ej. una categoría
    // profunda), sin descargar todo el catálogo sólo para el selector.
    const unique = new Map(candidates.map((item) => [item.id, item]));
    unique.set(game.id, game);
    return [...unique.values()];
  }, [game, storefrontCatalog.data?.games, familyCatalog.data?.games]);

  const loadMoreGames = () => {
    if (!carouselStarted) {
      setCarouselStarted(true);
    } else if (familyCatalog.error) {
      void familyCatalog.refetch();
    } else if (familyCatalog.hasMore && !familyCatalog.isFetching) {
      familyCatalog.loadMore();
    }
  };
  const selectedProductId = searchParams.get('pkg') ?? '';

  const products = useMemo(
    () => catalog.data?.products ?? [],
    [catalog.data]
  );

  const levelUp = useMemo(
    () => products.filter((p) => p.kind === 'level_up'),
    [products]
  );
  const specials = useMemo(
    () =>
      products.filter(
        (p) => p.kind === 'special' || p.fulfillment === 'manual'
      ),
    [products]
  );
  const currencyProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.kind !== 'level_up' &&
          p.kind !== 'special' &&
          p.fulfillment === 'auto'
      ),
    [products]
  );
  const visible =
    tab === 'level_up'
      ? levelUp
      : tab === 'manual'
        ? specials
        : currencyProducts.length > 0
          ? currencyProducts
          : products;
  const selected = products.find((item) => item.id === selectedProductId) ?? null;
  // Misma regla que `catalog.maxOrderQuantity` en el servidor: las recargas
  // del catálogo de Central One (juegos `co-*` y extras que la sincronización
  // cuelga de Free Fire) se compran de a una; las gift cards pueden ir varias y
  // los productos de Central One sembrados en juegos de Inefable conservan su
  // tope de siempre.
  // Misma regla que catalog.maxOrderQuantity en el servidor:
  // Los pases de temporada (ej. Pase Booyah) y las subidas de nivel se limitan
  // a 1 unidad por cuenta (el juego rechaza compras repetidas con not_eligible).
  // Los paquetes regulares de moneda/diamantes y tarjetas semanales/mensuales
  // admiten múltiples unidades (ej: escoger 2 unidades de 110💎 para recargar 220💎).
  const maxQuantity = isNonRepeatablePass(selected) ? 1 : undefined;

  useEffect(() => {
    if (maxQuantity !== undefined && quantity > maxQuantity) {
      setQuantity(maxQuantity);
    }
  }, [maxQuantity, quantity]);

  useDocumentTitle(game ? `Recargar ${game.name}` : 'Recargar');

  const fields = useMemo(() => gameFields(game), [game]);
  const requiresPlayerData = game?.requiresPlayerData !== false;
  const idIsValid = !requiresPlayerData || fieldsAreValid(fields, playerValues);
  const primaryField = fields[0];
  const validationCategory = useMemo(() => resolveFazerValidationCategory(game), [game]);
  // Los juegos de Central One dicen por sí mismos si el proveedor valida el ID
  // (`validatesPlayerId` sale de su cobertura en cada sincronización); el resto
  // sigue con la tabla por nombre de siempre.
  const requiresFazerValidation =
    game?.provider === 'centralone'
      ? game.requiresPlayerData !== false && game.validatesPlayerId === true
      : Boolean(validationCategory && isFazerCardsStorefront());
  const validationName = validationCategory?.name || game?.name || 'jugador';
  const playerIdVerified = Boolean(
    requiresFazerValidation &&
      playerValidation &&
      fields.every((field) => (playerValues[field.key] ?? '').trim() === (playerValidation.values[field.key] ?? ''))
  );

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
    setPlayerValidation(null);
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
          creatorCode: creatorCode.trim() || null,
          // Sólo cuando el ID está completo: así el cupón se valida contra esa
          // cuenta del juego antes de llegar al pago.
          playerId: idIsValid && primaryField ? (playerValues[primaryField.key] ?? null) : null,
        },
        { onSuccess: setPreview }
      );
    }, 350);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selected?.id, quantity, couponCode, creatorCode, idIsValid, playerValues]);

  // La guía interactiva avanza sola tras 800ms cuando el cliente verifica su ID.
  useEffect(() => {
    if (!playerIdVerified) return undefined;
    const timer = window.setTimeout(() => {
      notifyTour('id-verified');
    }, 800);
    return () => window.clearTimeout(timer);
  }, [playerIdVerified, notifyTour]);

  useEffect(() => {
    if (selected?.id) notifyTour('package-selected');
  }, [selected?.id, notifyTour]);

  if (catalog.isLoading || storefrontCatalog.isLoading) return <FullPageLoader label="Cargando el catálogo…" />;

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

  const continueDisabled = !selected || !idIsValid || (requiresFazerValidation && !playerIdVerified);
  const disabledReason = !selected
    ? undefined
    : !idIsValid
      ? `Completa ${missingLabel || primaryField?.label || 'los datos solicitados'} para continuar`
      : requiresFazerValidation && !playerIdVerified
        ? `Verifica tu ID de ${validationName} para continuar`
      : undefined;

  const startCheckout = () => {
    if (!selected) return;

    notifyTour('checkout-started');

    // El checkout recibe todo hecho: no vuelve a pedir los datos del jugador.
    navigate(ROUTES.checkout(selected.id), {
      state: {
        playerFields: cleanValues(fields, playerValues),
        playerIdVerified: requiresFazerValidation && playerIdVerified,
        playerNickname: playerValidation?.playerName || null,
        quantity,
        couponCode: couponCode.trim() || null,
        creatorCode: creatorCode.trim() || null,
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
    if (requiresPlayerData && game.validatesPlayerId === false && !requiresFazerValidation) {
      setConfirmOpen(true);
      return;
    }

    startCheckout();
  };

  const verifyPlayerId = async () => {
    if (!idIsValid || validatingPlayer || !game || !requiresFazerValidation) {
      setTouched(true);
      return;
    }
    setValidatingPlayer(true);
    setPlayerValidation(null);
    try {
      const payload = {
        playerId: primaryField ? (playerValues[primaryField.key] ?? '').trim() : '',
        zoneId: fields[1] ? (playerValues[fields[1].key] ?? '').trim() : undefined,
        fields: cleanValues(fields, playerValues),
        // Central One valida contra un producto concreto: el paquete elegido es
        // el más fiel; sin él, el backend usa el primero activo del juego.
        productId: selected?.id,
      };
      const result = await api.post<{
        valid: boolean;
        playerName: string | null;
        region: string | null;
        status?: 'valid' | 'invalid' | 'unverified';
        message?: string;
      }>(`/games/${encodeURIComponent(game.id)}/validate-player`, payload);

      if (!result.valid) {
        toast.error(
          result.message ||
            `No pudimos confirmar este ID de ${validationName}. Por favor revisa los datos antes de continuar.`
        );
        return;
      }
      setPlayerValidation({
        values: { ...playerValues },
        playerName: result.playerName,
        region: result.region,
      });
      if (result.status === 'unverified') {
        toast(result.message || 'No fue posible verificar el apodo en este momento, pero puedes continuar.', {
          icon: 'ℹ️',
        });
      } else {
        toast.success(
          result.playerName
            ? `Jugador verificado: ${result.playerName}`
            : `ID de ${validationName} verificado.`
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 422) {
          toast.error(`ID no confirmado en ${validationName}. Por favor revisa los datos con el comprador.`);
          return;
        }
        if (error.status === 400) {
          toast.error(error.message || 'Esta categoría no soporta validación de ID.');
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : 'No se pudo verificar el ID. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setValidatingPlayer(false);
    }
  };

  return (
    <div className="relative pb-40">
      <AnimatedBackground className="h-[420px]" />

      <div className="relative mx-auto max-w-3xl px-4 pt-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => navigate(ROUTES.home)}
            className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Inicio
          </button>

          <button
            type="button"
            onClick={() => startTour(stepIndex('game-select'))}
            className="inline-flex items-center gap-1.5 rounded-full border border-neon-red/30 bg-neon-red/10 px-3.5 py-1.5 text-xs font-bold text-neon-crimson transition hover:bg-neon-red/20"
          >
            <span aria-hidden>🎓</span>
            ¿Primera vez? Enséñame a comprar paso a paso
          </button>
        </div>

        {/* Paso 1 — juego */}
        <section className="mx-1 mb-6" data-tour="game-selector">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
              1
            </span>
            Selecciona el juego
          </h2>
          <GameSelector games={games} selectedId={game.id} onSelect={selectGame}
            onEnd={loadMoreGames}
            hasMore={!carouselStarted || familyCatalog.hasMore || Boolean(familyCatalog.error)}
            isLoadingMore={carouselStarted && familyCatalog.isFetching} />
        </section>

        {/* Paso 2 — datos de la cuenta. Las gift cards y keys no los piden. */}
        {requiresPlayerData && primaryField && <section className="mb-6">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
              2
            </span>
            {fields.length > 1
              ? `${fields.map((field) => field.label).join(' + ')}`
              : primaryField.label}
          </h2>

          <div
            data-tour="player-id-input"
            data-tour-game={game.name}
            data-tour-id-valid={idIsValid ? 'true' : 'false'}
            data-tour-verifying={validatingPlayer ? 'true' : 'false'}
            data-tour-verified={playerIdVerified ? 'true' : 'false'}
            data-tour-nickname={playerValidation?.playerName ?? ''}
            className="mx-1 rounded-2xl border p-4 transition-colors"
            style={{
              borderColor: idIsValid ? accent : 'rgb(31 31 48)',
              background: `linear-gradient(180deg, rgba(${hexToRgb(accent)}, 0.06), transparent)`,
            }}
          >
            <PlayerFields
              fields={fields}
              values={playerValues}
              onChange={(next) => {
                setPlayerValues(next);
                if (playerValidation) {
                  const hasChanged = fields.some(
                    (field) => (next[field.key] ?? '').trim() !== (playerValidation.values[field.key] ?? '')
                  );
                  if (hasChanged) setPlayerValidation(null);
                }
              }}
              showErrors={touched}
              onBlur={() => setTouched(true)}
              idPrefix="compra"
            />

            {requiresFazerValidation && (
              <div className="mt-3 space-y-2">
                <div data-tour="verify-id-button" className="w-fit">
                <Button
                  variant={playerIdVerified ? 'success' : 'secondary'}
                  size="sm"
                  type="button"
                  onClick={verifyPlayerId}
                  disabled={!idIsValid || validatingPlayer}
                >
                  {validatingPlayer ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />}
                  {validatingPlayer ? 'Verificando ID…' : playerIdVerified ? 'ID verificado' : 'Verificar ID'}
                </Button>
                </div>
                {playerIdVerified && (
                  <p
                    className={cn(
                      'flex items-center gap-1.5 text-xs',
                      playerValidation?.playerName ? 'text-emerald-300' : 'text-amber-300'
                    )}
                    role="status"
                    data-tour="verified-player-badge"
                  >
                    <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden />
                    {playerValidation?.playerName ? (
                      <>
                        Cuenta verificada: <span className="font-semibold text-emerald-200">{playerValidation.playerName}</span>
                        {playerValidation?.region ? ` · ${playerValidation.region}` : ''}
                      </>
                    ) : (
                      'Cuenta lista para recargar'
                    )}
                  </p>
                )}
              </div>
            )}

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

            {game.validatesPlayerId === false && !requiresFazerValidation && (
              <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  En {game.name} la recarga entra en la cuenta que indiques sin comprobación
                  previa. Revisa bien tus datos: una vez enviada no se puede revertir.
                </span>
              </p>
            )}
          </div>
        </section>}

        {/* Códigos se movieron debajo de los paquetes */}

        {/* Paso 3 — paquete */}
        <section className="mx-1" data-tour="package-grid">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
                3
              </span>
              Elige tu paquete
            </h2>

            {(specials.length > 0 || levelUp.length > 0) && (
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
                {levelUp.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTab('level_up')}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition',
                      tab === 'level_up'
                        ? 'bg-brand-gradient text-white shadow-glow'
                        : 'text-slate-400 hover:text-white'
                    )}
                  >
                    <TrendingUp className="h-3 w-3" aria-hidden />
                    Subida de nivel
                  </button>
                )}
                {specials.length > 0 && (
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
                )}
              </div>
            )}
          </div>

          {tab === 'level_up' && (
            <p className="mb-3 rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
              Subida de nivel oficial para Free Fire. Se carga de forma directa e instantánea en tu cuenta con tu ID.
            </p>
          )}

          {tab === 'manual' && (
            <p className="mb-3 rounded-xl border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs text-green-200">
              {specials.every((p) => p.fulfillment === 'auto')
                ? 'Pases y ofertas especiales oficiales. Se acreditan de forma automática a tu cuenta.'
                : specials.some((p) => p.fulfillment === 'auto')
                  ? 'Pases y ofertas especiales. Las recargas instantáneas entran directo a tu ID y las manuales las activa un asesor por WhatsApp.'
                  : 'Estos productos los activa un asesor por WhatsApp. Pagas igual desde la web y al verificarse el pago se abre el chat con todos tus datos ya cargados.'}
            </p>
          )}

          {/* CÓDIGOS DE DESCUENTO (Alineado a la izquierda, ancho completo) */}
          {config?.features.couponsEnabled && (
            <div className="mb-5 flex flex-col items-start w-full">
              <button
                type="button"
                onClick={() => setCodesOpen(!codesOpen)}
                className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-white"
              >
                ¿Tienes un código de descuento?
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", codesOpen && "rotate-180")}
                  aria-hidden
                />
              </button>
              {(!codesOpen && (couponCode || creatorCode)) && (
                <p className="mt-1 text-xs text-emerald-400">
                  {[couponCode, creatorCode].filter(Boolean).join(' · ')} aplicado
                </p>
              )}

              <AnimatePresence>
                {codesOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="w-full overflow-hidden"
                  >
                    <div className="mt-4 w-full rounded-2xl border border-base-600 bg-base-900/50 p-4">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                          label="Código de descuento"
                          placeholder="Ingresa tu cupón"
                          value={couponCode}
                          onChange={(event) => setCouponCode(event.target.value.toUpperCase().slice(0, 24))}
                          leftIcon={<Tag className="h-4 w-4" aria-hidden />}
                          className="uppercase"
                          error={preview?.couponError ?? null}
                          rightSlot={
                            <Button
                              type="button"
                              size="sm"
                              variant={preview?.couponCode && preview.couponCode === couponCode ? 'success' : 'secondary'}
                              className="h-7 px-3 text-[11px]"
                              disabled={pricePreview.isPending || !couponCode}
                            >
                              {pricePreview.isPending ? 'Verificando...' : (preview?.couponCode && preview.couponCode === couponCode) ? 'Aplicado' : 'Aplicar'}
                            </Button>
                          }
                          hint={
                            preview?.couponCode
                              ? <span className="text-emerald-400">Cupón {preview.couponCode} aplicado exitosamente.</span>
                              : !user
                                ? 'Se aplicará al iniciar sesión para pagar.'
                                : 'Escríbelo para aplicarlo al total.'
                          }
                        />

                        {config?.features.creatorsEnabled && (
                          <Input
                            label="Código de creador (opcional)"
                            placeholder="Apoya a un creador"
                            value={creatorCode}
                            onChange={(event) => setCreatorCode(event.target.value.toUpperCase().slice(0, 24))}
                            leftIcon={<Sparkles className="h-4 w-4" aria-hidden />}
                            className="uppercase"
                            error={preview?.creatorError ?? null}
                            rightSlot={
                              <Button
                                type="button"
                                size="sm"
                                variant={preview?.creatorCode && preview.creatorCode === creatorCode ? 'success' : 'secondary'}
                                className="h-7 px-3 text-[11px]"
                                disabled={pricePreview.isPending || !creatorCode}
                              >
                                {pricePreview.isPending ? 'Verificando...' : (preview?.creatorCode && preview.creatorCode === creatorCode) ? 'Aplicado' : 'Aplicar'}
                              </Button>
                            }
                            hint={
                              preview?.creatorCode
                                ? <span className="text-emerald-400">Apoyando a {preview.creatorCode}.</span>
                                : 'Si viste la tienda en un vídeo, ingresa el código aquí.'
                            }
                          />
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
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
        maxQuantity={maxQuantity}
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
