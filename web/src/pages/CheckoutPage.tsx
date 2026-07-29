import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useProduct } from '@/hooks/useCatalog';
import { useCancelOrder, useCreateOrder, useLiveOrder, useVerifyPayment } from '@/hooks/useOrders';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { CheckoutStepper, type CheckoutStep } from '@/features/checkout/CheckoutStepper';
import { PlayerIdStep } from '@/features/checkout/PlayerIdStep';
import { PaymentStep } from '@/features/checkout/PaymentStep';
import { ResultStep } from '@/features/checkout/ResultStep';
import { FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import type { CreateOrderResponse, Order } from '@/types/models';

/** Datos que envía la pantalla de compra al pulsar «Continuar». */
interface CheckoutState {
  playerId?: string;
  quantity?: number;
  couponCode?: string | null;
}

export function CheckoutPage() {
  const { productId } = useParams<{ productId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signInWithGoogle } = useAuth();
  const { config } = useConfig();

  const incoming = (location.state as CheckoutState | null) ?? null;

  const { product, game, isLoading, notFound } = useProduct(productId);

  const [step, setStep] = useState<CheckoutStep>('player');
  const [playerId, setPlayerId] = useState(incoming?.playerId ?? '');
  const [quantity] = useState(incoming?.quantity ?? 1);
  const [couponCode, setCouponCode] = useState(incoming?.couponCode ?? '');
  const [orderData, setOrderData] = useState<CreateOrderResponse | null>(null);
  const [finalOrder, setFinalOrder] = useState<Order | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const createOrder = useCreateOrder();
  const verifyPayment = useVerifyPayment(orderData?.order.id);
  const cancelOrder = useCancelOrder();

  // Mientras el proveedor despacha, el estado cambia solo: se escucha en vivo.
  const liveOrder = useLiveOrder(finalOrder?.id, finalOrder ?? undefined);

  useDocumentTitle(product ? `Comprar ${product.name}` : 'Comprar');

  const maxAttempts = config?.checkout.maxVerifyAttempts ?? 5;

  const handleCreateOrder = () => {
    if (!game || !product) return;

    createOrder.mutate(
      {
        gameId: game.id,
        productId: product.id,
        playerId,
        quantity,
        couponCode: couponCode.trim() || null,
      },
      {
        onSuccess: (data) => {
          setOrderData(data);
          setAttempts(0);
          setVerifyError(null);
          setStep('payment');
        },
        onError: (error) => {
          toast.error(errorMessage(error));
          // Si falla la creación automática, el cliente se queda en el paso 1
          // y puede corregir el ID o volver a intentarlo a mano.
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
    if (autoCreated.current) return;
    if (!incoming?.playerId || !user || !product || !game) return;
    if (step !== 'player' || orderData || createOrder.isPending) return;

    autoCreated.current = true;
    handleCreateOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.playerId, user, product, game, step, orderData]);

  if (isLoading) return <FullPageLoader label="Cargando el producto…" />;

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
  const waitingForAutoOrder =
    Boolean(incoming?.playerId) && Boolean(user) && step === 'player' && !orderData;

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
            playerId={playerId}
            onPlayerIdChange={setPlayerId}
            couponCode={couponCode}
            onCouponChange={setCouponCode}
            couponsEnabled={config?.features.couponsEnabled ?? false}
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
    </div>
  );
}
