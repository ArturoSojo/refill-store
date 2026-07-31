import { useState } from 'react';
import { AlertTriangle, Clock, Landmark, Receipt, ShieldCheck, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { CopyField } from '@/components/common/CopyField';
import { useCountdown } from '@/hooks/useMisc';
import { formatBs, formatUsd } from '@/lib/format';
import { onlyDigits } from '@/lib/utils';
import type { CreateOrderResponse } from '@/types/models';

interface PaymentStepProps {
  data: CreateOrderResponse;
  onVerify: (reference: string) => void;
  verifying: boolean;
  error: string | null;
  onCancel: () => void;
  cancelling: boolean;
  attemptsLeft: number;
}

/**
 * Pantalla de pago.
 *
 * El orden de la información sigue lo que el cliente necesita hacer, en ese
 * mismo orden: cuánto pagar, a dónde, y dónde pegar la referencia. El monto va
 * primero y destacado porque un bolívar de diferencia hace que la verificación
 * contra el banco falle.
 */
export function PaymentStep({
  data,
  onVerify,
  verifying,
  error,
  onCancel,
  cancelling,
  attemptsLeft,
}: PaymentStepProps) {
  const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false);
  const { display: timeLeft, expired } = useCountdown(data.payment.expiresAt);

  const {
    bank,
    amountBs,
    amountUsd,
    walletAppliedUsd,
    referenceMinLength,
    referenceMaxLength,
  } = data.payment;

  const isValidReference =
    reference.length >= referenceMinLength && reference.length <= referenceMaxLength;

  return (
    <div className="space-y-5">
      {/* 1. Cuánto pagar */}
      <div className="card ring-gradient text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Monto exacto a transferir
        </p>
        <p className="mt-2 text-4xl font-extrabold tabular text-white">{formatBs(amountBs)}</p>
        <p className="mt-1 text-sm tabular text-slate-400">
          {formatUsd(amountUsd)} · Tasa {formatBs(data.payment.rate)}
        </p>

        {walletAppliedUsd > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300">
            <Wallet className="h-3.5 w-3.5" aria-hidden />
            Ya se descontaron {formatUsd(walletAppliedUsd)} de tu saldo
          </p>
        )}

        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          {expired ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 font-semibold text-red-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Orden expirada
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 font-semibold text-amber-300">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Tiempo para pagar: <span className="tabular">{timeLeft}</span>
            </span>
          )}
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Transfiere el monto <strong className="text-slate-300">exacto</strong>. Si envías otra
          cantidad, la verificación automática no lo reconocerá.
        </p>
      </div>

      {/* 2. A dónde pagar */}
      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-neon-red/15 text-neon-red">
            <Landmark className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white">Datos del Pago Móvil</h3>
            <p className="text-xs text-slate-400">Toca cualquier dato para copiarlo</p>
          </div>
        </div>

        <div className="space-y-2">
          <CopyField label="Banco" value={bank.code} display={`${bank.code} · ${bank.name}`} />
          <CopyField label="Cédula" value={bank.idNumber.replace(/[^\dVEJGvejg-]/g, '')} display={bank.idNumber} />
          <CopyField label="Teléfono" value={onlyDigits(bank.phone)} display={bank.phone} />
          <CopyField
            label="Monto"
            value={amountBs.toFixed(2)}
            display={formatBs(amountBs)}
            emphasis
          />
        </div>
      </div>

      {/* 3. Referencia */}
      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Receipt className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white">Confirma tu pago</h3>
            <p className="text-xs text-slate-400">
              Pega el número de referencia que te dio el banco
            </p>
          </div>
        </div>

        <Input
          inputMode="numeric"
          autoComplete="off"
          placeholder="Ej: 12345678"
          value={reference}
          onChange={(event) => setReference(onlyDigits(event.target.value).slice(0, referenceMaxLength))}
          onBlur={() => setTouched(true)}
          error={
            error ??
            (touched && reference.length > 0 && !isValidReference
              ? `La referencia debe tener entre ${referenceMinLength} y ${referenceMaxLength} dígitos.`
              : null)
          }
          hint={`Sólo números. Si tu referencia tiene letras o guiones, escribe únicamente los dígitos.`}
        />

        {attemptsLeft <= 2 && attemptsLeft > 0 && (
          <p className="mt-2 text-xs text-amber-400">
            Te quedan {attemptsLeft} intento{attemptsLeft === 1 ? '' : 's'} de verificación.
          </p>
        )}

        <Button
          className="mt-4"
          size="lg"
          fullWidth
          loading={verifying}
          disabled={!isValidReference || expired}
          onClick={() => {
            setTouched(true);
            if (isValidReference) onVerify(reference);
          }}
          leftIcon={!verifying ? <ShieldCheck className="h-4 w-4" aria-hidden /> : undefined}
        >
          {verifying ? 'Verificando con el banco…' : 'Ya pagué, verificar'}
        </Button>

        <p className="mt-3 text-center text-xs text-slate-500">
          Verificamos tu pago directamente con el banco. No subas capturas ni envíes nada por
          WhatsApp.
        </p>
      </div>

      <Button variant="ghost" fullWidth loading={cancelling} onClick={onCancel}>
        Cancelar orden
      </Button>
    </div>
  );
}
