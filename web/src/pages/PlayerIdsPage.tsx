import { useState } from 'react';
import { Gamepad2, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCatalog } from '@/hooks/useCatalog';
import { useSavedPlayerIds, useSavePlayerId, useDeletePlayerId } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import {
  PlayerFields,
  cleanValues,
  fieldsAreValid,
  gameFields,
} from '@/features/catalog/PlayerFields';
import { errorMessage } from '@/lib/utils';

export function PlayerIdsPage() {
  useDocumentTitle('Mis IDs de jugador');

  const catalog = useCatalog();
  const savedIds = useSavedPlayerIds();
  const savePlayerId = useSavePlayerId();
  const deletePlayerId = useDeletePlayerId();

  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [gameId, setGameId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');

  const games = catalog.data?.games ?? [];
  const ids = savedIds.data?.playerIds ?? [];

  const selectedGame = games.find((game) => game.id === gameId) ?? null;
  // Se guardan todos los campos menos los sensibles: un acceso rápido no es
  // sitio para la contraseña de la cuenta del jugador.
  const fields = gameFields(selectedGame).filter((field) => !field.sensitive);
  const primaryKey = fields[0]?.key ?? 'playerId';

  const reset = () => {
    setGameId('');
    setValues({});
    setLabel('');
  };

  const submit = () => {
    const clean = cleanValues(fields, values);
    const { [primaryKey]: primary, ...extra } = clean;

    savePlayerId.mutate(
      { gameId, playerId: primary, playerFields: extra, label: label.trim() },
      {
        onSuccess: () => {
          toast.success('Acceso guardado.');
          setFormOpen(false);
          reset();
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const canSubmit =
    Boolean(gameId) && fieldsAreValid(fields, values) && label.trim().length >= 2;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
            <Gamepad2 className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold">Mis IDs de jugador</h1>
            <p className="text-sm text-slate-400">Compra más rápido sin escribirlos de nuevo</p>
          </div>
        </div>

        <Button size="sm" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setFormOpen(true)}>
          Añadir
        </Button>
      </div>

      {savedIds.isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : ids.length === 0 ? (
        <EmptyState
          icon={<Gamepad2 className="h-7 w-7" aria-hidden />}
          title="Sin IDs guardados"
          description="Guarda el ID de tu cuenta del juego para no tener que escribirlo en cada compra."
          action={<Button onClick={() => setFormOpen(true)}>Añadir mi primer ID</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {ids.map((saved) => {
            const game = games.find((item) => item.id === saved.gameId);
            return (
              <li key={saved.id}>
                <Card className="flex items-center gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl"
                    style={{ backgroundColor: `${game?.accentColor ?? '#F03030'}25` }}
                    aria-hidden
                  >
                    {game ? (
                      <CurrencyIcon game={game} className="h-6 w-6 text-xl" />
                    ) : (
                      '🎮'
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">{saved.label}</p>
                    <p className="truncate text-xs text-slate-400">
                      {game?.name ?? saved.gameId} ·{' '}
                      <span className="tabular">
                        {[saved.playerId, ...Object.values(saved.playerFields ?? {})].join(' · ')}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setToDelete(saved.id)}
                    aria-label={`Eliminar ${saved.label}`}
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          reset();
        }}
        title="Guardar un ID de jugador"
        size="sm"
      >
        <div className="space-y-4">
          <Select
            label="Juego"
            value={gameId}
            onChange={(event) => {
              // Cada juego pide campos distintos: lo escrito para el anterior
              // no tiene por qué encajar en el nuevo.
              setGameId(event.target.value);
              setValues({});
            }}
            placeholder="Selecciona un juego"
            options={games.map((game) => ({ value: game.id, label: game.name }))}
            required
          />

          {gameId && (
            <PlayerFields
              fields={fields}
              values={values}
              onChange={setValues}
              showErrors={false}
              idPrefix="guardado"
            />
          )}
          <Input
            label="Nombre para identificarlo"
            value={label}
            onChange={(event) => setLabel(event.target.value.slice(0, 40))}
            placeholder="Ej: Mi cuenta principal"
            required
          />
          <Button fullWidth disabled={!canSubmit} loading={savePlayerId.isPending} onClick={submit}>
            Guardar
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          deletePlayerId.mutate(toDelete, {
            onSuccess: () => {
              toast.success('ID eliminado.');
              setToDelete(null);
            },
          });
        }}
        title="Eliminar ID"
        message="Este acceso rápido se borrará de tu cuenta. Tus órdenes anteriores no se ven afectadas."
        confirmLabel="Eliminar"
        destructive
        loading={deletePlayerId.isPending}
      />
    </div>
  );
}
