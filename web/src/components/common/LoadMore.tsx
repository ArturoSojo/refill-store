/**
 * Pie de una lista paginada.
 *
 * Dice cuántos elementos se están viendo del total y ofrece traer los
 * siguientes. Que el total aparezca importa: el panel mostraba 30 usuarios de
 * 78 sin avisar de que faltaban, y no había forma de saberlo mirando la
 * pantalla.
 */
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface LoadMoreProps {
  loaded: number;
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Nombre en plural de lo que se lista: «órdenes», «usuarios»… */
  label: string;
}

export function LoadMore({
  loaded,
  total,
  hasMore,
  loading,
  onLoadMore,
  label,
}: LoadMoreProps) {
  if (loaded === 0) return null;

  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <p className="text-xs text-slate-500">
        {total !== null && total > loaded
          ? `Mostrando ${loaded} de ${total} ${label}`
          : `${loaded} ${label}`}
      </p>

      {hasMore && (
        <Button
          size="sm"
          variant="secondary"
          loading={loading}
          onClick={onLoadMore}
          leftIcon={loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : undefined}
        >
          {loading ? 'Cargando…' : 'Cargar más'}
        </Button>
      )}
    </div>
  );
}
