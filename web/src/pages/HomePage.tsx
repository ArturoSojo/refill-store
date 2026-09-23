import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  ChevronRight,
  Clock,
  ShieldCheck,
  Sparkles,
  Wallet2,
  Gift,
  KeyRound,
  Zap,
} from 'lucide-react';
import { useCatalog } from '@/hooks/useCatalog';
import { useConfig } from '@/providers/ConfigProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { ActivityTicker } from '@/components/common/ActivityTicker';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { AnimatedBackground, CountUp } from '@/components/common/Decor';
import { HeroArt } from '@/components/common/Brand';
import { Skeleton, ErrorState, EmptyState, OrderStatusBadge } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatRelative } from '@/lib/format';
import { shortOrderItem } from '@/lib/orderItem';
import { hexToRgb } from '@/lib/utils';
import type { Game } from '@/types/models';

/** Tarjeta grande de juego, con la portada o un degradado del color propio. */
export function GameTile({
  game,
  packageCount,
  minPriceBs,
  index,
}: {
  game: Game;
  packageCount: number;
  minPriceBs?: number;
  index: number;
}) {
  const accent = game.accentColor || '#F03030';
  const accentSecondary = game.accentColorSecondary || '#3018F0';
  const deliveryLabel = game.providerFamily === 'gift_card'
    ? 'Código digital'
    : game.providerFamily === 'game_key'
      ? 'Game key'
      : 'Al instante';

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ delay: index * 0.08, duration: 0.4 }}
    >
      <Link
        to={ROUTES.game(game.id)}
        className="neon-card sheen group block"
        data-selected="false"
        style={
          {
            '--accent': accent,
            '--accent-soft': `rgba(${hexToRgb(accent)}, 0.3)`,
          } as React.CSSProperties
        }
      >
        <div
          className="relative h-36 overflow-hidden sm:h-44"
          style={{
            background: game.coverUrl
              ? `url(${game.coverUrl}) center/cover`
              : `linear-gradient(135deg, ${accent} 0%, ${accentSecondary} 120%)`,
          }}
        >
          {/* Barrido de luz sutil, como el escaneo de una HUD. */}
          <span
            className="absolute inset-x-0 top-0 h-16 animate-scan-line bg-gradient-to-b from-white/25 to-transparent"
            aria-hidden
          />
          <div className="absolute inset-0 bg-gradient-to-t from-base-800 via-base-800/30 to-transparent" />

          {!game.coverUrl && (
            <span
              className="absolute inset-0 flex items-center justify-center text-6xl opacity-90 drop-shadow-2xl transition-transform duration-500 group-hover:scale-110"
              aria-hidden
            >
              <CurrencyIcon game={game} className="h-16 w-16 text-6xl" />
            </span>
          )}

          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur">
            {game.providerFamily === 'gift_card' ? (
              <Gift className="h-3 w-3 text-emerald-300" aria-hidden />
            ) : game.providerFamily === 'game_key' ? (
              <KeyRound className="h-3 w-3 text-sky-300" aria-hidden />
            ) : (
              <Zap className="h-3 w-3 text-emerald-400" aria-hidden />
            )}
            {deliveryLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black text-white">{game.name}</h3>
            <p className="mt-0.5 truncate text-xs text-slate-400">
              {packageCount} paquetes
              {minPriceBs !== undefined && (
                <>
                  <span className="text-slate-700"> · </span>
                  desde <span className="tabular text-slate-300">{formatBs(minPriceBs)}</span>
                </>
              )}
            </p>
          </div>

          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:translate-x-1"
            style={{ backgroundColor: `rgba(${hexToRgb(accent)}, 0.18)`, color: accent }}
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

function Hero() {
  const { config } = useConfig();
  const navigate = useNavigate();
  const { data } = useCatalog();

  const firstGame = data?.games[0];

  return (
    <section className="relative overflow-hidden">
      {/* El arte de marca va detrás; la rejilla animada sólo lo acompaña por
          debajo, para que no compita con el emblema. */}
      <HeroArt className="h-[440px] sm:h-[620px]" />
      <AnimatedBackground className="h-[440px] opacity-40 sm:h-[620px]" />

      <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-10 sm:pt-16">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="max-w-2xl"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-neon-red/30 bg-neon-red/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-neon-crimson">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            Entrega automática 24/7
          </span>

          <h1 className="mt-4 text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
            Recarga tus juegos
            <br />
            <span className="gradient-text text-glow">en segundos</span>
          </h1>

          <p className="mt-4 max-w-lg text-base text-slate-400 sm:text-lg">
            {config?.tagline ??
              'Recargas de juegos, gift cards y game keys para Latinoamérica, con pago verificado y entrega digital.'}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(firstGame ? ROUTES.game(firstGame.id) : '#juegos')}
              className="group inline-flex h-14 items-center gap-2.5 rounded-2xl bg-brand-gradient px-7 text-base font-black text-white shadow-glow transition active:scale-[0.98]"
            >
              Recargar ahora
              <ArrowRight
                className="h-5 w-5 transition-transform group-hover:translate-x-1"
                aria-hidden
              />
            </button>

            {config && (
              <div className="inline-flex h-14 items-center gap-2.5 rounded-2xl border border-base-600 bg-base-800/70 px-5 backdrop-blur">
                <Wallet2 className="h-5 w-5 text-emerald-400" aria-hidden />
                <div className="leading-tight">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Tasa del día
                  </p>
                  <p className="text-sm font-bold tabular text-white">
                    <CountUp value={config.rate} format={(value) => formatBs(value)} />
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.div>

        <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            {
              icon: Clock,
              title: 'Menos de 1 minuto',
              text: 'Pagas, pegas la referencia y la recarga sale sola.',
            },
            {
              icon: ShieldCheck,
              title: 'Pago verificado',
              text: 'Validamos tu Pago Móvil BDV contra el banco antes de despachar.',
            },
            {
              icon: Sparkles,
              title: 'Sube de nivel',
              // El nivel lo determina el TOTAL GASTADO, no los puntos. El texto
              // anterior («cada compra suma puntos y te da descuento») atribuía
              // el descuento a unos puntos que no se canjean por nada.
              text: 'Mientras más compras, mejor nivel y más descuento en cada recarga.',
            },
          ].map((item, index) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1, duration: 0.35 }}
              className="neon-card flex items-start gap-3 p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
                <item.icon className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-bold text-white">{item.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.text}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ActiveOrdersStrip() {
  const { me } = useAuth();

  const active = (me?.recentOrders ?? []).filter((order) =>
    ['awaiting_payment', 'verifying', 'paid', 'dispatching', 'awaiting_manual', 'failed'].includes(
      order.status
    )
  );

  if (active.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-4">
      <div className="neon-card border-neon-red/40 p-4" data-selected="true">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-white">Tienes órdenes en curso</h2>
          <Link to={ROUTES.orders} className="text-xs font-bold text-neon-crimson hover:underline">
            Ver todas
          </Link>
        </div>

        <ul className="space-y-2">
          {active.slice(0, 3).map((order) => (
            <li key={order.id}>
              <Link
                to={ROUTES.order(order.id)}
                className="flex items-center justify-between gap-3 rounded-xl bg-base-900/60 px-3 py-2.5 transition hover:bg-base-700/60"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{shortOrderItem(order)}</p>
                  <p className="text-xs text-slate-500">
                    {order.code} · {formatRelative(order.createdAt)}
                  </p>
                </div>
                <OrderStatusBadge status={order.status} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function HomePage() {
  useDocumentTitle('');
  const { data, isLoading, error, refetch } = useCatalog();

  const games = data?.games ?? [];
  const grouped = useMemo(() => {
    const groups = new Map<'topup' | 'gift_card' | 'game_key', Game[]>();
    for (const game of games) {
      const key = game.providerFamily ?? 'topup';
      const items = groups.get(key) ?? [];
      items.push(game);
      groups.set(key, items);
    }
    return groups;
  }, [games]);
  const familySections = [
    { id: 'topup' as const, label: 'Recargas de juegos', titleIcon: Zap },
    { id: 'gift_card' as const, label: 'Gift cards', titleIcon: Gift },
    { id: 'game_key' as const, label: 'Game keys', titleIcon: KeyRound },
  ].filter((family) => (data?.familyCounts?.[family.id] ?? grouped.get(family.id)?.length ?? 0) > 0);

  return (
    <div className="space-y-10">
      <ActivityTicker />
      <Hero />
      <ActiveOrdersStrip />

      <div id="catalogo" className="scroll-mt-20 space-y-10">
        {isLoading ? (
          (['topup', 'gift_card', 'game_key'] as const).map((family) => (
            <section key={family} className="mx-auto max-w-6xl px-4">
              <Skeleton className="mb-4 h-8 w-56 rounded-xl" />
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-56 rounded-2xl" />)}
              </div>
            </section>
          ))
        ) : error ? (
          <section className="mx-auto max-w-6xl px-4">
            <ErrorState message="No pudimos cargar el catálogo." action={
              <button type="button" onClick={() => void refetch()} className="rounded-xl bg-base-700 px-4 py-2 text-sm font-semibold text-white hover:bg-base-600">Reintentar</button>
            } />
          </section>
        ) : familySections.length === 0 ? (
          <section className="mx-auto max-w-6xl px-4"><EmptyState title="Catálogo en preparación" description="Todavía no hay productos publicados." /></section>
        ) : (
          familySections.map((family) => (
            <section key={family.id} className="mx-auto max-w-6xl px-4">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neon-red/15 text-neon-crimson">
                    <family.titleIcon className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <h2 className="text-xl font-black text-white sm:text-2xl">{family.label}</h2>
                    <p className="text-xs text-slate-400">{family.id === 'topup' ? 'Diamantes, monedas y pases directo a tu cuenta.' : family.id === 'gift_card' ? 'Códigos digitales para tus tiendas y servicios.' : 'Claves digitales de juegos para distintas plataformas.'}</p>
                  </div>
                </div>
                <Link to={ROUTES.family(family.id)} className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-neon-crimson hover:underline sm:text-sm">
                  Ver {data?.familyCounts?.[family.id] ?? grouped.get(family.id)?.length ?? 0}<ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                {(grouped.get(family.id) ?? []).slice(0, 8).map((game, index) => (
                  <GameTile key={game.id} game={game} index={index}
                    packageCount={game.productCount ?? 0}
                    minPriceBs={game.minPriceUsd != null && data ? game.minPriceUsd * data.rate : undefined} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <section className="mx-auto max-w-6xl px-4">
        <div className="neon-card overflow-hidden p-0">
          <div className="grid gap-0 sm:grid-cols-4">
            {[
              { step: '01', title: 'Elige un producto', text: 'Recarga, gift card o game key.' },
              { step: '02', title: 'Completa los datos', text: 'ID del juego o datos de entrega solicitados.' },
              { step: '03', title: 'Paga y pega la referencia', text: 'Pago Móvil BDV, monto exacto.' },
              { step: '04', title: 'Recibe digitalmente', text: 'Seguimiento y entrega desde tu cuenta.' },
            ].map((item, index) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.08 }}
                className={`relative p-5 ${
                  index < 3 ? 'border-b border-base-600 sm:border-b-0 sm:border-r' : ''
                }`}
              >
                <span className="font-display text-3xl font-black text-base-500">{item.step}</span>
                <p className="mt-2 text-sm font-bold text-white">{item.title}</p>
                <p className="mt-1 text-xs text-slate-400">{item.text}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
