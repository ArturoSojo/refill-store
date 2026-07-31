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
import { Input } from '@/components/ui/Field';
import { onlyDigits } from '@/lib/utils';
import { DEFAULT_PLAYER_FIELD, type Game, type PlayerField } from '@/types/models';

/** Campos del juego, con respaldo para documentos antiguos sin `playerFields`. */
export function gameFields(game: Game | null | undefined): PlayerField[] {
  if (!game) return [DEFAULT_PLAYER_FIELD];

  const declared = Array.isArray(game.playerFields) ? game.playerFields : [];
  if (declared.length > 0) return declared;

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

/** `true` si todos los campos obligatorios están completos y bien formados. */
export function fieldsAreValid(fields: PlayerField[], values: Record<string, string>): boolean {
  return fields.every((field) => {
    const value = (values[field.key] ?? '').trim();
    if (!value) return !field.required;
    return compile(field.pattern).test(value);
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
              // Los campos numéricos filtran en el momento: evita que un espacio
              // pegado desde el juego invalide un ID que sí es correcto.
              const next =
                field.type === 'number'
                  ? onlyDigits(event.target.value).slice(0, 20)
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
