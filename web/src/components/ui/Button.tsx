import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'danger'
  | 'success'
  | 'whatsapp';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-gradient text-white shadow-glow hover:brightness-110 active:brightness-95 border border-transparent',
  secondary:
    'bg-base-700 text-white border border-base-500 hover:bg-base-600 hover:border-base-500',
  ghost: 'bg-transparent text-slate-300 hover:bg-base-700 hover:text-white border border-transparent',
  outline:
    'bg-transparent text-white border border-base-500 hover:border-neon-red hover:bg-neon-red/10',
  danger: 'bg-red-600 text-white hover:bg-red-500 border border-transparent',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 border border-transparent',
  whatsapp: 'bg-[#25D366] text-black font-semibold hover:bg-[#20bd5a] border border-transparent',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5 rounded-lg',
  md: 'h-11 px-5 text-sm gap-2 rounded-xl',
  lg: 'h-13 px-6 text-base gap-2.5 rounded-xl py-3.5',
  icon: 'h-10 w-10 rounded-xl',
};

const BASE =
  'inline-flex items-center justify-center font-semibold transition-all duration-150 ' +
  'select-none disabled:opacity-50 disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-red/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base ' +
  'active:scale-[0.98]';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    CommonProps {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    className,
    children,
    disabled,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

interface ButtonLinkProps extends CommonProps {
  to: string;
  className?: string;
  children?: ReactNode;
  /** Enlaces externos usan <a>, los internos <Link> de React Router. */
  external?: boolean;
  onClick?: () => void;
}

export function ButtonLink({
  to,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  leftIcon,
  rightIcon,
  className,
  children,
  external = false,
  onClick,
}: ButtonLinkProps) {
  const classes = cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className);

  if (external) {
    return (
      <a href={to} target="_blank" rel="noopener noreferrer" className={classes} onClick={onClick}>
        {leftIcon}
        {children}
        {rightIcon}
      </a>
    );
  }

  return (
    <Link to={to} className={classes} onClick={onClick}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}
