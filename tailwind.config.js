/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Satoshi"', '"Avenir Next"', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        panel: '0 24px 80px rgba(47, 48, 84, 0.18)',
        quiet: '0 10px 34px rgba(62, 70, 94, 0.12)'
      }
    }
  },
  plugins: []
};
