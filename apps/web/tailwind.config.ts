import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        surface: 'var(--surface-1)',
        plane: 'var(--plane)',
        ink: 'var(--text-primary)',
        ink2: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
        line: 'var(--line)',
        brand: 'var(--brand)',
      },
      fontFamily: { sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
