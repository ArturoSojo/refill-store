/** Consultas del catálogo público. */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { CatalogResponse, GameCatalogResponse, PublicProduct } from '@/types/models';

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
