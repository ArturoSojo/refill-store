/** Consultas del catálogo público. */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { CatalogResponse, GameCatalogResponse, ProductResponse, PublicProduct } from '@/types/models';

/**
 * El catálogo se revalida al volver a la pestaña.
 *
 * El cliente por defecto trae `refetchOnWindowFocus: false`, que está bien para
 * datos de cuenta pero no para el catálogo: al cambiar un precio o marcar un
 * paquete como destacado desde el panel y volver a la tienda, la pestaña
 * seguía mostrando la versión vieja durante todo el `staleTime`. Parecía que
 * el cambio no se había guardado.
 */
const CATALOG_OPTIONS = {
  staleTime: 60_000,
  refetchOnWindowFocus: true,
} as const;

export function useCatalog() {
  return useQuery({
    queryKey: QUERY_KEYS.catalog,
    queryFn: () => api.get<CatalogResponse>('/catalog', { anonymous: true }),
    ...CATALOG_OPTIONS,
  });
}

/** Catálogo completo de una familia, consultado al entrar en «Ver todos». */
export function useFamilyCatalog(
  family: 'topup' | 'gift_card' | 'game_key' | undefined,
  pageSize = 30,
  enabled = true
) {
  const query = useInfiniteQuery({
    queryKey: ['catalog', 'family', family ?? '', pageSize],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ family: family ?? '', limit: String(pageSize) });
      if (pageParam) params.set('cursor', pageParam);
      return api.get<CatalogResponse>(`/catalog?${params.toString()}`, {
        anonymous: true,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(family && enabled),
    ...CATALOG_OPTIONS,
  });
  return {
    ...query,
    data: query.data ? {
      ...query.data.pages[0],
      games: query.data.pages.flatMap((page) => page.games),
      nextCursor: query.data.pages[query.data.pages.length - 1]?.nextCursor ?? null,
    } : undefined,
    loadMore: () => void query.fetchNextPage(),
    hasMore: Boolean(query.hasNextPage),
    isLoadingMore: query.isFetchingNextPage,
  };
}

export function useGameCatalog(slug: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.game(slug ?? ''),
    queryFn: () => api.get<GameCatalogResponse>(`/games/${slug}`, { anonymous: true }),
    enabled: Boolean(slug),
    ...CATALOG_OPTIONS,
  });
}

/**
 * Busca un producto en el catálogo completo.
 * El checkout entra por URL directa (`/comprar/:productId`), así que necesita
 * resolver el producto sin haber pasado por la página del juego.
 */
export function useProduct(productId: string | undefined) {
  const query = useQuery({
    queryKey: ['product', productId ?? ''],
    queryFn: () => api.get<ProductResponse>(`/products/${encodeURIComponent(productId ?? '')}`, { anonymous: true }),
    enabled: Boolean(productId),
    ...CATALOG_OPTIONS,
  });

  return {
    product: query.data?.product,
    game: query.data?.game,
    rate: query.data?.rate ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    /** El catálogo cargó pero ese producto no existe o está inactivo. */
    notFound: !query.isLoading && !query.error && Boolean(productId) && !query.data?.product,
  };
}

/**
 * Agrupa los productos de un juego en las dos categorías del documento.
 *
 * No reordena: el catálogo llega ya ordenado de menor a mayor cantidad desde el
 * servidor, y `filter` respeta ese orden. Volver a ordenarlo aquí por
 * `sortOrder` era justamente lo que devolvía los combos nuevos al final de la
 * lista.
 */
export function groupProducts(products: PublicProduct[]) {
  return {
    automatic: products.filter((product) => product.fulfillment === 'auto'),
    manual: products.filter((product) => product.fulfillment === 'manual'),
  };
}
