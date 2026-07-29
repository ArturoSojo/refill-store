/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Fondo en capas: la app es dark-only por diseño (Gamer Mode).
        base: {
          DEFAULT: '#07070C',
          900: '#0A0A11',
          800: '#101019',
          700: '#171724',
          600: '#1F1F30',
          500: '#2A2A3F',
        },
        // Paleta tomada del logotipo: el rojo #F03030 es el color dominante del
        // rótulo y del casco; el azul #3018F0 es el de la cruceta y la boca.
        neon: {
          /** Rojo exacto de la marca. Para superficies y rellenos. */
          red: '#F03030',
          /** Rojo aclarado: es el que se usa como TEXTO sobre fondo oscuro,
              porque el rojo puro se queda corto de contraste en tamaños chicos. */
          crimson: '#FF5A52',
          /** Rojo apagado, para bordes y sombras. */
          ember: '#B01B1B',
          /** Azul del logotipo. Acento secundario. */
          blue: '#3018F0',
          /** Azul aclarado, legible como texto sobre oscuro. */
          ice: '#5B8CFF',
          lime: '#A3E635',
        },
        brand: {
          DEFAULT: '#F03030',
          soft: '#FF8A80',
        },
        success: '#22C55E',
        warning: '#F59E0B',
        danger: '#EF4444',
      },
      fontFamily: {
        sans: ['Outfit', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Space Grotesk', 'Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(240, 48, 48, 0.5)',
        'glow-blue': '0 0 24px -4px rgba(48, 24, 240, 0.45)',
        card: '0 8px 30px -12px rgba(0, 0, 0, 0.7)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(to bottom, rgba(240,48,48,0.08), transparent 60%), radial-gradient(circle at 20% 0%, rgba(48,24,240,0.10), transparent 45%)',
        // Degradado principal: rojo de marca a rojo claro. Se mantiene dentro de
        // la misma familia porque mezclar el rojo con el azul del logotipo pasa
        // por magentas turbios en el punto medio.
        'brand-gradient': 'linear-gradient(135deg, #F03030 0%, #FF6A5F 100%)',
        /** Variante roja→azul, sólo para acentos puntuales. */
        'brand-gradient-alt': 'linear-gradient(135deg, #F03030 0%, #3018F0 140%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.35s ease-out',
        'slide-up': 'slideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-glow': 'pulseGlow 2.4s ease-in-out infinite',
        'spin-slow': 'spin 2.4s linear infinite',
        marquee: 'marquee 40s linear infinite',
        float: 'float 7s ease-in-out infinite',
        'gradient-x': 'gradientX 6s ease infinite',
        'border-spin': 'borderSpin 4s linear infinite',
        'scan-line': 'scanLine 3.5s ease-in-out infinite',
        'bounce-in': 'bounceIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-500px 0' },
          '100%': { backgroundPosition: '500px 0' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        // El ticker duplica su contenido, por eso desplaza exactamente la mitad.
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-18px) scale(1.04)' },
        },
        gradientX: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        borderSpin: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        scanLine: {
          '0%': { transform: 'translateY(-100%)', opacity: '0' },
          '35%': { opacity: '0.7' },
          '100%': { transform: 'translateY(320%)', opacity: '0' },
        },
        bounceIn: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      screens: {
        xs: '400px',
      },
    },
  },
  plugins: [],
};
