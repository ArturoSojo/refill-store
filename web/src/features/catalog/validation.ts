/**
 * Configuración de validación de IDs con FazerCards (GET /api/v2/topups/validate-id).
 */

export interface FazerValidationCategoryConfig {
  categoryId:
    | 'free_fire'
    | 'pubg_mobile'
    | 'mobile_legends'
    | 'magic_chess_gogo_global'
    | 'magic_chess_gogo_ru';
  name: string;
  requiredFields: Array<'player_id' | 'zone_id'>;
}

export const FAZER_VALIDATION_CATEGORIES: Record<string, FazerValidationCategoryConfig> = {
  free_fire: {
    categoryId: 'free_fire',
    name: 'Free Fire',
    requiredFields: ['player_id'],
  },
  pubg_mobile: {
    categoryId: 'pubg_mobile',
    name: 'PUBG Mobile',
    requiredFields: ['player_id'],
  },
  mobile_legends: {
    categoryId: 'mobile_legends',
    name: 'Mobile Legends',
    requiredFields: ['player_id', 'zone_id'],
  },
  magic_chess_gogo_global: {
    categoryId: 'magic_chess_gogo_global',
    name: 'Magic Chess Go Go (Global)',
    requiredFields: ['player_id', 'zone_id'],
  },
  magic_chess_gogo_ru: {
    categoryId: 'magic_chess_gogo_ru',
    name: 'Magic Chess Go Go (RU)',
    requiredFields: ['player_id', 'zone_id'],
  },
};

/**
 * Resuelve si un juego soporta validación de Player ID en FazerCards.
 * Devuelve null para juegos que no soportan validación (ej: Blood Strike, Delta Force).
 */
export function resolveFazerValidationCategory(
  game: { id?: string; apiGameId?: string | number; name?: string } | null | undefined
): FazerValidationCategoryConfig | null {
  if (!game) return null;
  const id = (game.id ?? '').toLowerCase();
  const apiId = String(game.apiGameId ?? '').toLowerCase();
  const name = (game.name ?? '').toLowerCase();

  // Free Fire
  if (
    id === 'free-fire' ||
    id === 'freefire' ||
    id.includes('free-fire') ||
    apiId.startsWith('free_fire') ||
    name.includes('free fire')
  ) {
    return FAZER_VALIDATION_CATEGORIES.free_fire;
  }

  // PUBG Mobile
  if (
    id.includes('pubg-mobile') ||
    id.includes('pubg_mobile') ||
    apiId.startsWith('pubg_mobile') ||
    (name.includes('pubg') && name.includes('mobile'))
  ) {
    return FAZER_VALIDATION_CATEGORIES.pubg_mobile;
  }

  // Magic Chess Go Go (RU)
  if (
    id.includes('magic-chess-gogo-ru') ||
    id.includes('magic_chess_gogo_ru') ||
    apiId === 'magic_chess_gogo_ru' ||
    (name.includes('magic chess') && name.includes('ru'))
  ) {
    return FAZER_VALIDATION_CATEGORIES.magic_chess_gogo_ru;
  }

  // Magic Chess Go Go (Global)
  if (
    id.includes('magic-chess-gogo') ||
    id.includes('magic_chess_gogo') ||
    apiId.startsWith('magic_chess_gogo') ||
    name.includes('magic chess')
  ) {
    return FAZER_VALIDATION_CATEGORIES.magic_chess_gogo_global;
  }

  // Mobile Legends (excluyendo Mobile Legends: Adventure que no soporta validación en FazerCards)
  if (
    !id.includes('adventure') &&
    !apiId.includes('adventure') &&
    !name.includes('adventure') &&
    (id.includes('mobile-legends') ||
      id.includes('mobile_legends') ||
      id === 'mlbb' ||
      apiId.startsWith('mobile_legends') ||
      name.includes('mobile legends'))
  ) {
    return FAZER_VALIDATION_CATEGORIES.mobile_legends;
  }

  return null;
}
