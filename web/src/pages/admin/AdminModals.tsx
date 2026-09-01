/**
 * Modales de la tienda.
 *
 * El caso que lo motivó es el tutorial de «cómo recargar», que hasta ahora se
 * explicaba por WhatsApp cliente a cliente. Cada modal se edita entero y se
 * previsualiza aquí mismo, para no tener que publicarlo a ciegas y comprobarlo
 * en la tienda.
 */
import { useEffect, useState } from 'react';
import { Eye, GraduationCap, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminModals,
  useSaveModal,
  useDeleteModal,
} from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch, Textarea } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { errorMessage } from '@/lib/utils';
import type { StoreModal } from '@/types/models';

const VACIO = {
  title: '',
  body: '',
  videoUrl: '',
  imageUrl: '',
  ctaLabel: '',
  ctaUrl: '',
  active: false,
  frequency: 'once' as StoreModal['frequency'],
  placement: 'home' as StoreModal['placement'],
  sortOrder: '10',
};

type Formulario = typeof VACIO;

const FRECUENCIA: Record<StoreModal['frequency'], string> = {
  once: 'Una sola vez',
  daily: 'Una vez al día',
  always: 'Cada visita',
};

const UBICACION: Record<StoreModal['placement'], string> = {
  home: 'Al entrar al inicio',
  store: 'En toda la tienda',
  manual: 'Sólo con el botón',
};

/** Mismo criterio que el backend, para avisar antes de guardar. */
function embedUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  const patrones = [
    /youtu\.be\/([\w-]{6,})/i,
    /youtube\.com\/shorts\/([\w-]{6,})/i,
    /youtube\.com\/embed\/([\w-]{6,})/i,
    /[?&]v=([\w-]{6,})/i,
  ];
  for (const patron of patrones) {
    const m = url.match(patron);
    if (m) return `https://www.youtube.com/embed/${m[1]}`;
  }
  return '';
}

export function AdminModals() {
  useDocumentTitle('Panel · Modales');

  const modals = useAdminModals();
  const save = useSaveModal();
  const remove = useDeleteModal();

  const [editing, setEditing] = useState<StoreModal | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Formulario>(VACIO);
  const [toDelete, setToDelete] = useState<StoreModal | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setForm({
      title: editing.title,
      body: editing.body,
      videoUrl: editing.videoUrl,
      imageUrl: editing.imageUrl,
      ctaLabel: editing.ctaLabel,
      ctaUrl: editing.ctaUrl,
      active: editing.active,
      frequency: editing.frequency,
      placement: editing.placement,
      sortOrder: String(editing.sortOrder),
    });
  }, [editing]);

  const abrirNuevo = () => {
    setEditing(null);
    setForm(VACIO);
    setOpen(true);
  };

  const submit = () => {
    if (form.title.trim().length < 2) {
      toast.error('Ponle un título.');
      return;
    }

    save.mutate(
      {
        id: editing?.id,
        data: {
          ...form,
          title: form.title.trim(),
          sortOrder: Number(form.sortOrder) || 99,
        },
      },
      {
        onSuccess: () => {
          toast.success(editing ? 'Modal actualizado.' : 'Modal creado.');
          setOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const pasos = form.body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const videoListo = embedUrl(form.videoUrl);

  if (modals.error) return <ErrorState message="No pudimos cargar los modales." />;

  const list = modals.data?.modals ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Modales</h1>
          <p className="text-sm text-slate-400">
            Ventanas que se abren sobre la tienda: el tutorial de cómo recargar y avisos
          </p>
        </div>
        <Button size="sm" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={abrirNuevo}>
          Nuevo modal
        </Button>
      </div>

      {modals.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<GraduationCap className="h-7 w-7" aria-hidden />}
          title="Todavía no hay modales"
          description="Crea el tutorial de «cómo recargar» y deja de explicarlo uno por uno."
        />
      ) : (
        <Card className="p-0">
          {list.map((modal) => (
            <div
              key={modal.id}
              className="flex flex-wrap items-center gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">{modal.title}</span>
                  {modal.active ? (
                    <Badge variant="success">Activo</Badge>
                  ) : (
                    <Badge variant="danger">Oculto</Badge>
                  )}
                  {modal.videoUrl && <Badge variant="info">Con vídeo</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  {UBICACION[modal.placement]} · {FRECUENCIA[modal.frequency]} · orden{' '}
                  {modal.sortOrder}
                </p>
              </div>

              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing(modal);
                    setOpen(true);
                  }}
                >
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-300"
                  leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => setToDelete(modal)}
                >
                  Borrar
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Editar modal' : 'Nuevo modal'}
      >
        <div className="space-y-3">
          <Input
            label="Título"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value.slice(0, 80) })}
            placeholder="¿Cómo recargar?"
          />

          <Textarea
            label="Pasos"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value.slice(0, 1200) })}
            rows={5}
            hint="Una línea por paso. Se numeran solos."
            placeholder={'Elige tu juego y tu paquete\nEscribe tu ID de jugador\nPaga y pega la referencia'}
          />

          <Input
            label="Vídeo de YouTube (opcional)"
            value={form.videoUrl}
            onChange={(e) => setForm({ ...form, videoUrl: e.target.value })}
            placeholder="https://youtube.com/shorts/..."
            hint={
              form.videoUrl.trim() && !videoListo
                ? 'No reconozco ese enlace de YouTube: no se mostrará vídeo.'
                : 'Pega el enlace tal cual: vale el normal, el corto y el Short.'
            }
            error={form.videoUrl.trim() && !videoListo ? 'Enlace no reconocido' : null}
          />

          <Input
            label="Imagen (opcional)"
            value={form.imageUrl}
            onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
            placeholder="https://..."
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Texto del botón (opcional)"
              value={form.ctaLabel}
              onChange={(e) => setForm({ ...form, ctaLabel: e.target.value.slice(0, 40) })}
              placeholder="Recargar ahora"
              hint="También es el texto del botón flotante."
            />
            <Input
              label="Enlace del botón"
              value={form.ctaUrl}
              onChange={(e) => setForm({ ...form, ctaUrl: e.target.value })}
              placeholder="/ o https://..."
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              label="Dónde aparece"
              value={form.placement}
              onChange={(e) =>
                setForm({ ...form, placement: e.target.value as StoreModal['placement'] })
              }
              options={[
                { value: 'home', label: 'Al entrar al inicio' },
                { value: 'store', label: 'En toda la tienda' },
                { value: 'manual', label: 'Sólo con el botón' },
              ]}
            />
            <Select
              label="Cada cuánto"
              value={form.frequency}
              onChange={(e) =>
                setForm({ ...form, frequency: e.target.value as StoreModal['frequency'] })
              }
              options={[
                { value: 'once', label: 'Una sola vez' },
                { value: 'daily', label: 'Una vez al día' },
                { value: 'always', label: 'Cada visita' },
              ]}
            />
            <Input
              label="Orden"
              type="number"
              min={0}
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </div>

          <Switch
            checked={form.active}
            onChange={(active) => setForm({ ...form, active })}
            label="Visible en la tienda"
            description="Apagado se guarda pero no lo ve nadie."
          />

          {/* Ver antes de publicar: un tutorial mal escrito confunde más que
              no tener ninguno, y comprobarlo en la tienda obliga a activarlo. */}
          <Button
            variant="secondary"
            fullWidth
            leftIcon={<Eye className="h-4 w-4" aria-hidden />}
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? 'Ocultar vista previa' : 'Ver cómo queda'}
          </Button>

          {preview && (
            <div className="rounded-2xl border border-base-600 bg-base-900 p-3">
              <p className="text-sm font-bold text-white">{form.title || 'Sin título'}</p>
              {videoListo && (
                <div className="mt-2 aspect-video overflow-hidden rounded-xl bg-black">
                  <iframe src={videoListo} title="Vista previa" className="h-full w-full" />
                </div>
              )}
              {pasos.length > 0 && (
                <ol className="mt-2 space-y-1.5">
                  {pasos.map((paso, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-300">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-gradient text-[10px] font-black text-white">
                        {i + 1}
                      </span>
                      {paso}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <Button fullWidth loading={save.isPending} onClick={submit}>
            Guardar
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          remove.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success('Modal eliminado.');
              setToDelete(null);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Borrar el modal"
        message={`Se eliminará «${toDelete?.title ?? ''}». Si sólo quieres dejar de mostrarlo, apágalo en vez de borrarlo.`}
        confirmLabel="Sí, borrar"
        cancelLabel="Volver"
        destructive
        loading={remove.isPending}
      />
    </div>
  );
}
