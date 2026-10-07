import { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { ButtonLink } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

const FAQS = [
  {
    q: '¿Cuánto tarda en llegar mi recarga?',
    a: 'Las recargas automáticas se despachan después de verificar el pago. A veces el proveedor tarda en procesarlas. Los productos manuales quedan en gestión y te avisamos cuando se completen.',
  },
  {
    q: '¿Qué pasa si pago menos o más del monto?',
    a: 'Si el verificador encuentra un pago menor, se guarda como pago parcial de la misma orden. Paga la diferencia y verifica la nueva referencia allí. Si cubres el total, la orden puede continuar; cualquier excedente queda registrado para revisión.',
  },
  {
    q: '¿Dónde consigo el número de referencia?',
    a: 'Es el número que te muestra tu banco al confirmar el Pago Móvil. Aparece en el comprobante y en el historial de la app del banco. Escribe sólo los dígitos, sin espacios ni guiones.',
  },
  {
    q: 'Me equivoqué de ID de jugador, ¿qué hago?',
    a: 'Si la orden aún no está pagada, cancélala y crea una nueva con el ID correcto. Si ya se despachó, escríbenos por WhatsApp lo antes posible: dependiendo del juego a veces se puede gestionar, aunque no está garantizado.',
  },
  {
    q: '¿Puedo usar la misma referencia dos veces?',
    a: 'No. Cada referencia bancaria sólo puede usarse en una orden. Si intentas repetirla, el sistema la rechaza automáticamente.',
  },
  {
    q: 'Pagué pero la orden aparece rechazada.',
    a: 'Consulta el motivo en la orden y revisa la referencia. No hagas otro pago sólo porque la verificación falló. Si la referencia aparece como usada o el pago sigue sin encontrarse, escríbenos con el número de orden y el comprobante.',
  },
  {
    q: '¿Por qué tengo que iniciar sesión?',
    a: 'Para que tus órdenes queden asociadas a tu cuenta: así puedes ver el estado en tiempo real, consultar tu historial, guardar tus IDs y recibir soporte con todo el contexto.',
  },
  {
    q: '¿Qué es el descuento por nivel?',
    a: 'Tu nivel depende de las compras acumuladas. Los niveles y descuentos vigentes se configuran en la tienda; puedes consultar tu nivel en Cuenta y ver el descuento antes de confirmar la compra.',
  },
];

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card overflow-hidden p-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left"
      >
        <span className="text-sm font-semibold text-white">{question}</span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && <p className="px-4 pb-4 text-sm leading-relaxed text-slate-400">{answer}</p>}
    </div>
  );
}

export function FaqPage() {
  useDocumentTitle('Preguntas frecuentes');
  const { config } = useConfig();

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
          <HelpCircle className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold">Preguntas frecuentes</h1>
          <p className="text-sm text-slate-400">Lo que más nos preguntan</p>
        </div>
      </div>

      <div className="space-y-2">
        {FAQS.map((faq) => (
          <FaqItem key={faq.q} question={faq.q} answer={faq.a} />
        ))}
      </div>

      {config?.supportUrl && (
        <div className="card text-center">
          <p className="text-sm text-slate-400">¿No encontraste tu respuesta?</p>
          <ButtonLink className="mt-3" to={config.supportUrl} external variant="whatsapp" fullWidth>
            Escríbenos por WhatsApp
          </ButtonLink>
        </div>
      )}
    </div>
  );
}

export function NotFoundPage() {
  useDocumentTitle('Página no encontrada');

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="font-display text-7xl font-extrabold gradient-text">404</p>
      <h1 className="mt-4 text-xl font-bold">Esta página no existe</h1>
      <p className="mt-2 text-sm text-slate-400">
        Puede que el enlace esté roto o que el contenido se haya movido.
      </p>
      <ButtonLink className="mt-6" to="/">
        Volver al inicio
      </ButtonLink>
    </div>
  );
}
