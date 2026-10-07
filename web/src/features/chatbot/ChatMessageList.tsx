import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { CopyField } from '@/components/common/CopyField';
import { cn } from '@/lib/utils';
import type { ChatMessage, ChatOption } from './types';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onSelectOption: (optionId: string) => void;
}

function GameCard({
  option,
  disabled,
  onSelect,
}: {
  option: ChatOption;
  disabled: boolean;
  onSelect: () => void;
}) {
  const accent = option.accent ?? '#475569';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="overflow-hidden rounded-xl border border-base-500 bg-base-800 text-left transition hover:bg-base-700 disabled:cursor-not-allowed disabled:opacity-40"
      style={{ borderColor: option.accent }}
    >
      <span
        aria-hidden
        className="block aspect-[16/9] w-full bg-cover bg-center"
        style={{
          background: option.imageUrl
            ? `url(${option.imageUrl}) center/cover`
            : `linear-gradient(145deg, ${accent}, #0f172a)`,
        }}
      />
      <span className="block px-2 py-1.5">
        <span className="block truncate text-xs font-bold text-white">{option.label}</span>
        {option.hint && <span className="block truncate text-[11px] text-slate-400">{option.hint}</span>}
      </span>
    </button>
  );
}

/** Burbujas de texto y opciones interactivas; las opciones sólo están activas en el último mensaje. */
export function ChatMessageList({ messages, isTyping, onSelectOption }: ChatMessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isTyping]);

  return (
    <div
      className="flex-1 space-y-2 overflow-y-auto px-3 py-4"
      role="log"
      aria-live="polite"
      aria-label="Conversación con el asistente"
    >
      {messages.map((message, index) => {
        const isUser = message.from === 'user';
        const active = index === messages.length - 1 && !isTyping;
        const variant = message.optionsVariant ?? 'buttons';

        return (
          <div key={message.id} className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}>
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-snug shadow',
                isUser
                  ? 'rounded-br-sm bg-emerald-600 text-white'
                  : 'rounded-bl-sm bg-base-700 text-slate-100'
              )}
            >
              {message.progress && index === messages.length - 1 && (
                <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin align-[-2px]" aria-hidden />
              )}
              {message.text}
            </div>

            {message.copyFields && message.copyFields.length > 0 && (
              <div className="mt-2 w-full max-w-[92%] space-y-2">
                {message.copyFields.map((field) => (
                  <CopyField
                    key={field.label}
                    label={field.label}
                    value={field.value}
                    display={field.display}
                    emphasis={field.emphasis}
                  />
                ))}
              </div>
            )}

            {message.options && message.options.length > 0 && (
              <div
                className={cn(
                  'mt-2 w-full',
                  variant === 'games' && 'grid grid-cols-2 gap-2',
                  variant === 'list' && 'flex flex-col gap-2',
                  variant === 'buttons' && 'flex flex-wrap gap-2'
                )}
              >
                {message.options.map((option) =>
                  variant === 'games' ? (
                    <GameCard
                      key={option.id}
                      option={option}
                      disabled={!active}
                      onSelect={() => onSelectOption(option.id)}
                    />
                  ) : (
                    <button
                      key={option.id}
                      type="button"
                      disabled={!active}
                      onClick={() => onSelectOption(option.id)}
                      className={cn(
                        'rounded-xl border border-base-500 bg-base-800 px-3 py-2 text-left text-sm font-semibold text-white transition hover:bg-base-700',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                        variant === 'list' && 'flex items-center justify-between gap-3'
                      )}
                    >
                      <span className="min-w-0">{option.label}</span>
                      {option.hint && (
                        <span
                          className={cn(
                            'text-xs font-normal text-slate-400',
                            variant === 'list' ? 'shrink-0 text-right' : 'block'
                          )}
                        >
                          {option.hint}
                        </span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}

            {message.actions && message.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    disabled={!active}
                    onClick={() => onSelectOption(action.id)}
                    className="rounded-full border border-emerald-600/60 bg-emerald-600/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-600/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {isTyping && (
        <div className="flex items-start" aria-label="El asistente está escribiendo">
          <div className="flex gap-1 rounded-2xl rounded-bl-sm bg-base-700 px-3 py-3">
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                style={{ animationDelay: `${dot * 120}ms` }}
              />
            ))}
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
