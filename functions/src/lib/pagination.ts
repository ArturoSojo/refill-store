/**
 * Paginación por cursor para las listas del panel.
 *
 * Por cursor y no por número de página: Firestore cobra por documento leído y
 * `offset(n)` lee —y cobra— los n documentos que se salta. Con 917 entradas de
 * bitácora, ir a la página 10 costaría 500 lecturas para mostrar 50. Con
 * `startAfter` se leen sólo las de la página.
 *
 * Dos detalles que evitan errores sutiles:
 *
 *  - **Se pide una fila de más.** Así se sabe si hay página siguiente sin gastar
 *    una consulta `count()` aparte.
 *  - **El ID del documento va como último criterio de orden.** Sin ese
 *    desempate, dos documentos con la misma fecha —algo normal cuando se crean
 *    en el mismo segundo— pueden repetirse o desaparecer entre páginas, porque
 *    `startAfter` no sabría cuál de los dos fue el último.
 */
import { FieldPath, type Query, type DocumentData } from 'firebase-admin/firestore';
import { Timestamp } from '../config/firebase';
import { invalidArgument } from './errors';

export interface Page<T> {
  items: T[];
  /** Se pasa tal cual en la siguiente petición. `null` = no hay más. */
  nextCursor: string | null;
  /** Total de la colección con los filtros aplicados. Sólo en la primera página. */
  total?: number;
}

/** Serializa los valores de `startAfter` en una cadena opaca para el cliente. */
function encodeCursor(values: unknown[]): string {
  const plain = values.map((value) =>
    value instanceof Timestamp ? { __t: value.toMillis() } : value
  );
  return Buffer.from(JSON.stringify(plain), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('formato');

    return parsed.map((value) =>
      value && typeof value === 'object' && '__t' in value
        ? Timestamp.fromMillis((value as { __t: number }).__t)
        : value
    );
  } catch {
    throw invalidArgument('El cursor de paginación no es válido.');
  }
}

export interface PaginateOptions {
  /** Campo por el que se ordena. */
  orderBy: string;
  direction?: 'asc' | 'desc';
  limit: number;
  cursor?: string;
  /**
   * Cuenta el total. Sólo tiene sentido en la primera página: la agregación se
   * cobra aparte y el número no cambia al avanzar.
   */
  withTotal?: boolean;
}

/**
 * Ejecuta una consulta paginada.
 *
 * `query` debe traer ya los `where` aplicados, pero **sin** `orderBy` ni
 * `limit`: de eso se encarga esta función para garantizar el desempate.
 */
export async function paginate<T>(
  query: Query,
  options: PaginateOptions,
  map: (id: string, data: DocumentData) => T
): Promise<Page<T>> {
  const direction = options.direction ?? 'desc';

  let paged = query.orderBy(options.orderBy, direction).orderBy(FieldPath.documentId(), direction);

  if (options.cursor) {
    paged = paged.startAfter(...decodeCursor(options.cursor));
  }

  // Una de más para saber si queda página siguiente.
  const snap = await paged.limit(options.limit + 1).get();

  const hayMas = snap.size > options.limit;
  const docs = hayMas ? snap.docs.slice(0, options.limit) : snap.docs;
  const ultimo = docs[docs.length - 1];

  const total =
    options.withTotal && !options.cursor ? (await query.count().get()).data().count : undefined;

  return {
    items: docs.map((doc) => map(doc.id, doc.data())),
    nextCursor:
      hayMas && ultimo ? encodeCursor([ultimo.get(options.orderBy), ultimo.id]) : null,
    ...(total === undefined ? {} : { total }),
  };
}

/** Esquema compartido de los parámetros de paginación. */
export const PAGE_LIMIT = { min: 1, max: 100, default: 30 } as const;
