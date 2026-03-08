/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
        fb: { blue: '#1877F2', dark: '#18191A', card: '#242526', hover: '#3A3B3C', text: '#E4E6EB', muted: '#B0B3B8' },
      },
    },
  },
  plugins: [],
};
