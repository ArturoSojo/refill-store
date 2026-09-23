import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Gamepad2, Gift, KeyRound, Search } from 'lucide-react';
import { useFamilyCatalog } from '@/hooks/useCatalog';
import { useDocumentTitle } from '@/hooks/useMisc';
import { AnimatedBackground } from '@/components/common/Decor';
import { ErrorState, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { GameTile } from '@/pages/HomePage';
import { ROUTES } from '@/lib/constants';
import type { Game } from '@/types/models';

const FAMILIES = {
  topup: {
    title: 'Recargas de juegos',
    description: 'Diamantes, monedas y pases directo a tu cuenta del juego.',
    icon: Gamepad2,
  },
  gift_card: {
    title: 'Gift cards',
    description: 'Códigos digitales para tiendas y servicios.',
    icon: Gift,
  },
  game_key: {
    title: 'Game keys',
    description: 'Claves digitales de juegos para distintas plataformas.',
    icon: KeyRound,
  },
} as const;

type FamilyId = keyof typeof FAMILIES;

function isFamily(value: string | undefined): value is FamilyId {
  return Boolean(value && value in FAMILIES);
}

function normalize(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function FamilyPage() {
  const { family: familyParam } = useParams<{ family: string }>();
  const family = isFamily(familyParam) ? familyParam : undefined;
  const meta = family ? FAMILIES[family] : undefined;
  const catalog = useFamilyCatalog(family);
  const [search, setSearch] = useState('');
  const games = catalog.data?.games ?? [];
  const filtered = useMemo(() => {
    const term = normalize(search.trim());
    if (!term) return games;
    return games.filter((game: Game) =>
      normalize(`${game.name} ${game.shortName} ${game.region ?? ''} ${game.platform ?? ''}`).includes(term)
    );
  }, [games, search]);
  const Icon = meta?.icon;

  useDocumentTitle(meta?.title ?? 'Catálogo');

  if (!family || !meta || !Icon) {
    return <div className="mx-auto max-w-lg px-4 py-16"><ErrorState title="Categoría no encontrada" message="Ese tipo de producto no existe en la tienda." action={<Link to={ROUTES.home} className="text-neon-crimson">Volver al inicio</Link>} /></div>;
  }

  return (
    <div className="relative min-h-[60vh]">
      <AnimatedBackground className="h-72" />
      <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-5">
        <Link to={ROUTES.home} className="mb-5 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Inicio
        </Link>
        <header className="mb-5 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-neon-red/15 text-neon-crimson"><Icon className="h-6 w-6" aria-hidden /></span>
          <div><h1 className="text-2xl font-black text-white sm:text-3xl">{meta.title}</h1><p className="text-sm text-slate-400">{meta.description}</p></div>
        </header>

        <label className="mb-4 flex h-11 max-w-xl items-center gap-2 rounded-xl border border-base-600 bg-base-800 px-3 focus-within:border-neon-red/60">
          <Search className="h-4 w-4 text-slate-500" aria-hidden />
          <input value={search} onChange={(event) => setSearch(event.target.value.slice(0, 60))} placeholder={`Buscar en ${meta.title.toLowerCase()}…`} className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500" />
        </label>

        {catalog.isLoading ? (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-56 rounded-2xl" />)}</div>
        ) : catalog.error ? (
          <ErrorState message="No pudimos cargar esta categoría." action={<button onClick={() => void catalog.refetch()} className="rounded-xl bg-base-700 px-4 py-2 text-sm font-semibold text-white">Reintentar</button>} />
        ) : filtered.length === 0 ? (
          <EmptyState title="No encontramos productos" description="Prueba con otro nombre, plataforma o región." />
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-500">Mostrando {filtered.length}{catalog.data?.total != null ? ` de ${catalog.data.total}` : ''} categorías</p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {filtered.map((game, index) => (
                <GameTile key={game.id} game={game} index={index} packageCount={game.productCount ?? 0}
                  minPriceBs={game.minPriceUsd != null && catalog.data ? game.minPriceUsd * catalog.data.rate : undefined} />
              ))}
            </div>
            {catalog.hasMore && <div className="mt-6 text-center"><button type="button" disabled={catalog.isLoadingMore} onClick={catalog.loadMore} className="rounded-xl border border-base-600 bg-base-800 px-5 py-3 text-sm font-bold text-white hover:border-neon-red/50 disabled:opacity-60">{catalog.isLoadingMore ? 'Cargando…' : 'Cargar más'}</button></div>}
          </>
        )}
      </div>
    </div>
  );
}
