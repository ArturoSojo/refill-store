import { useState } from 'react';
import { AlertTriangle, Clock, Landmark, Receipt, ShieldCheck, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { CopyField } from '@/components/common/CopyField';
import { useCountdown } from '@/hooks/useMisc';
import { formatBs, formatUsd } from '@/lib/format';
import { onlyDigits, cn } from '@/lib/utils';
import type { CreateOrderResponse } from '@/types/models';

interface PaymentStepProps {
  data: CreateOrderResponse;
  /** La transferencia sólo se ofrece si el panel la tiene activa y con cuenta. */
  transferEnabled: boolean;
  binancePayEnabled: boolean;
  onMethodChange: (method: 'pagomovil_bdv' | 'transfer' | 'binance_pay') => void;
  switchingMethod: boolean;
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
  transferEnabled,
  binancePayEnabled,
  onMethodChange,
  switchingMethod,
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
    method,
    bank,
    amountBs,
    paidBs,
    totalBs,
    amountUsd,
    walletAppliedUsd,
    referenceMinLength,
    referenceMaxLength,
  } = data.payment;

  const isTransfer = method === 'transfer';
  const isBinancePay = method === 'binance_pay';
  const showMethodPicker = transferEnabled || binancePayEnabled;
  // Ya abonó algo y falta la diferencia: hay que decírselo con todas las
  // letras, o va a transferir el total otra vez.
  const hayParcial = (paidBs ?? 0) > 0;

  const isValidReference =
    reference.length >= referenceMinLength && reference.length <= referenceMaxLength;

  return (
    <div className="space-y-5">
      {/* 1. Cuánto pagar */}
      <div className="card ring-gradient text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Monto exacto a pagar
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

        {hayParcial ? (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
            <p>
              Ya recibimos <strong>{formatBs(paidBs)}</strong> de los{' '}
              <strong>{formatBs(totalBs)}</strong> de esta orden.
            </p>
            <p className="mt-1">
              Paga sólo los <strong>{formatBs(amountBs)}</strong> que faltan y pega la
              referencia nueva aquí mismo. No hace falta crear otra orden.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-500">
            Si transfieres de menos, guardamos ese pago y te pedimos sólo la diferencia. De más,
            te lo abonamos al saldo.
          </p>
        )}
      </div>

      {/* 2. Cómo pagar. Va aquí, pegado a los datos, y no en el paso anterior:
          es donde el cliente los mira y donde cambia de idea. */}
      {showMethodPicker && (
        <div className="card">
          <p className="text-sm font-semibold text-white">¿Cómo vas a pagar?</p>
          <p className="mt-0.5 text-xs text-slate-400">
            Elige dónde pagar; sólo mostraremos los datos de esa opción.
          </p>

          <div className={`mt-3 grid gap-2 ${transferEnabled && binancePayEnabled ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'}`}>
            {(
              [
                { id: 'pagomovil_bdv', label: 'Pago Móvil', hint: 'Al teléfono' },
                { id: 'transfer', label: 'Transferencia', hint: 'A la cuenta' },
                ...(binancePayEnabled ? [{ id: 'binance_pay' as const, label: 'Binance Pay', hint: 'A tu Binance' }] : []),
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={switchingMethod || method === option.id || hayParcial}
                onClick={() => onMethodChange(option.id)}
                aria-pressed={method === option.id}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-default',
                  method === option.id
                    ? 'border-neon-red bg-neon-red/10'
                    : 'border-base-600 bg-base-900 hover:border-base-500',
                  switchingMethod && 'opacity-60'
                )}
              >
                <span className="block text-sm font-semibold text-white">{option.label}</span>
                <span className="block text-xs text-slate-400">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 3. A dónde pagar */}
      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-neon-red/15 text-neon-red">
            <Landmark className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white">
              {isTransfer ? 'Datos para la transferencia' : isBinancePay ? 'Pagar con Binance Pay' : 'Datos del Pago Móvil'}
            </h3>
            <p className="text-xs text-slate-400">Toca cualquier dato para copiarlo</p>
          </div>
        </div>

        <div className="space-y-2">
          {isBinancePay ? (
            <CopyField label="Binance Pay ID" value={bank.binancePayId ?? ''} display={bank.binancePayId ?? ''} emphasis />
          ) : <>
          <CopyField label="Banco" value={bank.code} display={`${bank.code} · ${bank.name}`} />
          <CopyField
            label={isTransfer ? 'Cédula / RIF' : 'Cédula'}
            value={bank.idNumber.replace(/[^\dVEJGvejg-]/g, '')}
            display={bank.idNumber}
          />
          {/* Un Pago Móvil se hace al teléfono y una transferencia al número de
              cuenta: mostrar los dos confunde y aumenta el riesgo de que el
              cliente pague al dato equivocado. */}
          {isTransfer ? (
            <CopyField
              label={`Cuenta ${bank.accountType === 'ahorro' ? 'de ahorro' : 'corriente'}`}
              value={onlyDigits(bank.accountNumber ?? '')}
              display={bank.accountNumber ?? ''}
            />
          ) : (
            <CopyField label="Teléfono" value={onlyDigits(bank.phone)} display={bank.phone} />
          )}
          </>}
          <CopyField
            label="Monto"
            value={amountBs.toFixed(2)}
            display={formatBs(amountBs)}
            emphasis
          />
        </div>
      </div>

      {/* 4. Referencia */}
      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Receipt className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white">Confirma tu pago</h3>
            <p className="text-xs text-slate-400">
              {isBinancePay ? 'Pega el código o referencia de la operación de Binance Pay' : 'Pega el número de referencia que te dio el banco'}
            </p>
          </div>
        </div>

        <Input
          inputMode={isBinancePay ? 'text' : 'numeric'}
          autoComplete="off"
          placeholder={isBinancePay ? 'Código de la operación' : 'Ej: 12345678'}
          value={reference}
          onChange={(event) => setReference((isBinancePay ? event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : onlyDigits(event.target.value)).slice(0, referenceMaxLength))}
          onBlur={() => setTouched(true)}
          error={
            error ??
            (touched && reference.length > 0 && !isValidReference
              ? isBinancePay
                ? `El código debe tener entre ${referenceMinLength} y ${referenceMaxLength} caracteres.`
                : `La referencia debe tener entre ${referenceMinLength} y ${referenceMaxLength} dígitos.`
              : null)
          }
          hint={isBinancePay ? 'Escribe el código tal como aparece en el comprobante de Binance Pay.' : 'Sólo números. Si tu referencia tiene letras o guiones, escribe únicamente los dígitos.'}
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
          {isBinancePay ? 'Verificamos tu pago con Pabilo. No subas capturas ni envíes nada por WhatsApp.' : 'Verificamos tu pago directamente con el banco. No subas capturas ni envíes nada por WhatsApp.'}
        </p>
      </div>

      <Button variant="ghost" fullWidth loading={cancelling} onClick={onCancel}>
        Cancelar orden
      </Button>
    </div>
  );
}
