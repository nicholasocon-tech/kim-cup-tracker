/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Augusta heritage palette: pine green, warm cream, antique gold.
        cream: { DEFAULT: '#FAF6EC', 50: '#FCFAF3', 100: '#F5EEDC', 200: '#ECE1C6' },
        pine: {
          50: '#EAF3ED', 100: '#CFE3D6', 200: '#A6CDB4',
          600: '#15693F', 700: '#0F5132', 800: '#0B3F28', 900: '#08311F',
        },
        gold: { 50: '#FBF5E1', 100: '#F3E6BB', 300: '#E0C77E', 500: '#C8A24A', 600: '#A9863A', 700: '#876A2C' },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
