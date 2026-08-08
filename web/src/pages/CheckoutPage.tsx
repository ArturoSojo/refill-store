import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useProduct } from '@/hooks/useCatalog';
import {
  useCancelOrder,
  useCreateOrder,
  useLiveOrder,
  useOrder,
  useVerifyPayment,
} from '@/hooks/useOrders';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { CheckoutStepper, type CheckoutStep } from '@/features/checkout/CheckoutStepper';
import { PlayerIdStep } from '@/features/checkout/PlayerIdStep';
import { PaymentStep } from '@/features/checkout/PaymentStep';
import { ResultStep } from '@/features/checkout/ResultStep';
import { OpenOrdersDialog } from '@/features/checkout/OpenOrdersDialog';
import { FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import type { CreateOrderResponse, Order } from '@/types/models';

/** Datos que envía la pantalla de compra al pulsar «Continuar». */
interface CheckoutState {
  playerFields?: Record<string, string>;
  /** Formato anterior: un ID suelto. */
  playerId?: string;
  quantity?: number;
  couponCode?: string | null;
  useWallet?: boolean;
}

export function CheckoutPage() {
  const { productId } = useParams<{ productId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, signInWithGoogle } = useAuth();
  const { config } = useConfig();

  const incoming = (location.state as CheckoutState | null) ?? null;

  /**
   * Orden que se está retomando.
   *
   * Antes «Completar el pago» abría un checkout vacío y volvía a pedir el ID,
   * con el reloj de la orden ya corriendo. Ahora se carga la orden existente y
   * se cae directo en la pantalla de pago, con su cuenta atrás original.
   */
  const resumeOrderId = searchParams.get('orden');
  const resumed = useOrder(resumeOrderId ?? undefined);

  const { product, game, isLoading, notFound } = useProduct(productId);

  const [step, setStep] = useState<CheckoutStep>(resumeOrderId ? 'payment' : 'player');
  const [playerValues, setPlayerValues] = useState<Record<string, string>>(
    incoming?.playerFields ?? (incoming?.playerId ? { playerId: incoming.playerId } : {})
  );
  const [quantity] = useState(incoming?.quantity ?? 1);
  const [couponCode, setCouponCode] = useState(incoming?.couponCode ?? '');
  const [useWallet, setUseWallet] = useState(incoming?.useWallet ?? false);
  const [orderData, setOrderData] = useState<CreateOrderResponse | null>(null);
  const [finalOrder, setFinalOrder] = useState<Order | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [openOrdersVisible, setOpenOrdersVisible] = useState(false);

  const createOrder = useCreateOrder();
  const verifyPayment = useVerifyPayment(orderData?.order.id);
  const cancelOrder = useCancelOrder();

  // Mientras el proveedor despacha, el estado cambia solo: se escucha en vivo.
  const liveOrder = useLiveOrder(finalOrder?.id, finalOrder ?? undefined);

  useDocumentTitle(product ? `Comprar ${product.name}` : 'Comprar');

  const maxAttempts = config?.checkout.maxVerifyAttempts ?? 5;

  const hasPlayerData = useMemo(
    () => Object.values(playerValues).some((value) => value.trim().length > 0),
    [playerValues]
  );

  /**
   * La orden retomada se resuelve una sola vez.
   *
   * El `ref` importa: tras verificar el pago, la caché de la orden se invalida y
   * `resumed` vuelve a traerla, ya como `completed`. Sin esta guarda el efecto
   * se dispararía otra vez y sacaría al cliente de la pantalla de «recarga
   * entregada» justo cuando la está leyendo.
   */
  const resumeHandled = useRef(false);

  useEffect(() => {
    if (resumeHandled.current) return;
    if (!resumeOrderId || !resumed.data?.payment) return;

    resumeHandled.current = true;
    const order = resumed.data.order;

    if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
      // Ya no se puede pagar (se completó, se canceló o caducó): mejor llevarlo
      // al detalle que dejarlo mirando un formulario inútil.
      navigate(ROUTES.order(order.id), { replace: true });
      return;
    }

    setOrderData({ order, payment: resumed.data.payment });
    setAttempts(order.payment.attempts ?? 0);
    setStep('payment');
  }, [resumeOrderId, resumed.data, navigate]);

  const handleCreateOrder = () => {
    if (!game || !product) return;

    createOrder.mutate(
      {
        gameId: game.id,
        productId: product.id,
        playerFields: playerValues,
        quantity,
        couponCode: couponCode.trim() || null,
        useWallet,
      },
      {
        onSuccess: (data) => {
          setOrderData(data);
          setAttempts(0);
          setVerifyError(null);

          /**
           * Se sustituye la entrada del historial por la de «retomar esta
           * orden», sin los datos del jugador.
           *
           * Sin esto se creaba una orden por cada vuelta atrás. `location.state`
           * queda pegado a la entrada del historial, así que al volver con el
           * botón del teléfono el checkout se montaba de nuevo, veía los datos
           * ahí y creaba OTRA orden: quedaban esperando pago hasta caducar. Ya
           * había 6 así, de 5 clientes distintos.
           *
           * Con `?orden=` en la URL, volver a esa entrada retoma la que ya
           * existe —o lleva al detalle si ya se pagó— en vez de crear nada.
           */
          resumeHandled.current = true;
          navigate(`${ROUTES.checkout(product.id)}?orden=${data.order.id}`, {
            replace: true,
            state: null,
          });

          // Pagada íntegra con saldo: no hay nada que transferir, se salta el
          // paso de pago y se muestra el resultado.
          if (data.payment.amountBs <= 0) {
            setFinalOrder(data.order);
            setStep('result');
            toast.success('Pagada con tu saldo a favor.');
            return;
          }

          setStep('payment');
        },
        onError: (error) => {
          // El tope de órdenes abiertas tiene salida propia: se ofrece
          // cancelarlas o pagarlas ahí mismo en vez de dejar un toast opaco.
          if (
            error instanceof ApiError &&
            (error.details as { code?: string } | undefined)?.code === 'too_many_open_orders'
          ) {
            setOpenOrdersVisible(true);
          } else {
            toast.error(errorMessage(error));
          }
          setStep('player');
        },
      }
    );
  };

  /**
   * Cuando se llega desde la pantalla de compra ya está todo elegido, así que
   * la orden se crea sola y el cliente aterriza directo en el pago. El `ref`
   * evita que se dispare dos veces (StrictMode monta los efectos dos veces en
   * desarrollo, y sin guarda se crearían dos órdenes).
   */
  const autoCreated = useRef(false);

  useEffect(() => {
    if (autoCreated.current || resumeOrderId) return;
    if (!hasPlayerData || !user || !product || !game) return;
    if (step !== 'player' || orderData || createOrder.isPending) return;

    autoCreated.current = true;
    handleCreateOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPlayerData, user, product, game, step, orderData, resumeOrderId]);

  // El cargador sólo cuando aún no hay nada que mostrar. Tras crear la orden la
  // URL pasa a llevar `?orden=`, lo que dispara su consulta; sin el
  // `!orderData` esa consulta taparía con un cargador la pantalla de pago que
  // el cliente ya tiene delante.
  if (isLoading || (resumeOrderId && resumed.isLoading && !orderData)) {
    return <FullPageLoader label="Cargando tu orden…" />;
  }

  if (notFound || !product || !game) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState
          title="Producto no disponible"
          message="Este paquete ya no existe o fue desactivado."
          action={
            <ButtonLink to={ROUTES.home} variant="secondary">
              Ver catálogo
            </ButtonLink>
          }
        />
      </div>
    );
  }

  if (config?.features.maintenanceMode) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState
          title="Estamos en mantenimiento"
          message={config.features.maintenanceMessage}
          action={
            <ButtonLink to={ROUTES.home} variant="secondary">
              Volver al inicio
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const handleVerify = (reference: string) => {
    setVerifyError(null);

    verifyPayment.mutate(reference, {
      onSuccess: (result) => {
        setFinalOrder(result.order);
        setStep('result');

        if (result.order.status === 'completed') {
          toast.success('¡Recarga entregada!');
        } else if (result.order.status === 'awaiting_manual') {
          toast.success('Pago verificado. Continúa por WhatsApp.');
        }
      },
      onError: (error) => {
        setAttempts((current) => current + 1);
        const message = errorMessage(error);
        setVerifyError(message);

        // Si el proveedor está caído no es culpa del cliente: se le dice que
        // reintente en vez de dar el pago por perdido.
        if (error instanceof ApiError && error.code === 'provider_error') {
          toast.error('El verificador de pagos no responde. Intenta de nuevo en un minuto.');
        } else {
          toast.error(message);
        }
      },
    });
  };

  const handleCancel = () => {
    if (!orderData) return;

    cancelOrder.mutate(orderData.order.id, {
      onSuccess: () => {
        toast.success('Orden cancelada.');
        navigate(ROUTES.game(game.id));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  // Llegó con todo listo pero sin sesión: al iniciarla, el efecto crea la orden.
  const waitingForAutoOrder = hasPlayerData && Boolean(user) && step === 'player' && !orderData;

  return (
    <div className="mx-auto max-w-lg px-4 pb-10 pt-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          to={`${ROUTES.game(game.id)}?pkg=${product.id}`}
          className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {game.name}
        </Link>
      </div>

      <div className="mb-6">
        <CheckoutStepper current={step} />
      </div>

      {step === 'player' &&
        (waitingForAutoOrder || createOrder.isPending ? (
          <FullPageLoader label="Preparando tu orden…" />
        ) : (
          <PlayerIdStep
            game={game}
            product={product}
            values={playerValues}
            onValuesChange={setPlayerValues}
            couponCode={couponCode}
            onCouponChange={setCouponCode}
            couponsEnabled={config?.features.couponsEnabled ?? false}
            useWallet={useWallet}
            onUseWalletChange={setUseWallet}
            onContinue={handleCreateOrder}
            submitting={createOrder.isPending}
            requiresLogin={!user}
            onLogin={() => {
              void signInWithGoogle().catch((error) => toast.error(errorMessage(error)));
            }}
          />
        ))}

      {step === 'payment' && orderData && (
        <PaymentStep
          data={orderData}
          onVerify={handleVerify}
          verifying={verifyPayment.isPending}
          error={verifyError}
          onCancel={handleCancel}
          cancelling={cancelOrder.isPending}
          attemptsLeft={Math.max(0, maxAttempts - attempts)}
        />
      )}

      {step === 'result' && (liveOrder ?? finalOrder) && (
        <ResultStep
          order={(liveOrder ?? finalOrder)!}
          game={game}
          supportUrl={config?.supportUrl}
        />
      )}

      <OpenOrdersDialog
        open={openOrdersVisible}
        onClose={() => setOpenOrdersVisible(false)}
        onAllClosed={() => {
          setOpenOrdersVisible(false);
          autoCreated.current = false;
          handleCreateOrder();
        }}
      />
    </div>
  );
}
