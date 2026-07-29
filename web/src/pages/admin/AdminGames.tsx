import { useState } from 'react';
import { Gamepad2, Pencil, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminGames, useSaveGame, useDeleteGame } from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Switch, Textarea } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { errorMessage } from '@/lib/utils';
import type { Game } from '@/types/models';

interface GameFormState {
  id: string;
  name: string;
  shortName: string;
  apiGameId: string;
  apiGameType: string;
  currencyLabel: string;
  currencyIcon: string;
  playerIdLabel: string;
  playerIdPattern: string;
  playerIdHelp: string;
  howToFindId: string;
  logoUrl: string;
  coverUrl: string;
  accentColor: string;
  accentColorSecondary: string;
  active: boolean;
  sortOrder: string;
}

const EMPTY: GameFormState = {
  id: '',
  name: '',
  shortName: '',
  apiGameId: '0',
  apiGameType: 'dynamic',
  currencyLabel: 'Monedas',
  currencyIcon: '🎮',
  playerIdLabel: 'ID de Jugador',
  playerIdPattern: '^\\d{8,12}$',
  playerIdHelp: 'Ingresa tu ID numérico del juego.',
  howToFindId: '',
  logoUrl: '',
  coverUrl: '',
  accentColor: '#F03030',
  accentColorSecondary: '#3018F0',
  active: true,
  sortOrder: '99',
};

function toForm(game: Game): GameFormState {
  return {
    id: game.id,
    name: game.name,
    shortName: game.shortName ?? game.name,
    apiGameId: String(game.apiGameId),
    apiGameType: game.apiGameType,
    currencyLabel: game.currencyLabel,
    currencyIcon: game.currencyIcon ?? '🎮',
    playerIdLabel: game.playerIdLabel,
    playerIdPattern: game.playerIdPattern,
    playerIdHelp: game.playerIdHelp,
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

  const submit = () => {
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      shortName: form.shortName.trim() || form.name.trim(),
      apiGameId: Number(form.apiGameId),
      apiGameType: form.apiGameType.trim(),
      currencyLabel: form.currencyLabel.trim(),
      currencyIcon: form.currencyIcon.trim(),
      playerIdLabel: form.playerIdLabel.trim(),
      playerIdPattern: form.playerIdPattern.trim(),
      playerIdHelp: form.playerIdHelp.trim(),
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
                  {game.currencyIcon || '🎮'}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-white">{game.name}</h2>
                    {!game.active && <Badge variant="danger">Inactivo</Badge>}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    game_id {game.apiGameId} · {game.apiGameType}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    ID: {game.playerIdPattern}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Nombre de la moneda"
              value={form.currencyLabel}
              onChange={(event) => setForm({ ...form, currencyLabel: event.target.value })}
              placeholder="Diamantes"
            />
            <Input
              label="Ícono"
              value={form.currencyIcon}
              onChange={(event) => setForm({ ...form, currencyIcon: event.target.value })}
              placeholder="💎"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Etiqueta del campo ID"
              value={form.playerIdLabel}
              onChange={(event) => setForm({ ...form, playerIdLabel: event.target.value })}
            />
            <Input
              label="Patrón de validación"
              value={form.playerIdPattern}
              onChange={(event) => setForm({ ...form, playerIdPattern: event.target.value })}
              hint="Expresión regular. Por defecto: ^\d{8,12}$"
              className="font-mono"
            />
          </div>

          <Input
            label="Mensaje de ayuda del ID"
            value={form.playerIdHelp}
            onChange={(event) => setForm({ ...form, playerIdHelp: event.target.value })}
          />

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
