/**
 * Búsqueda aproximada para el asistente.
 *
 * Tolera mayúsculas, acentos, espacios de más y errores de tecleo («fre fire»,
 * «plystation»), y entiende abreviaturas habituales («mlbb», «cod», «robux»).
 * Es una función pura: no depende de React ni de la API.
 */
import type { Game } from '@/types/models';
import type { ChatFamily } from './types';

/** Minúsculas, sin acentos ni signos, con espacios simples. */
export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Abreviaturas y nombres coloquiales → nombre normalizado en el catálogo. */
const ALIASES: Record<string, string> = {
  mlbb: 'mobile legends',
  ml: 'mobile legends',
  ff: 'free fire',
  cod: 'call of duty',
  codm: 'call of duty mobile',
  robux: 'roblox',
  rbx: 'roblox',
  psn: 'playstation',
  ps: 'playstation',
  ps4: 'playstation',
  ps5: 'playstation',
  pubgm: 'pubg mobile',
  vbucks: 'fortnite',
  genshin: 'genshin impact',
};

/** Palabras que identifican cada categoría. */
const CATEGORY_KEYWORDS: Record<ChatFamily, string[]> = {
  topup: ['juegos', 'juego', 'recarga', 'recargas', 'videojuegos', 'topup', 'top up'],
  gift_card: ['gift card', 'gift cards', 'giftcard', 'giftcards', 'tarjeta', 'tarjetas', 'regalo'],
  game_key: ['game key', 'game keys', 'gamekey', 'key', 'keys', 'llave', 'llaves', 'codigo', 'codigos'],
};

/** Distancia de Damerau-Levenshtein (variante OSA): una transposición cuenta como 1. */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Similitud 0–1 entre una palabra escrita y una palabra candidata. */
function tokenSimilarity(q: string, t: string): number {
  if (q === t) return 1;
  if (q.length >= 3 && t.startsWith(q)) return 0.92;
  if (q.length >= 4 && t.includes(q)) return 0.85;
  // Palabras muy cortas sólo valen si coinciden exactas o por prefijo.
  if (q.length < 4 || t.length < 4) return 0;

  const allowed = q.length <= 6 ? 1 : q.length <= 9 ? 2 : 3;
  const d = distance(q, t);
  return d <= allowed ? 1 - d / Math.max(q.length, t.length) : 0;
}

/** Palabras de la consulta, con las abreviaturas ya expandidas. */
function queryTokens(query: string): string[] {
  return normalize(query)
    .split(' ')
    .filter(Boolean)
    .flatMap((token) => (ALIASES[token] ? ALIASES[token].split(' ') : [token]));
}

/** Puntúa una consulta contra un texto candidato ya normalizado. */
function scoreAgainst(tokens: string[], candidate: string): number {
  if (tokens.length === 0 || !candidate) return 0;
  const candidateTokens = candidate.split(' ');

  const sum = tokens.reduce(
    (acc, token) => acc + Math.max(0, ...candidateTokens.map((word) => tokenSimilarity(token, word))),
    0
  );
  let score = sum / tokens.length;

  // «freefire» sin espacio: se compara el texto unido.
  const joinedQuery = tokens.join('');
  const joinedCandidate = candidateTokens.join('');
  if (joinedQuery.length >= 4) {
    if (joinedCandidate.includes(joinedQuery)) {
      score = Math.max(score, 0.88);
    } else if (joinedQuery.length >= 5) {
      const d = distance(joinedQuery, joinedCandidate);
      if (d <= Math.ceil(joinedCandidate.length * 0.18)) {
        score = Math.max(score, 1 - d / Math.max(joinedQuery.length, joinedCandidate.length));
      }
    }
  }

  if (score === 0) return 0;
  // Entre «Free Fire» y «Free Fire Max», gana el que sobra menos.
  const extraWords = Math.max(0, candidateTokens.length - tokens.length);
  return Math.max(0, score - Math.min(extraWords * 0.01, 0.05));
}

export interface GameMatch {
  game: Game;
  score: number;
}

/** Textos por los que se puede encontrar un juego, con su peso. */
function gameKeys(game: Game): { text: string; weight: number }[] {
  const keys = [
    { text: game.name, weight: 1 },
    { text: game.shortName, weight: 0.97 },
    { text: game.id.replace(/-/g, ' '), weight: 0.97 },
    { text: game.currencyLabel, weight: 0.9 },
    { text: game.platform ?? '', weight: 0.8 },
  ];
  return keys
    .map((key) => ({ text: normalize(key.text ?? ''), weight: key.weight }))
    .filter((key) => key.text.length > 0);
}

/** Juegos que se parecen a la consulta, de mejor a peor, con `score ≥ minScore`. */
export function searchGames(query: string, games: Game[], minScore = 0.7): GameMatch[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  return games
    .map((game) => ({
      game,
      score: Math.max(0, ...gameKeys(game).map((key) => scoreAgainst(tokens, key.text) * key.weight)),
    }))
    .filter((match) => match.score >= minScore)
    .sort((a, b) => b.score - a.score || a.game.sortOrder - b.game.sortOrder);
}

/** Categoría a la que se refiere la consulta, si alguna. */
export function matchCategory(query: string): { family: ChatFamily; score: number } | null {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;

  let best: { family: ChatFamily; score: number } | null = null;
  (Object.keys(CATEGORY_KEYWORDS) as ChatFamily[]).forEach((family) => {
    const score = Math.max(...CATEGORY_KEYWORDS[family].map((word) => scoreAgainst(tokens, word)));
    if (score > 0 && (!best || score > best.score)) best = { family, score };
  });
  return best;
}

/** Detecta si la consulta busca recargar saldo interno (RefillCoins). */
export function isWalletQuery(query: string): boolean {
  const norm = normalize(query);
  const keywords = ['saldo', 'refillcoins', 'refillcoin', 'billetera', 'cartera'];
  return keywords.some((kw) => norm.includes(kw));
}
