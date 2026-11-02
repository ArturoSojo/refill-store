import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { FieldWrapper } from '@/components/ui/Field';
import { cn } from '@/lib/utils';

export interface SearchableOption {
  value: string;
  label: string;
}

export interface SearchableSelectProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  containerClassName?: string;
  className?: string;
  id?: string;
}

export function SearchableSelect({
  label,
  hint,
  error,
  options,
  value,
  onChange,
  placeholder = 'Seleccionar...',
  required,
  disabled,
  containerClassName,
  className,
  id,
}: SearchableSelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Orden alfabético estricto en español
  const sortedOptions = useMemo(() => {
    return [...options].sort((a, b) =>
      a.label.localeCompare(b.label, 'es', { sensitivity: 'base' })
    );
  }, [options]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return sortedOptions;
    const term = search.toLowerCase().trim();
    return sortedOptions.filter((opt) => opt.label.toLowerCase().includes(term));
  }, [sortedOptions, search]);

  const selectedOption = useMemo(
    () => sortedOptions.find((opt) => opt.value === value),
    [sortedOptions, value]
  );

  // Cierre al hacer clic afuera
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isOpen]);

  // Enfocar input cuando se abre
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Asegurar scroll sobre el elemento resaltado
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const activeEl = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, isOpen]);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setSearch('');
  };

  const handleClear = (event: React.MouseEvent) => {
    event.stopPropagation();
    onChange('');
    setSearch('');
    if (isOpen) {
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLButtonElement>) => {
    if (disabled) return;

    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setHighlightedIndex((prev) =>
          prev + 1 < filteredOptions.length ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlightedIndex((prev) =>
          prev - 1 >= 0 ? prev - 1 : Math.max(0, filteredOptions.length - 1)
        );
        break;
      case 'Enter':
        event.preventDefault();
        if (filteredOptions[highlightedIndex]) {
          handleSelect(filteredOptions[highlightedIndex].value);
        }
        break;
      case 'Escape':
        event.preventDefault();
        setIsOpen(false);
        setSearch('');
        break;
      case 'Tab':
        setIsOpen(false);
        setSearch('');
        break;
    }
  };

  return (
    <FieldWrapper
      label={label}
      hint={hint}
      error={error}
      required={required}
      htmlFor={selectId}
      className={containerClassName}
    >
      <div ref={containerRef} className="relative w-full">
        {/* Trigger principal */}
        <div
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={`${selectId}-list`}
          onClick={() => {
            if (!disabled) {
              setIsOpen((prev) => !prev);
              if (!isOpen) setSearch('');
            }
          }}
          className={cn(
            'input-base flex min-h-[46px] cursor-pointer items-center justify-between gap-2 px-3.5 py-2.5 transition',
            isOpen && 'border-neon-red ring-2 ring-neon-red/30',
            disabled && 'cursor-not-allowed opacity-50',
            error && 'border-red-500/60',
            className
          )}
        >
          {isOpen ? (
            <div className="flex flex-1 items-center gap-2">
              <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <input
                ref={inputRef}
                id={selectId}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Escribe para buscar..."
                className="w-full bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ) : (
            <span
              id={selectId}
              className={cn(
                'block truncate text-sm',
                selectedOption ? 'text-white' : 'text-slate-400'
              )}
            >
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          )}

          <div className="flex items-center gap-1.5 shrink-0">
            {value && !disabled && (
              <button
                type="button"
                onClick={handleClear}
                title="Limpiar selección"
                className="rounded p-0.5 text-slate-400 hover:bg-base-700 hover:text-white transition"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
            <ChevronDown
              className={cn(
                'h-4 w-4 text-slate-400 transition-transform duration-200',
                isOpen && 'rotate-180 text-neon-red'
              )}
              aria-hidden
            />
          </div>
        </div>

        {/* Dropdown flotante */}
        {isOpen && (
          <div className="absolute left-0 top-full z-50 mt-1.5 w-full rounded-xl border border-base-600 bg-base-900/95 p-1 shadow-2xl backdrop-blur-md">
            {/* Opción para limpiar / volver a placeholder cuando no es requerido */}
            {!required && (
              <button
                type="button"
                onClick={() => handleSelect('')}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs text-slate-400 hover:bg-base-800 hover:text-white transition',
                  value === '' && 'bg-base-800 text-neon-red font-medium'
                )}
              >
                <span>{placeholder || 'Todos los juegos'}</span>
                {value === '' && <Check className="h-3.5 w-3.5 text-neon-red" />}
              </button>
            )}

            <ul
              ref={listRef}
              id={`${selectId}-list`}
              role="listbox"
              className="max-h-60 overflow-y-auto py-1 text-sm space-y-0.5 focus:outline-none"
            >
              {filteredOptions.length === 0 ? (
                <li className="px-3 py-3 text-center text-xs text-slate-500">
                  No se encontraron juegos
                </li>
              ) : (
                filteredOptions.map((opt, index) => {
                  const isSelected = opt.value === value;
                  const isHighlighted = index === highlightedIndex;

                  return (
                    <li
                      key={opt.value}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(opt.value)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        'flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-xs sm:text-sm transition',
                        isHighlighted
                          ? 'bg-neon-red/15 text-white'
                          : 'text-slate-300 hover:bg-base-800 hover:text-white',
                        isSelected && 'font-medium text-neon-red'
                      )}
                    >
                      <span className="truncate">{opt.label}</span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-neon-red ml-2" />}
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        )}
      </div>
    </FieldWrapper>
  );
}
