/** Consultas del catálogo público. */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { CatalogResponse, GameCatalogResponse, PublicProduct } from '@/types/models';

export function useCatalog() {
  return useQuery({
    queryKey: QUERY_KEYS.catalog,
    queryFn: () => api.get<CatalogResponse>('/catalog', { anonymous: true }),
    staleTime: 120_000,
  });
}

export function useGameCatalog(slug: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.game(slug ?? ''),
    queryFn: () => api.get<GameCatalogResponse>(`/games/${slug}`, { anonymous: true }),
    enabled: Boolean(slug),
    staleTime: 120_000,
  });
}

/**
 * Busca un producto en el catálogo completo.
 * El checkout entra por URL directa (`/comprar/:productId`), así que necesita
 * resolver el producto sin haber pasado por la página del juego.
 */
export function useProduct(productId: string | undefined) {
  const catalog = useCatalog();

  const product: PublicProduct | undefined = productId
    ? catalog.data?.products.find((item) => item.id === productId)
    : undefined;

  const game = product ? catalog.data?.games.find((item) => item.id === product.gameId) : undefined;

  return {
    product,
    game,
    rate: catalog.data?.rate ?? 0,
    isLoading: catalog.isLoading,
    error: catalog.error,
    /** El catálogo cargó pero ese producto no existe o está inactivo. */
    notFound: !catalog.isLoading && !catalog.error && Boolean(productId) && !product,
  };
}

/** Agrupa los productos de un juego en las dos categorías del documento. */
export function groupProducts(products: PublicProduct[]) {
  const automatic = products
    .filter((product) => product.fulfillment === 'auto')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const manual = products
    .filter((product) => product.fulfillment === 'manual')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return { automatic, manual };
}
