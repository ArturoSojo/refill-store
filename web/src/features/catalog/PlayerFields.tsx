/**
 * Formulario de los datos que pide cada juego.
 *
 * Antes esto era un único `<input>` de ID incrustado en dos pantallas. Dejó de
 * servir en cuanto entró Mobile Legends, que necesita ID **y** Zone ID: sin el
 * segundo el proveedor rechaza la recarga. Y los juegos que se entregan a mano
 * (Roblox, CoD Mobile) piden correo y contraseña, que ni siquiera son números.
 *
 * El juego declara sus campos y esta pieza los pinta; nada aquí conoce ningún
 * juego en concreto.
 */
import { useMemo } from 'react';
import { BadgeCheck, Gamepad2, KeyRound, Mail, MapPin } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input, Select } from '@/components/ui/Field';
import { onlyDigits } from '@/lib/utils';
import { DEFAULT_PLAYER_FIELD, type Game, type PlayerField } from '@/types/models';
import { resolveFazerValidationCategory } from './validation';

const ID_KEYS = new Set([
  'player_id',
  'game_user_id',
  'user_id',
  'uid',
  'account_id',
  'character_id',
  'open_id',
  'role_id',
  'playerid',
  'userid',
]);

const SERVER_KEYS = new Set([
  'server_id',
  'zone_id',
  'game_zone_id',
  'server',
  'zone',
  'game_server_id',
  'region',
  'serverid',
  'zoneid',
]);

/** Campos del juego, con respaldo para documentos antiguos sin `playerFields`. */
export function gameFields(game: Game | null | undefined): PlayerField[] {
  if (!game) return [DEFAULT_PLAYER_FIELD];

  const declared = Array.isArray(game.playerFields) ? game.playerFields : [];

  const isBs =
    game.id === 'blood-strike' ||
    game.id?.includes('blood-strike') ||
    game.id?.includes('bloodstrike') ||
    game.name?.toLowerCase().includes('blood strike') ||
    game.shortName?.toLowerCase().includes('blood strike');

  if (isBs) {
    const first = declared[0];
    return [
      {
        key: first?.key || 'game_user_id',
        label: first?.label || 'ID de jugador',
        pattern: first?.pattern || '^\\d{1,30}$',
        help: first?.help || 'El ID de Blood Strike tiene entre 8 y 12 dígitos, sólo números.',
        placeholder: first?.placeholder || 'Ej: 3363122817',
        type: 'text',
        providerField: 'player_id',
        required: true,
        sensitive: false,
      },
    ];
  }

  // Deduplicación universal: jamás pedir dos veces el ID de jugador
  // ni dos veces el servidor/zona en ningún juego del catálogo.
  let seenId = false;
  let seenServer = false;
  const sanitizedDeclared: PlayerField[] = [];
  for (const f of declared) {
    const key = (f.key || '').toLowerCase();
    const norm = (f.label || '').trim().toLowerCase();
    const isId =
      ID_KEYS.has(key) ||
      norm.includes('id de jugador') ||
      norm.includes('id del jugador') ||
      norm === 'player id' ||
      norm === 'user id' ||
      norm === 'uid';
    const isServer =
      SERVER_KEYS.has(key) ||
      norm.includes('servidor / zone id') ||
      norm.includes('zone id');

    if (isId) {
      if (seenId) continue;
      seenId = true;
    } else if (isServer) {
      if (seenServer) continue;
      seenServer = true;
    }
    sanitizedDeclared.push(f);
  }

  // Los juegos de Central One traen sus campos de `target_schema` (claves,
  // etiquetas y listas de servidores reales): forzar aquí el par User ID /
  // Zone ID de MLBB los pisaría con claves que el proveedor no pide.
  const validation =
    game.provider === 'centralone' && sanitizedDeclared.length > 0 ? null : resolveFazerValidationCategory(game);
  if (
    validation?.categoryId === 'mobile_legends' ||
    validation?.categoryId === 'magic_chess_gogo_global' ||
    validation?.categoryId === 'magic_chess_gogo_ru'
  ) {
    const first = sanitizedDeclared[0];
    const second = sanitizedDeclared[1];
    return [
      {
        key: first?.key || 'player_id',
        label: 'User ID',
        pattern: first?.pattern || '^\\d{6,12}$',
        help: first?.help || 'Tu User ID del juego.',
        placeholder: first?.placeholder || 'Ej: 123456789',
        type: first?.type || 'number',
        providerField: first?.providerField || 'player_id',
        required: true,
        sensitive: false,
      },
      {
        key: second?.key || 'server_id',
        label: 'Zone ID',
        pattern: second?.pattern || '^\\d{3,6}$',
        help: second?.help || 'El Zone ID es el número entre paréntesis.',
        placeholder: second?.placeholder || 'Ej: 2345',
        type: second?.type || 'number',
        providerField: second?.providerField || 'player_id2',
        required: true,
        sensitive: false,
      },
      ...sanitizedDeclared.slice(2),
    ];
  }

  if (sanitizedDeclared.length > 0) return sanitizedDeclared;

  return [
    {
      ...DEFAULT_PLAYER_FIELD,
      label: game.playerIdLabel || DEFAULT_PLAYER_FIELD.label,
      pattern: game.playerIdPattern || DEFAULT_PLAYER_FIELD.pattern,
      help: game.playerIdHelp || DEFAULT_PLAYER_FIELD.help,
    },
  ];
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /^\d{8,12}$/;
  }
}

/** Opciones de un campo `select`; vacío si el campo no es una lista cerrada. */
export function fieldOptions(field: PlayerField): Array<{ value: string; label: string }> {
  if (field.type !== 'select' || !Array.isArray(field.options)) return [];
  return field.options.filter((option) => option && typeof option.value === 'string' && option.value);
}

/**
 * Traduce lo que escribió el cliente al `value` de una opción.
 *
 * En el chatbot no hay desplegable: el cliente escribe «Brasil» o «br». Se
 * acepta la etiqueta o el valor sin distinguir mayúsculas; lo que no coincide
 * se devuelve tal cual para que la validación lo rechace.
 */
export function normalizeFieldValue(field: PlayerField, raw: string): string {
  const value = raw.trim();
  const options = fieldOptions(field);
  if (options.length === 0 || !value) return value;
  const lower = value.toLowerCase();
  const match = options.find(
    (option) => option.value.toLowerCase() === lower || option.label.trim().toLowerCase() === lower
  );
  return match ? match.value : value;
}

/** `true` si el valor cumple el campo: patrón y, si es lista, una opción válida. */
function valueIsValid(field: PlayerField, value: string): boolean {
  const options = fieldOptions(field);
  // Una lista cerrada manda sobre el patrón: el proveedor sólo acepta esos valores.
  if (options.length > 0) return options.some((option) => option.value === value);
  return compile(field.pattern).test(value);
}

/** `true` si todos los campos obligatorios están completos y bien formados. */
export function fieldsAreValid(fields: PlayerField[], values: Record<string, string>): boolean {
  return fields.every((field) => {
    const value = (values[field.key] ?? '').trim();
    if (!value) return !field.required;
    return valueIsValid(field, value);
  });
}

/** Campos con valor, listos para mandar a la API. */
export function cleanValues(
  fields: PlayerField[],
  values: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.key] ?? '').trim();
    if (value) out[field.key] = value;
  }
  return out;
}

function iconFor(field: PlayerField) {
  if (field.type === 'password') return <KeyRound className="h-4 w-4" aria-hidden />;
  if (field.type === 'email') return <Mail className="h-4 w-4" aria-hidden />;
  if (field.providerField === 'player_id2') return <MapPin className="h-4 w-4" aria-hidden />;
  return <Gamepad2 className="h-4 w-4" aria-hidden />;
}

interface PlayerFieldsProps {
  fields: PlayerField[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** Muestra los errores aunque el campo no se haya tocado todavía. */
  showErrors: boolean;
  onBlur?: () => void;
  /** Prefijo del `id` del input, para poder enfocarlo desde fuera. */
  idPrefix?: string;
}

export function PlayerFields({
  fields,
  values,
  onChange,
  showErrors,
  onBlur,
  idPrefix = 'campo',
}: PlayerFieldsProps) {
  const patterns = useMemo(
    () => Object.fromEntries(fields.map((field) => [field.key, compile(field.pattern)])),
    [fields]
  );

  return (
    <div className={fields.length > 1 ? 'grid gap-3 sm:grid-cols-2' : 'space-y-3'}>
      {fields.map((field) => {
        const value = values[field.key] ?? '';
        const options = fieldOptions(field);

        if (options.length > 0) {
          // Lista cerrada (servidor/región de Central One): un desplegable evita
          // que el cliente escriba un valor que el proveedor rechazaría.
          const known = options.some((option) => option.value === value);
          return (
            <Select
              key={field.key}
              id={`${idPrefix}-${field.key}`}
              label={field.label}
              options={options}
              placeholder={field.placeholder || `Elige ${field.label.toLowerCase()}`}
              value={known ? value : ''}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
              onBlur={onBlur}
              error={showErrors && field.required && !known ? field.help : null}
            />
          );
        }

        const valid = value.length > 0 && patterns[field.key].test(value);
        const invalid = value.length > 0 && !valid;

        return (
          <Input
            key={field.key}
            id={`${idPrefix}-${field.key}`}
            label={fields.length > 1 ? field.label : undefined}
            type={field.type === 'password' ? 'password' : 'text'}
            inputMode={field.type === 'number' ? 'numeric' : field.type === 'email' ? 'email' : 'text'}
            autoComplete={field.type === 'password' ? 'new-password' : 'off'}
            placeholder={field.placeholder || field.label}
            value={value}
            onChange={(event) => {
              // Los identificadores se conservan como texto: convertirlos a
              // number pierde precisión en IDs largos, y un límite fijo puede
              // recortar IDs válidos (por ejemplo, los de Delta Force).
              const next =
                field.type === 'number'
                  ? onlyDigits(event.target.value).slice(0, 120)
                  : event.target.value.slice(0, 120);
              onChange({ ...values, [field.key]: next });
            }}
            onBlur={onBlur}
            leftIcon={iconFor(field)}
            error={(showErrors || invalid) && invalid ? field.help : null}
            className={fields.length === 1 ? 'text-lg font-semibold tracking-wide' : undefined}
            rightSlot={
              valid && field.type !== 'password' ? (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400"
                >
                  <BadgeCheck className="h-4 w-4" aria-hidden />
                </motion.span>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}
