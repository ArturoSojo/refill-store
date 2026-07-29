import { useState } from 'react';
import { Gift, Share2, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useApplyReferral } from '@/hooks/useAccount';
import { useDocumentTitle, useCopy } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { CopyField } from '@/components/common/CopyField';
import { FullPageLoader, EmptyState } from '@/components/ui/Feedback';
import { formatUsd } from '@/lib/format';
import { errorMessage } from '@/lib/utils';

export function ReferralsPage() {
  useDocumentTitle('Referidos');
  const { me, profileLoading } = useAuth();
  const { config } = useConfig();
  const applyReferral = useApplyReferral();
  const { copy } = useCopy();
  const [code, setCode] = useState('');

  if (profileLoading || !me) return <FullPageLoader />;

  if (!config?.features.referralsEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <EmptyState
          icon={<Gift className="h-7 w-7" aria-hidden />}
          title="Programa de referidos desactivado"
          description="Por ahora no está disponible. Vuelve pronto."
        />
      </div>
    );
  }

  const shareUrl = `${window.location.origin}/?ref=${me.profile.referralCode}`;

  const share = async () => {
    const text = `¡Recarga tus juegos en Refill Store! Usa mi código ${me.profile.referralCode}: ${shareUrl}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Refill Store', text, url: shareUrl });
        return;
      } catch {
        // El usuario canceló el diálogo nativo: caemos al portapapeles.
      }
    }

    const copied = await copy(text, 'share');
    if (copied) toast.success('Enlace copiado.');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
          <Users className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold">Invita y gana</h1>
          <p className="text-sm text-slate-400">Comparte tu código con otros jugadores</p>
        </div>
      </div>

      <Card gradient className="text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Tu código</p>
        <p className="mt-2 font-mono text-3xl font-bold tracking-wider text-white">
          {me.profile.referralCode}
        </p>

        <div className="mt-5 space-y-2">
          <CopyField label="Enlace para compartir" value={shareUrl} copyKey="link" />
          <Button
            fullWidth
            leftIcon={<Share2 className="h-4 w-4" aria-hidden />}
            onClick={() => void share()}
          >
            Compartir
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="text-center">
          <p className="text-2xl font-bold tabular text-white">{me.profile.referralCount}</p>
          <p className="mt-1 text-xs text-slate-400">Jugadores invitados</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold tabular text-emerald-400">
            {formatUsd(me.profile.walletBalanceUsd)}
          </p>
          <p className="mt-1 text-xs text-slate-400">Saldo acumulado</p>
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
          <Gift className="h-4 w-4 text-neon-red" aria-hidden />
          Cómo funciona
        </h2>
        <ol className="space-y-3 text-sm text-slate-300">
          {[
            'Comparte tu código o enlace con otros jugadores.',
            'Ellos lo registran en esta misma página al crear su cuenta.',
            'Cuando completen su primera recarga, se acredita saldo a tu cuenta.',
          ].map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neon-red/20 text-xs font-bold text-neon-crimson">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </Card>

      {!me.profile.referredBy && (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-white">¿Te invitaron?</h2>
          <p className="mb-3 text-xs text-slate-400">
            Registra el código de quien te trajo. Sólo se puede hacer una vez.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="REF-XXXXXX"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 20))}
              containerClassName="flex-1"
              className="uppercase"
            />
            <Button
              variant="secondary"
              disabled={code.trim().length < 4}
              loading={applyReferral.isPending}
              onClick={() =>
                applyReferral.mutate(code.trim(), {
                  onSuccess: () => {
                    toast.success('¡Código aplicado!');
                    setCode('');
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              Aplicar
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
