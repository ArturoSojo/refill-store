/**
 * Cinta de recargas recientes.
 *
 * Es prueba social real: sale de `/api/activity`, que devuelve las últimas
 * órdenes completadas con el nombre enmascarado. Si todavía no hay ventas, el
 * componente no se pinta —preferimos no mostrar nada antes que inventar datos—.
 */
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface ActivityItem {
  id: string;
  who: string;
  product: string;
  game: string;
  gameId: string;
  at: number;
}

const ACCENTS: Record<string, string> = {
  'free-fire': 'text-orange-300',
  'blood-strike': 'text-red-300',
};

export function ActivityTicker() {
  const { data } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<{ items: ActivityItem[] }>('/activity', { anonymous: true }),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  const items = data?.items ?? [];
  if (items.length === 0) return null;

  // Se duplica la lista para que el desplazamiento del 50% quede sin costura.
  const loop = [...items, ...items];

  return (
    <div className="relative border-y border-base-600/60 bg-base-900/70 py-2">
      <div className="marquee-mask overflow-hidden">
        <ul className="flex w-max animate-marquee items-center gap-8 whitespace-nowrap px-4 hover:[animation-play-state:paused]">
          {loop.map((item, index) => (
            <li
              key={`${item.id}-${index}`}
              className="flex shrink-0 items-center gap-2 text-xs text-slate-400"
            >
              <Zap className="h-3 w-3 text-emerald-400" aria-hidden />
              <span className="font-semibold text-slate-200">{item.who}</span>
              <span>recargó</span>
              <span className={`font-semibold ${ACCENTS[item.gameId] ?? 'text-neon-crimson'}`}>
                {item.product}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">{formatRelative(item.at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
