import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, HelpCircle, Loader2, Tag, Trash2, MessageCircle } from 'lucide-react';
import { ROUTES } from '@/lib/constants';
import { readCreatorCode } from '@/lib/creatorCode';
import { Button } from '@/components/ui/Button';
import { Input, Switch } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Feedback';
import {
  PlayerFields,
  fieldsAreValid,
  gameFields,
} from '@/features/catalog/PlayerFields';
import { useSavedPlayerIds, useDeletePlayerId } from '@/hooks/useAccount';
import { usePricePreview } from '@/hooks/useOrders';
import { useAuth } from '@/providers/AuthProvider';
import { formatBs, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Game, PricePreview, PublicProduct } from '@/types/models';

interface PlayerIdStepProps {
  game: Game;
  product: PublicProduct;
  /** Datos del jugador por clave de campo. */
  values: Record<string, string>;
  onValuesChange: (values: Record<string, string>) => void;
  couponCode: string;
  onCouponChange: (value: string) => void;
  couponsEnabled: boolean;
  /** El producto se entrega a mano y el equipo necesita poder escribirle. */
  needsPhone: boolean;
  contactPhone: string;
  onContactPhoneChange: (value: string) => void;
  /** La transferencia sólo se ofrece si el panel la tiene activa y con cuenta. */
  transferEnabled: boolean;
  paymentMethod: 'pagomovil_bdv' | 'transfer';
  onPaymentMethodChange: (value: 'pagomovil_bdv' | 'transfer') => void;
  useWallet: boolean;
  onUseWalletChange: (value: boolean) => void;
  onContinue: () => void;
  submitting: boolean;
  /** El usuario debe iniciar sesión antes de poder pagar. */
  requiresLogin: boolean;
  onLogin: () => void;
}

export function PlayerIdStep({
  game,
  product,
  values,
  onValuesChange,
  couponCode,
  onCouponChange,
  couponsEnabled,
  needsPhone,
  contactPhone,
  onContactPhoneChange,
  transferEnabled,
  paymentMethod,
  onPaymentMethodChange,
  useWallet,
  onUseWalletChange,
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

  const fields = useMemo(() => gameFields(game), [game]);
  const primaryField = fields[0];

  const gameSavedIds = (savedIds.data?.playerIds ?? []).filter(
    (saved) => saved.gameId === game.id
  );

  const isValid = fieldsAreValid(fields, values);

  // El precio final depende del nivel del usuario, del cupón y del saldo: se
  // recalcula en el servidor para que lo que se muestra sea lo que se cobrará.
  useEffect(() => {
    if (!user) {
      setPreview(null);
      return undefined;
    }

    const timeout = setTimeout(() => {
      pricePreview.mutate(
        {
          productId: product.id,
          couponCode: couponCode.trim() || null,
          creatorCode: readCreatorCode() || null,
          useWallet,
          // Sólo con los datos completos: valida el cupón contra esa cuenta del
          // juego antes de crear la orden.
          playerId: isValid ? (values[primaryField.key] ?? null) : null,
        },
        { onSuccess: setPreview }
      );
    }, 400);

    return () => clearTimeout(timeout);
    // `pricePreview` es una mutación estable de React Query; incluirla dispararía
    // el efecto en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, product.id, couponCode, useWallet, isValid, values]);

  const totalBs = preview?.totalBs ?? product.priceBs;
  const totalUsd = preview?.amountDueUsd ?? preview?.totalUsd ?? product.priceUsd;
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
            {product.fulfillment === 'auto'
              ? 'Automático'
              : product.manualFlow === 'whatsapp'
                ? 'Por WhatsApp'
                : 'Lo activa el equipo'}
          </Badge>
        </div>

        <PlayerFields
          fields={fields}
          values={values}
          onChange={onValuesChange}
          showErrors={touched}
          onBlur={() => setTouched(true)}
          idPrefix="checkout"
        />

        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-neon-crimson hover:underline"
        >
          <HelpCircle className="h-3 w-3" aria-hidden />
          ¿Dónde encuentro mis datos?
        </button>

        {game.validatesPlayerId === false && (
          <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              La recarga entra en la cuenta que indiques sin comprobación previa. Revisa bien
              los datos antes de pagar.
            </span>
          </p>
        )}

        {gameSavedIds.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-400">Tus accesos guardados</p>
            <div className="flex flex-wrap gap-2">
              {gameSavedIds.map((saved) => (
                <span
                  key={saved.id}
                  className={cn(
                    'group inline-flex items-center gap-1 rounded-full border px-1 py-1 pl-3 text-xs transition',
                    values[primaryField.key] === saved.playerId
                      ? 'border-neon-red bg-neon-red/15 text-white'
                      : 'border-base-600 bg-base-900 text-slate-300 hover:border-base-500'
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      onValuesChange({
                        ...(saved.playerFields ?? {}),
                        [primaryField.key]: saved.playerId,
                      })
                    }
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

      {/* Elegir cómo pagar antes de crear la orden: los datos que se muestran
          después quedan congelados en ella, así que cambiar de idea más tarde
          obligaría a crear otra. */}
      {transferEnabled && (
        <div className="card">
          <p className="text-sm font-semibold text-white">¿Cómo vas a pagar?</p>
          <p className="mt-0.5 text-xs text-slate-400">
            Las dos se verifican solas con la referencia. Elige la que te quede cómoda.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {(
              [
                { id: 'pagomovil_bdv', label: 'Pago Móvil', hint: 'Al teléfono' },
                { id: 'transfer', label: 'Transferencia', hint: 'A la cuenta' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onPaymentMethodChange(option.id)}
                aria-pressed={paymentMethod === option.id}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left transition',
                  paymentMethod === option.id
                    ? 'border-neon-red bg-neon-red/10'
                    : 'border-base-600 bg-base-900 hover:border-base-500'
                )}
              >
                <span className="block text-sm font-semibold text-white">{option.label}</span>
                <span className="block text-xs text-slate-400">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {needsPhone && (
        <div className="card border-amber-500/30 bg-amber-500/5">
          <Input
            id="contacto-telefono"
            label="Tu número de WhatsApp"
            type="tel"
            inputMode="tel"
            placeholder="0412-0000000"
            value={contactPhone}
            onChange={(event) => onContactPhoneChange(event.target.value.slice(0, 20))}
            leftIcon={<MessageCircle className="h-4 w-4" aria-hidden />}
            hint="Este producto lo activa nuestro equipo a mano. Te escribimos nosotros: no tienes que hacer nada más."
          />
        </div>
      )}

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

      {preview && preview.walletEnabled && preview.walletBalanceUsd > 0 && (
        <div className="card border-emerald-500/30 bg-emerald-500/5">
          <Switch
            checked={useWallet}
            onChange={onUseWalletChange}
            label={`Usar mi saldo a favor (${formatUsd(preview.walletBalanceUsd)})`}
            description={
              useWallet && preview.walletAppliedUsd > 0
                ? preview.amountDueUsd === 0
                  ? 'Tu saldo cubre la compra completa: no tendrás que transferir nada.'
                  : `Se descontarán ${formatUsd(preview.walletAppliedUsd)} y transferirás el resto.`
                : 'Descuenta primero de tu saldo y transfiere sólo la diferencia.'
            }
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

          {preview && preview.walletAppliedUsd > 0 && (
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Saldo a favor</dt>
              <dd className="tabular text-emerald-400">
                −{formatUsd(preview.walletAppliedUsd)}
              </dd>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-base-600 pt-3">
            <dt className="font-semibold text-white">
              {preview?.amountDueUsd === 0 ? 'A transferir' : 'Total a pagar'}
            </dt>
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
          {preview?.amountDueUsd === 0 ? 'Pagar con mi saldo' : 'Continuar al pago'}
        </Button>
      )}

      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title={`¿Dónde encuentro mis datos de ${game.name}?`}
        size="sm"
      >
        <ol className="space-y-3">
          {(game.howToFindId?.length > 0
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

        <dl className="mt-5 space-y-2 rounded-xl bg-base-900 px-4 py-3 text-xs">
          {fields.map((field) => (
            <div key={field.key}>
              <dt className="font-semibold text-slate-300">{field.label}</dt>
              <dd className="text-slate-400">{field.help}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}
