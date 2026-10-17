import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { useDocumentTitle } from '@/hooks/useMisc';
import { ROUTES } from '@/lib/constants';

const PRIVACY_EMAIL = 'Soporterefillstore@gmail.com';

function PolicySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-bold text-white">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export function PrivacyPolicyPage() {
  useDocumentTitle('Política de privacidad');

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header className="card space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-crimson">
            <FileText className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-white">Política de privacidad</h1>
            <p className="text-xs text-slate-400">Última actualización: 13 de octubre de 2026</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-slate-300">
          Esta política explica cómo Refill Store trata la información cuando usas
          recargasrefillstore.com o la aplicación móvil Refill Store, creas una cuenta,
          compras productos digitales o contactas con soporte.
        </p>
      </header>

      <div className="card space-y-6">
        <PolicySection title="1. Responsable y contacto">
          <p>
            El servicio se identifica como Refill Store. Para consultas sobre privacidad,
            acceso, corrección o eliminación de datos, escribe a{' '}
            <a className="text-neon-crimson underline underline-offset-2" href={`mailto:${PRIVACY_EMAIL}`}>
              {PRIVACY_EMAIL}
            </a>
            . Incluye el correo asociado a tu cuenta; nunca envíes tu contraseña ni códigos de
            autenticación.
          </p>
        </PolicySection>

        <PolicySection title="2. Información que tratamos">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-slate-100">Cuenta:</strong> correo electrónico, identificador
              interno de Firebase, nombre y, si inicias sesión con Google, la foto de perfil que
              Google facilite. El teléfono es opcional. Firebase Authentication procesa las
              credenciales; Refill Store no recibe ni almacena tu contraseña en texto plano.
            </li>
            <li>
              <strong className="text-slate-100">Compras:</strong> juego o producto, paquete,
              cantidad, precio, descuentos, método e importe de pago, referencia de la operación,
              estado de la orden y datos de contacto que hagan falta para atenderla.
            </li>
            <li>
              <strong className="text-slate-100">Entrega digital:</strong> ID de jugador y otros
              campos que el producto solicite. Algunos productos pueden requerir datos de acceso a
              una cuenta del juego; introdúcelos únicamente si la pantalla del producto los pide.
              Se usan para tramitar esa entrega y no se incluyen en los correos de orden. No guardes
              contraseñas como un ID favorito.
            </li>
            <li>
              <strong className="text-slate-100">Cuenta y soporte:</strong> IDs de jugador que
              decidas guardar, saldo y movimientos de RefillCoins, referidos, cupones o beneficios
              aplicados, solicitudes y mensajes de soporte, y preferencias de correo y de órdenes.
            </li>
            <li>
              <strong className="text-slate-100">Datos técnicos:</strong> dirección IP y tipo de
              navegador/dispositivo (User-Agent) vinculados a operaciones para seguridad,
              prevención de abuso y diagnóstico; además de registros técnicos necesarios para
              mantener el servicio.
            </li>
            <li>
              <strong className="text-slate-100">Notificaciones push:</strong> si las autorizas
              en la app, Firebase Cloud Messaging procesa el token de notificación del dispositivo
              y la preferencia del sistema para entregar avisos. Puedes revocarlas desde los
              ajustes del dispositivo.
            </li>
          </ul>
        </PolicySection>

        <PolicySection title="3. Para qué usamos la información">
          <p>
            La usamos para crear y proteger tu cuenta; cotizar y gestionar órdenes; verificar
            pagos y evitar referencias duplicadas; entregar recargas, gift cards y claves; mostrar
            el historial y el estado de tus compras; mantener tu saldo, descuentos y referidos;
            responder solicitudes de soporte; enviar avisos transaccionales o push que hayas
            permitido; y detectar fraude, errores y problemas de seguridad. Las novedades y
            promociones por correo se pueden desactivar desde la configuración de la cuenta.
          </p>
        </PolicySection>

        <PolicySection title="4. Proveedores que participan en el servicio">
          <p>
            Compartimos sólo la información necesaria con proveedores que hacen posible la
            operación, según el producto y el método de pago elegido:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-slate-100">Google Firebase:</strong> autenticación,
              infraestructura de la aplicación y la web, almacenamiento operativo y notificaciones
              push. Si eliges Google para iniciar sesión, Google también procesa ese acceso.
            </li>
            <li>
              <strong className="text-slate-100">Inefable y FazerCards:</strong> proveedor de
              entrega seleccionado para la orden. Reciben los datos del producto y de la cuenta del
              juego que sean necesarios para entregar la recarga, el código o la clave.
            </li>
            <li>
              <strong className="text-slate-100">Pabilo:</strong> recibe la referencia y el monto
              que se consultan para verificar un pago compatible y puede devolver información del
              movimiento. Binance Pay también puede verificarse mediante la integración disponible
              en el checkout.
            </li>
            <li>
              <strong className="text-slate-100">Servicio de correo:</strong> Google/Gmail se
              utiliza para enviar mensajes operativos sobre restablecimiento de acceso y estado de
              órdenes.
            </li>
          </ul>
          <p>
            No vendemos datos personales. Los proveedores pueden tratar información en otros
            países conforme a sus propios términos y políticas. Cada proveedor independiente es
            responsable de sus propios tratamientos.
          </p>
        </PolicySection>

        <PolicySection title="5. Conservación y seguridad">
          <p>
            Conservamos los datos mientras sean necesarios para prestar el servicio y atender la
            cuenta. Las órdenes, referencias de pago y registros relacionados pueden conservarse
            después del cierre de una cuenta para completar entregas o reembolsos pendientes,
            resolver reclamos, prevenir fraude y mantener registros operativos o contables. Los
            registros técnicos se conservan sólo durante el tiempo razonablemente necesario para
            seguridad y diagnóstico. Aplicamos controles de acceso y medidas técnicas razonables;
            ningún sistema puede garantizar seguridad absoluta.
          </p>
        </PolicySection>

        <PolicySection title="6. Tus opciones y solicitudes">
          <p>
            Puedes corregir el nombre, teléfono y preferencias disponibles en tu cuenta, borrar
            los IDs guardados y revocar el permiso de notificaciones en tu dispositivo. Desde la
            sección Cuenta puedes iniciar el cierre de la cuenta. Ese cierre marca el perfil como
            cerrado y desactiva las preferencias de correo; no elimina automáticamente las órdenes
            ni los registros que deban conservarse para las finalidades descritas arriba.
          </p>
          <p>
            Para solicitar eliminación de la cuenta y de los datos que ya no deban conservarse,
            usa la página pública de{' '}
            <Link className="text-neon-crimson underline underline-offset-2" to={ROUTES.accountDeletion}>
              eliminación de cuenta
            </Link>{' '}
            o escribe al correo de privacidad. Verificaremos la solicitud y te informaremos si
            algún dato debe mantenerse y por qué.
          </p>
        </PolicySection>

        <PolicySection title="7. Privacidad de menores">
          <p>
            Refill Store es una tienda de productos digitales, no un servicio dirigido a niños.
            Si eres representante de un menor y consideras que nos proporcionó datos personales,
            contáctanos para revisar la situación y atender la solicitud correspondiente.
          </p>
        </PolicySection>

        <PolicySection title="8. Cambios a esta política">
          <p>
            Podemos actualizar esta página cuando cambien la app, los proveedores o las prácticas
            de tratamiento. Publicaremos aquí la versión vigente y actualizaremos la fecha indicada
            al principio.
          </p>
        </PolicySection>

        <div className="flex flex-wrap gap-3 border-t border-base-600 pt-5 text-sm">
          <Link to={ROUTES.accountDeletion} className="inline-flex items-center gap-2 text-neon-crimson hover:text-white">
            <Trash2 className="h-4 w-4" aria-hidden /> Solicitar eliminación de cuenta
          </Link>
          <a href={`mailto:${PRIVACY_EMAIL}`} className="inline-flex items-center gap-2 text-slate-300 hover:text-white">
            <Mail className="h-4 w-4" aria-hidden /> Contacto de privacidad
          </a>
          <span className="inline-flex items-center gap-2 text-slate-500">
            <ShieldCheck className="h-4 w-4" aria-hidden /> Refill Store
          </span>
        </div>
      </div>
    </main>
  );
}

export function AccountDeletionPage() {
  useDocumentTitle('Solicitar eliminación de cuenta');
  const subject = encodeURIComponent('Solicitud de eliminación de cuenta - Refill Store');
  const body = encodeURIComponent(
    'Hola, solicito la eliminación de mi cuenta y de los datos personales que ya no deban conservarse.\n\nCorreo asociado a mi cuenta:\nNombre (opcional):\n\nNo incluyas tu contraseña ni códigos de autenticación.'
  );
  const emailLink = `mailto:${PRIVACY_EMAIL}?subject=${subject}&body=${body}`;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <section className="card space-y-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-crimson">
            <Trash2 className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-white">Solicitar eliminación de cuenta</h1>
            <p className="text-sm text-slate-400">Página pública de Refill Store</p>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-slate-300">
          Puedes iniciar el cierre desde <strong className="text-white">Cuenta → Cerrar mi cuenta</strong>
          {' '}en la app. Para pedir la eliminación de la cuenta y de los datos personales que ya no
          necesitemos, también puedes contactarnos desde cualquier navegador, sin iniciar sesión ni
          reinstalar la aplicación.
        </p>

        <div className="rounded-xl border border-base-600 bg-base-900/70 p-4 text-sm leading-relaxed text-slate-300">
          <p className="font-semibold text-white">Qué hacer</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Escribe desde el correo asociado a tu cuenta.</li>
            <li>Indica que solicitas la eliminación de tu cuenta Refill Store.</li>
            <li>No envíes tu contraseña, códigos de acceso ni datos completos de pago.</li>
          </ol>
        </div>

        <a
          href={emailLink}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-neon-red px-5 py-3 text-sm font-bold text-white transition hover:bg-neon-crimson"
        >
          <Mail className="h-4 w-4" aria-hidden /> Enviar solicitud por correo
        </a>

        <p className="text-sm text-slate-400">
          También puedes escribir directamente a{' '}
          <a className="text-neon-crimson underline underline-offset-2" href={`mailto:${PRIVACY_EMAIL}`}>
            {PRIVACY_EMAIL}
          </a>
          . Revisaremos la solicitud y podremos pedir información razonable para comprobar que la
          cuenta es tuya. Las órdenes, pagos y datos necesarios para entregas pendientes, resolver
          reclamos, prevenir fraude o cumplir obligaciones aplicables pueden conservarse durante
          el tiempo necesario; te explicaremos cualquier retención aplicable.
        </p>

        <Link to={ROUTES.privacy} className="text-sm text-slate-300 underline underline-offset-2 hover:text-white">
          Leer la Política de privacidad
        </Link>
      </section>
    </main>
  );
}
