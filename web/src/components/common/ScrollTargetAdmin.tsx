import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, Sparkles } from 'lucide-react';
import { Input, Select } from '@/components/ui/Field';
import {
  CUSTOM_SCROLL_OPTION,
  SCROLL_TARGET_PRESETS,
  applyScrollTargetToUrl,
  getScrollPreset,
  resolveEffectiveScrollTarget,
  resolveNavigationTarget,
  sanitizeScrollTarget,
} from '@/lib/scrollTargets';
import { cn } from '@/lib/utils';

interface ScrollTargetFieldProps {
  url: string;
  scrollTarget?: string;
  onChange: (next: { url: string; scrollTarget: string }) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Selector reutilizable de "Sección de scroll al abrir (opcional)" para Modales
 * y Avisos en el Panel Admin. Mantiene sincronizados `url` y `scrollTarget`.
 */
export function ScrollTargetField({
  url,
  scrollTarget,
  onChange,
  disabled,
  className,
}: ScrollTargetFieldProps) {
  const effectiveTarget = resolveEffectiveScrollTarget(url, scrollTarget);
  const matchedPreset = getScrollPreset(effectiveTarget);
  const [customMode, setCustomMode] = useState<boolean>(
    Boolean(effectiveTarget && !matchedPreset)
  );

  useEffect(() => {
    if (effectiveTarget && !matchedPreset) {
      setCustomMode(true);
    } else if (effectiveTarget && matchedPreset) {
      setCustomMode(false);
    }
  }, [effectiveTarget, matchedPreset]);

  const selectValue = customMode
    ? CUSTOM_SCROLL_OPTION
    : matchedPreset
      ? matchedPreset.id
      : '';

  const navTarget = resolveNavigationTarget(url, scrollTarget);

  const options = [
    { value: '', label: 'Sin scroll específico (ir al inicio de la página)' },
    ...SCROLL_TARGET_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.optionLabel,
    })),
    { value: CUSTOM_SCROLL_OPTION, label: '⚙️ Otro ID personalizado...' },
  ];

  const handleSelectChange = (nextValue: string) => {
    if (nextValue === CUSTOM_SCROLL_OPTION) {
      setCustomMode(true);
      if (matchedPreset) {
        // Limpia el preset anterior para que el admin escriba su propio #id limpio.
        const cleared = applyScrollTargetToUrl(url, '');
        onChange(cleared);
      }
      return;
    }

    setCustomMode(false);
    onChange(applyScrollTargetToUrl(url, nextValue));
  };

  return (
    <div className={cn('space-y-2.5', className)}>
      <Select
        label="Sección de scroll al abrir (opcional)"
        value={selectValue}
        onChange={(event) => handleSelectChange(event.target.value)}
        options={options}
        disabled={disabled}
        hint={
          navTarget.scrollTarget
            ? `Destino sincronizado: ${navTarget.fullHref} · Hará scroll suave y resaltará la sección.`
            : 'Elige una sección para bajar automáticamente e iluminar el bloque al abrir el enlace.'
        }
      />

      {customMode && (
        <Input
          label="ID personalizado de la sección"
          value={effectiveTarget}
          onChange={(event) => {
            const cleanId = sanitizeScrollTarget(event.target.value);
            onChange(applyScrollTargetToUrl(url, cleanId));
          }}
          placeholder="Ej: tiempo-entrega"
          leftIcon={<span className="font-mono text-xs font-bold text-neon-crimson">#</span>}
          hint="Escribe el id exacto del elemento HTML sin el símbolo # (ej. telefono, juegos, tiempo-entrega)."
          disabled={disabled}
        />
      )}
    </div>
  );
}

interface ScrollJourneyPreviewProps {
  ctaLabel?: string;
  url?: string;
  scrollTarget?: string;
  fallbackCtaLabel?: string;
  className?: string;
}

/**
 * Tarjeta indicadora de recorrido de scroll + mini-vista previa simulada
 * (wireframe Gamer Mode) y botón rápido "Probar salto en vivo ↗".
 */
export function ScrollJourneyPreview({
  ctaLabel,
  url,
  scrollTarget,
  fallbackCtaLabel = 'Botón / enlace',
  className,
}: ScrollJourneyPreviewProps) {
  const navTarget = resolveNavigationTarget(url, scrollTarget);
  if (navTarget.isExternal || !navTarget.scrollTarget) return null;

  const preset = getScrollPreset(navTarget.scrollTarget);
  const displayCta = ctaLabel?.trim() || fallbackCtaLabel;
  const targetDescription = preset
    ? preset.journeyLabel
    : `Sección #${navTarget.scrollTarget}`;
  const wireframe = preset?.wireframe ?? {
    pageTitle: `Página (${navTarget.basePath})`,
    targetTitle: `#${navTarget.scrollTarget}`,
    targetSubtitle: 'Elemento personalizado con scroll suave y resalte Gamer Mode',
    isInput: false,
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-neon-red/30 bg-gradient-to-b from-base-800/90 to-base-900/95 p-3.5 shadow-sm',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-neon-red/40 bg-neon-red/15 px-2.5 py-0.5 text-[11px] font-bold text-neon-crimson">
            🎯 Salto automático activo
          </span>
          <code className="rounded bg-base-900 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
            #{navTarget.scrollTarget}
          </code>
        </div>

        <a
          href={navTarget.fullHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-neon-red/40 bg-neon-red/15 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-neon-red/25 hover:text-white"
        >
          Probar salto en vivo
          <ExternalLink className="h-3.5 w-3.5 text-neon-crimson" aria-hidden />
        </a>
      </div>

      {/* Flujo de acción paso a paso */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-base-600/80 bg-base-900/80 px-3 py-2 text-xs text-slate-300">
        <span className="inline-flex items-center gap-1 font-medium text-white">
          <span aria-hidden>🖱️</span> Clic en{' '}
          <strong className="text-neon-crimson">"{displayCta}"</strong>
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <span className="inline-flex items-center gap-1">
          <span aria-hidden>🌐</span> Abre:{' '}
          <code className="rounded bg-base-800 px-1.5 py-0.5 font-mono text-white">
            {navTarget.basePath}
          </code>
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <span className="inline-flex items-center gap-1">
          <span aria-hidden>🎯</span> Baja automáticamente hasta:{' '}
          <strong className="text-white">{targetDescription}</strong>
        </span>
      </div>

      {/* Mini-vista previa visual (wireframe de aterrizaje con resalte Gamer Mode) */}
      <div className="mt-3 rounded-xl border border-base-600/70 bg-base/80 p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
          <span className="font-medium text-slate-300">Vista simulada: {wireframe.pageTitle}</span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            ↓ Scroll suave al centro
          </span>
        </div>

        {/* Bloques superiores atenuados simulando el recorrido */}
        <div className="mb-2.5 space-y-1.5 opacity-35" aria-hidden>
          <div className="h-2.5 w-1/3 rounded bg-base-600" />
          <div className="h-6 w-full rounded-lg border border-base-700 bg-base-800/60" />
        </div>

        {wireframe.parentCard ? (
          <div className="rounded-xl border border-base-600 bg-base-800/80 p-2.5">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <Sparkles className="h-3 w-3 text-neon-red" aria-hidden />
              {wireframe.parentCard}
            </p>
            <div className="mb-2 h-6 rounded-lg border border-base-700 bg-base-900/60 px-2.5 py-1 text-[10px] text-slate-500">
              Nombre para mostrar
            </div>

            <div className="rounded-xl bg-red-500/[0.06] p-2.5 ring-2 ring-red-500/90 shadow-[0_0_25px_rgba(239,68,68,0.35)] transition-all duration-500">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs font-semibold text-white">{wireframe.targetTitle}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-200">
                  ✨ Aquí aterrizará la pantalla del usuario
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between rounded-lg border border-neon-red/70 bg-base-900 px-2.5 py-1.5 text-xs text-slate-300">
                <span className="flex items-center gap-0.5 font-mono text-slate-400">
                  <span className="inline-block h-3.5 w-0.5 animate-pulse bg-neon-crimson" />
                  {wireframe.targetSubtitle}
                </span>
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Auto-foco activo
                </span>
              </div>
              {wireframe.targetHint && (
                <p className="mt-1 text-[10px] text-slate-400">{wireframe.targetHint}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-red-500/[0.06] p-3 ring-2 ring-red-500/90 shadow-[0_0_25px_rgba(239,68,68,0.35)] transition-all duration-500">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-xs font-bold text-white">{wireframe.targetTitle}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-200">
                ✨ Aquí aterrizará la pantalla del usuario
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-300">{wireframe.targetSubtitle}</p>
          </div>
        )}
      </div>
    </div>
  );
}
