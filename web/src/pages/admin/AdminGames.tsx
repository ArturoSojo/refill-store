import { useState } from 'react';
import { AlertTriangle, Gamepad2, Pencil, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminGames, useSaveGame, useDeleteGame } from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch, Textarea } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { errorMessage } from '@/lib/utils';
import { DEFAULT_PLAYER_FIELD, type Game, type PlayerField } from '@/types/models';

interface GameFormState {
  id: string;
  name: string;
  shortName: string;
  apiGameId: string;
  apiGameType: string;
  currencyLabel: string;
  currencyIcon: string;
  currencyIconUrl: string;
  playerFields: PlayerField[];
  validatesPlayerId: boolean;
  howToFindId: string;
  logoUrl: string;
  coverUrl: string;
  accentColor: string;
  accentColorSecondary: string;
  active: boolean;
  sortOrder: string;
}

/** Plantillas para no tener que escribir a mano los campos más habituales. */
const FIELD_PRESETS: Array<{ id: string; label: string; build: () => PlayerField }> = [
  {
    id: 'zone',
    label: 'Zone ID',
    build: () => ({
      key: 'zoneId',
      label: 'Zone ID',
      pattern: '^\\d{3,6}$',
      help: 'El Zone ID es el número entre paréntesis, de 3 a 6 dígitos.',
      placeholder: 'Ej: 2345',
      type: 'number',
      providerField: 'player_id2',
      required: true,
      sensitive: false,
    }),
  },
  {
    id: 'email',
    label: 'Correo',
    build: () => ({
      key: 'email',
      label: 'Correo de la cuenta',
      pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$',
      help: 'Escribe el correo con el que entras al juego.',
      placeholder: 'tucorreo@ejemplo.com',
      type: 'email',
      providerField: null,
      required: true,
      sensitive: false,
    }),
  },
  {
    id: 'password',
    label: 'Contraseña',
    build: () => ({
      key: 'password',
      label: 'Contraseña',
      pattern: '^.{4,60}$',
      help: 'La contraseña de la cuenta a recargar.',
      placeholder: '••••••••',
      type: 'password',
      providerField: null,
      required: true,
      sensitive: true,
    }),
  },
];

const EMPTY: GameFormState = {
  id: '',
  name: '',
  shortName: '',
  apiGameId: '0',
  apiGameType: 'dynamic',
  currencyLabel: 'Monedas',
  currencyIcon: '🎮',
  currencyIconUrl: '',
  playerFields: [{ ...DEFAULT_PLAYER_FIELD }],
  validatesPlayerId: false,
  howToFindId: '',
  logoUrl: '',
  coverUrl: '',
  accentColor: '#F03030',
  accentColorSecondary: '#3018F0',
  active: true,
  sortOrder: '99',
};

function toForm(game: Game): GameFormState {
  const fields =
    game.playerFields?.length > 0
      ? game.playerFields
      : [
          {
            ...DEFAULT_PLAYER_FIELD,
            label: game.playerIdLabel || DEFAULT_PLAYER_FIELD.label,
            pattern: game.playerIdPattern || DEFAULT_PLAYER_FIELD.pattern,
            help: game.playerIdHelp || DEFAULT_PLAYER_FIELD.help,
          },
        ];

  return {
    id: game.id,
    name: game.name,
    shortName: game.shortName ?? game.name,
    apiGameId: String(game.apiGameId),
    apiGameType: game.apiGameType,
    currencyLabel: game.currencyLabel,
    currencyIcon: game.currencyIcon ?? '🎮',
    currencyIconUrl: game.currencyIconUrl ?? '',
    playerFields: fields.map((field) => ({ ...field })),
    validatesPlayerId: game.validatesPlayerId ?? false,
    howToFindId: (game.howToFindId ?? []).join('\n'),
    logoUrl: game.logoUrl ?? '',
    coverUrl: game.coverUrl ?? '',
    accentColor: game.accentColor || '#F03030',
    accentColorSecondary: game.accentColorSecondary || '#3018F0',
    active: game.active,
    sortOrder: String(game.sortOrder),
  };
}

export function AdminGames() {
  useDocumentTitle('Panel · Juegos');
  const { isAdmin } = useAuth();

  const games = useAdminGames();
  const saveGame = useSaveGame();
  const deleteGame = useDeleteGame();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Game | null>(null);
  const [form, setForm] = useState<GameFormState>(EMPTY);
  const [toDelete, setToDelete] = useState<Game | null>(null);

  /** Cambia una propiedad de un campo sin tocar los demás. */
  const patchField = (index: number, patch: Partial<PlayerField>) => {
    setForm({
      ...form,
      playerFields: form.playerFields.map((field, position) =>
        position === index ? { ...field, ...patch } : field
      ),
    });
  };

  const addField = (preset: (typeof FIELD_PRESETS)[number]) => {
    if (form.playerFields.length >= 3) return;
    if (form.playerFields.some((field) => field.key === preset.build().key)) {
      toast.error('Ese campo ya está en el formulario.');
      return;
    }
    setForm({ ...form, playerFields: [...form.playerFields, preset.build()] });
  };

  // El proveedor sólo acepta `player_id` y `player_id2`; el resto de campos
  // existen para las entregas manuales.
  const secondaryTaken = form.playerFields.some(
    (field) => field.providerField === 'player_id2'
  );

  const submit = () => {
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      shortName: form.shortName.trim() || form.name.trim(),
      apiGameId: Number(form.apiGameId),
      apiGameType: form.apiGameType.trim(),
      currencyLabel: form.currencyLabel.trim(),
      currencyIcon: form.currencyIcon.trim(),
      currencyIconUrl: form.currencyIconUrl.trim(),
      playerFields: form.playerFields.map((field) => ({
        ...field,
        key: field.key.trim(),
        label: field.label.trim(),
        pattern: field.pattern.trim(),
        help: field.help.trim(),
        placeholder: field.placeholder.trim(),
      })),
      validatesPlayerId: form.validatesPlayerId,
      howToFindId: form.howToFindId
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6),
      logoUrl: form.logoUrl.trim(),
      coverUrl: form.coverUrl.trim(),
      accentColor: form.accentColor,
      accentColorSecondary: form.accentColorSecondary,
      active: form.active,
      sortOrder: Number(form.sortOrder) || 99,
    };

    if (!editing) payload.id = form.id.trim() || undefined;

    saveGame.mutate(
      { id: editing?.id, data: payload },
      {
        onSuccess: () => {
          toast.success(editing ? 'Juego actualizado.' : 'Juego creado.');
          setFormOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const list = games.data?.games ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Juegos</h1>
          <p className="text-sm text-slate-400">
            Identificadores del proveedor y validación del ID de jugador
          </p>
        </div>

        {isAdmin && (
          <Button
            size="sm"
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => {
              setEditing(null);
              setForm(EMPTY);
              setFormOpen(true);
            }}
          >
            Nuevo juego
          </Button>
        )}
      </div>

      {games.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Gamepad2 className="h-7 w-7" aria-hidden />}
          title="Sin juegos"
          description="Siembra el catálogo desde la sección de Productos o crea un juego manualmente."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((game) => (
            <Card key={game.id}>
              <div className="flex items-start gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl"
                  style={{ backgroundColor: `${game.accentColor}25` }}
                  aria-hidden
                >
                  <CurrencyIcon game={game} className="h-7 w-7 text-xl" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-white">{game.name}</h2>
                    {!game.active && <Badge variant="danger">Inactivo</Badge>}
                    {game.validatesPlayerId === false && (
                      <Badge variant="warning">ID sin validar</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    game_id {game.apiGameId} · {game.apiGameType}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Pide:{' '}
                    {(game.playerFields?.length > 0
                      ? game.playerFields.map((field) => field.label)
                      : [game.playerIdLabel]
                    ).join(' + ')}
                  </p>
                </div>

                {isAdmin && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(game);
                        setForm(toForm(game));
                        setFormOpen(true);
                      }}
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-base-700 hover:text-white"
                      aria-label={`Editar ${game.name}`}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setToDelete(game)}
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                      aria-label={`Eliminar ${game.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar ${editing.name}` : 'Nuevo juego'}
        size="lg"
        footer={
          <Button
            fullWidth
            loading={saveGame.isPending}
            disabled={form.name.trim().length < 2}
            onClick={submit}
          >
            {editing ? 'Guardar cambios' : 'Crear juego'}
          </Button>
        }
      >
        <div className="space-y-4">
          {!editing && (
            <Input
              label="Identificador (slug)"
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
              placeholder="free-fire"
              hint="Se usa en la URL. Si lo dejas vacío se genera del nombre."
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Nombre"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
            <Input
              label="Nombre corto"
              value={form.shortName}
              onChange={(event) => setForm({ ...form, shortName: event.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="game_id del proveedor"
              type="number"
              value={form.apiGameId}
              onChange={(event) => setForm({ ...form, apiGameId: event.target.value })}
              hint="Free Fire = -1, Blood Strike = 15"
            />
            <Input
              label="game_type"
              value={form.apiGameType}
              onChange={(event) => setForm({ ...form, apiGameType: event.target.value })}
              hint="freefire_id, dynamic…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Nombre de la moneda"
              value={form.currencyLabel}
              onChange={(event) => setForm({ ...form, currencyLabel: event.target.value })}
              placeholder="Diamantes"
            />
            <Input
              label="Emoji de respaldo"
              value={form.currencyIcon}
              onChange={(event) => setForm({ ...form, currencyIcon: event.target.value })}
              placeholder="💎"
              hint="Se usa si no hay imagen."
            />
            <Input
              label="Imagen de la moneda"
              value={form.currencyIconUrl}
              onChange={(event) => setForm({ ...form, currencyIconUrl: event.target.value })}
              placeholder="/coins/diamante-mlbb.svg"
              hint="Ruta o URL. Manda sobre el emoji."
            />
          </div>

          {(form.currencyIconUrl || form.currencyIcon) && (
            <div className="flex items-center gap-3 rounded-xl bg-base-900 px-4 py-3">
              <CurrencyIcon
                game={{
                  currencyIcon: form.currencyIcon,
                  currencyIconUrl: form.currencyIconUrl,
                  currencyLabel: form.currencyLabel,
                }}
                className="h-8 w-8 text-2xl"
              />
              <p className="text-xs text-slate-400">
                Así se verá junto a la cantidad de {form.currencyLabel || 'monedas'}.
              </p>
            </div>
          )}

          {/* --- Datos que se le piden al comprador --- */}
          <div className="rounded-2xl border border-base-600 bg-base-900/50 p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-white">Datos que pide el juego</h3>
                <p className="text-xs text-slate-400">
                  Uno debe ir como <code className="font-mono">player_id</code>. El proveedor
                  acepta un segundo (<code className="font-mono">player_id2</code>, el Zone ID);
                  los demás sólo sirven para entregas manuales.
                </p>
              </div>

              {form.playerFields.length < 3 && (
                <div className="flex flex-wrap gap-1.5">
                  {FIELD_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => addField(preset)}
                      className="rounded-full border border-base-500 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-neon-red hover:text-white"
                    >
                      + {preset.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              {form.playerFields.map((field, index) => (
                <div key={index} className="rounded-xl border border-base-600 bg-base-800 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-slate-500">
                      {field.key || 'sin_clave'}
                    </span>
                    {index > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setForm({
                            ...form,
                            playerFields: form.playerFields.filter((_, i) => i !== index),
                          })
                        }
                        className="rounded-lg p-1 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                        aria-label={`Quitar ${field.label}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      label="Etiqueta"
                      value={field.label}
                      onChange={(event) => patchField(index, { label: event.target.value })}
                    />
                    <Input
                      label="Clave interna"
                      value={field.key}
                      onChange={(event) =>
                        patchField(index, {
                          key: event.target.value.replace(/[^a-zA-Z0-9_]/g, ''),
                        })
                      }
                      className="font-mono"
                      disabled={index === 0}
                      hint={index === 0 ? 'El campo principal no cambia de clave.' : undefined}
                    />
                    <Input
                      label="Patrón de validación"
                      value={field.pattern}
                      onChange={(event) => patchField(index, { pattern: event.target.value })}
                      className="font-mono"
                      hint="Expresión regular."
                    />
                    <Select
                      label="Tipo"
                      value={field.type}
                      onChange={(event) =>
                        patchField(index, { type: event.target.value as PlayerField['type'] })
                      }
                      options={[
                        { value: 'number', label: 'Numérico' },
                        { value: 'text', label: 'Texto' },
                        { value: 'email', label: 'Correo' },
                        { value: 'password', label: 'Contraseña' },
                      ]}
                    />
                    <Input
                      label="Mensaje de ayuda"
                      value={field.help}
                      onChange={(event) => patchField(index, { help: event.target.value })}
                      containerClassName="sm:col-span-2"
                    />
                    <Input
                      label="Texto de ejemplo"
                      value={field.placeholder}
                      onChange={(event) => patchField(index, { placeholder: event.target.value })}
                    />
                    <Select
                      label="Se envía al proveedor como"
                      value={field.providerField ?? 'none'}
                      onChange={(event) =>
                        patchField(index, {
                          providerField:
                            event.target.value === 'none'
                              ? null
                              : (event.target.value as 'player_id' | 'player_id2'),
                        })
                      }
                      options={[
                        { value: 'player_id', label: 'player_id (principal)' },
                        // Sólo se ofrece si nadie más lo ocupa: el proveedor
                        // acepta un único segundo identificador.
                        ...(!secondaryTaken || field.providerField === 'player_id2'
                          ? [{ value: 'player_id2', label: 'player_id2 (Zone ID)' }]
                          : []),
                        { value: 'none', label: 'No se envía (entrega manual)' },
                      ]}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-4">
                    <Switch
                      checked={field.required}
                      onChange={(required) => patchField(index, { required })}
                      label="Obligatorio"
                    />
                    <Switch
                      checked={field.sensitive}
                      onChange={(sensitive) => patchField(index, { sensitive })}
                      label="Dato sensible"
                      description="No se guarda como acceso rápido ni se muestra en las listas."
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-base-600 bg-base-900/50 p-4">
            <Switch
              checked={form.validatesPlayerId}
              onChange={(validatesPlayerId) => setForm({ ...form, validatesPlayerId })}
              label="El proveedor valida el ID"
              description="Actívalo sólo si el proveedor rechaza un ID inexistente (hoy, únicamente Free Fire). Si está apagado, la tienda pide confirmar los datos antes de cobrar."
            />
            {!form.validatesPlayerId && (
              <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Con esta opción apagada, una recarga a un ID equivocado se cobra igual y no se
                  puede revertir.
                </span>
              </p>
            )}
          </div>

          <Textarea
            label="Cómo encontrar el ID"
            value={form.howToFindId}
            onChange={(event) => setForm({ ...form, howToFindId: event.target.value })}
            rows={4}
            hint="Un paso por línea (máximo 6)."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="URL del logo"
              value={form.logoUrl}
              onChange={(event) => setForm({ ...form, logoUrl: event.target.value })}
              placeholder="https://…"
            />
            <Input
              label="URL de la portada"
              value={form.coverUrl}
              onChange={(event) => setForm({ ...form, coverUrl: event.target.value })}
              placeholder="https://…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label-base" htmlFor="accent">
                Color principal
              </label>
              <input
                id="accent"
                type="color"
                value={form.accentColor}
                onChange={(event) => setForm({ ...form, accentColor: event.target.value })}
                className="h-11 w-full cursor-pointer rounded-xl border border-base-600 bg-base-900"
              />
            </div>
            <div>
              <label className="label-base" htmlFor="accent2">
                Color secundario
              </label>
              <input
                id="accent2"
                type="color"
                value={form.accentColorSecondary}
                onChange={(event) => setForm({ ...form, accentColorSecondary: event.target.value })}
                className="h-11 w-full cursor-pointer rounded-xl border border-base-600 bg-base-900"
              />
            </div>
            <Input
              label="Orden"
              type="number"
              value={form.sortOrder}
              onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
            />
          </div>

          <Switch
            checked={form.active}
            onChange={(active) => setForm({ ...form, active })}
            label="Activo"
            description="Visible en la tienda."
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          deleteGame.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success('Juego eliminado.');
              setToDelete(null);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Eliminar juego"
        message={`Se eliminará "${toDelete?.name}". Sólo es posible si no tiene productos asociados.`}
        confirmLabel="Eliminar"
        destructive
        loading={deleteGame.isPending}
      />
    </div>
  );
}
