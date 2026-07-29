import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Gamepad2, HelpCircle, Loader2, Tag, Trash2 } from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Feedback';
import { useSavedPlayerIds, useDeletePlayerId } from '@/hooks/useAccount';
import { usePricePreview } from '@/hooks/useOrders';
import { useAuth } from '@/providers/AuthProvider';
import { formatBs, formatUsd } from '@/lib/format';
import { cn, onlyDigits } from '@/lib/utils';
import type { Game, PricePreview, PublicProduct } from '@/types/models';

interface PlayerIdStepProps {
  game: Game;
  product: PublicProduct;
  playerId: string;
  onPlayerIdChange: (value: string) => void;
  couponCode: string;
  onCouponChange: (value: string) => void;
  couponsEnabled: boolean;
  onContinue: () => void;
  submitting: boolean;
  /** El usuario debe iniciar sesión antes de poder pagar. */
  requiresLogin: boolean;
  onLogin: () => void;
}

export function PlayerIdStep({
  game,
  product,
  playerId,
  onPlayerIdChange,
  couponCode,
  onCouponChange,
  couponsEnabled,
  onContinue,
  submitting,
  requiresLogin,
  onLogin,
}: PlayerIdStepProps) {
  const { user } = useAuth();
  const [touched, setTouched] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [preview, setPreview] = useState<PricePreview | null>(null);

  const savedIds = useSavedPlayerIds();
  const deletePlayerId = useDeletePlayerId();
  const pricePreview = usePricePreview();

  const gameSavedIds = (savedIds.data?.playerIds ?? []).filter(
    (saved) => saved.gameId === game.id
  );

  const pattern = useMemo(() => {
    try {
      return new RegExp(game.playerIdPattern);
    } catch {
      return /^\d{8,12}$/;
    }
  }, [game.playerIdPattern]);

  const isValid = pattern.test(playerId);
  const showError = touched && playerId.length > 0 && !isValid;

  // El precio final depende del nivel del usuario y del cupón: se recalcula en
  // el servidor para que lo que se muestra sea exactamente lo que se cobrará.
  useEffect(() => {
    if (!user) {
      setPreview(null);
      return undefined;
    }

    const timeout = setTimeout(() => {
      pricePreview.mutate(
        { productId: product.id, couponCode: couponCode.trim() || null },
        { onSuccess: setPreview }
      );
    }, 400);

    return () => clearTimeout(timeout);
    // `pricePreview` es una mutación estable de React Query; incluirla dispararía
    // el efecto en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, product.id, couponCode]);

  const totalBs = preview?.totalBs ?? product.priceBs;
  const totalUsd = preview?.totalUsd ?? product.priceUsd;
  const discount = preview?.discountUsd ?? 0;

  return (
    <div className="space-y-5">
      <div className="card">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Vas a comprar
            </p>
            <h2 className="mt-1 text-lg font-bold text-white">{product.name}</h2>
            <p className="mt-0.5 text-sm text-slate-400">{game.name}</p>
          </div>
          <Badge variant={product.fulfillment === 'auto' ? 'brand' : 'success'}>
            {product.fulfillment === 'auto' ? 'Automático' : 'Por WhatsApp'}
          </Badge>
        </div>

        <Input
          label={game.playerIdLabel}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Ej: 3363122817"
          value={playerId}
          onChange={(event) => onPlayerIdChange(onlyDigits(event.target.value).slice(0, 20))}
          onBlur={() => setTouched(true)}
          leftIcon={<Gamepad2 className="h-4 w-4" aria-hidden />}
          error={showError ? game.playerIdHelp : null}
          hint={
            !showError ? (
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                className="inline-flex items-center gap-1 text-neon-crimson hover:underline"
              >
                <HelpCircle className="h-3 w-3" aria-hidden />
                ¿Dónde encuentro mi ID?
              </button>
            ) : null
          }
          rightSlot={
            isValid ? (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                <BadgeCheck className="h-4 w-4" aria-hidden />
              </span>
            ) : null
          }
        />

        {gameSavedIds.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-400">Tus IDs guardados</p>
            <div className="flex flex-wrap gap-2">
              {gameSavedIds.map((saved) => (
                <span
                  key={saved.id}
                  className={cn(
                    'group inline-flex items-center gap-1 rounded-full border px-1 py-1 pl-3 text-xs transition',
                    playerId === saved.playerId
                      ? 'border-neon-red bg-neon-red/15 text-white'
                      : 'border-base-600 bg-base-900 text-slate-300 hover:border-base-500'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onPlayerIdChange(saved.playerId)}
                    className="font-medium"
                  >
                    {saved.label}
                    <span className="ml-1.5 tabular text-slate-500">{saved.playerId}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePlayerId.mutate(saved.id)}
                    aria-label={`Eliminar ${saved.label}`}
                    className="ml-0.5 rounded-full p-1 text-slate-500 opacity-0 transition hover:bg-base-700 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {couponsEnabled && user && (
        <div className="card">
          <Input
            label="¿Tienes un cupón?"
            placeholder="CODIGO"
            value={couponCode}
            onChange={(event) => onCouponChange(event.target.value.toUpperCase().slice(0, 24))}
            leftIcon={<Tag className="h-4 w-4" aria-hidden />}
            error={preview?.couponError ?? null}
            hint={
              preview?.couponCode
                ? `Cupón ${preview.couponCode} aplicado.`
                : 'Opcional. Se valida al escribirlo.'
            }
            className="uppercase"
          />
        </div>
      )}

      <div className="card">
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-slate-400">Subtotal</dt>
            <dd className="tabular text-slate-200">
              {formatUsd(preview?.subtotalUsd ?? product.priceUsd)}
            </dd>
          </div>

          {discount > 0 && (
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">
                Descuento
                {preview && preview.tierPercent > 0 && (
                  <span className="ml-1.5 text-xs text-neon-crimson">
                    (nivel {preview.tier} −{preview.tierPercent}%)
                  </span>
                )}
              </dt>
              <dd className="tabular text-emerald-400">−{formatUsd(discount)}</dd>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-base-600 pt-3">
            <dt className="font-semibold text-white">Total a pagar</dt>
            <dd className="text-right">
              <span className="block text-xl font-extrabold tabular text-white">
                {formatBs(totalBs)}
              </span>
              <span className="block text-xs tabular text-slate-400">{formatUsd(totalUsd)}</span>
            </dd>
          </div>
        </dl>

        {pricePreview.isPending && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Actualizando precio…
          </p>
        )}
      </div>

      {requiresLogin ? (
        <div className="card border-neon-red/30 bg-neon-red/5 text-center">
          <p className="text-sm text-slate-300">
            Para completar el pago necesitas iniciar sesión. Así guardamos tu orden, tu historial y
            tus IDs de jugador.
          </p>
          <Button className="mt-4" fullWidth size="lg" onClick={onLogin}>
            Continuar con Google
          </Button>
          <Link
            to={ROUTES.login}
            state={{ from: `${window.location.pathname}${window.location.search}` }}
            className="mt-3 inline-block text-xs font-semibold text-neon-crimson hover:underline"
          >
            o entra con correo y contraseña
          </Link>
        </div>
      ) : (
        <Button
          size="lg"
          fullWidth
          disabled={!isValid}
          loading={submitting}
          onClick={() => {
            setTouched(true);
            if (isValid) onContinue();
          }}
        >
          Continuar al pago
        </Button>
      )}

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
      </Modal>
    </div>
  );
}
