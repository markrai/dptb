/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./spousal.html",
    "./*.html",
    "./*.js"
  ],
  theme: {
    extend: {
      colors: {
        // Custom color palette matching your design
        'dark-bg': '#0b1020',
        'dark-card': '#111735',
        'dark-card-alt': '#1a2349',
        'dark-border': '#1a2349',
        'dark-border-alt': '#263266',
        'text-primary': '#e6eaf3',
        'text-secondary': '#a9b3d8',
        'text-muted': '#9aa5c6',
        'accent-blue': '#4a90e2',
        'accent-yellow': '#ffcc66',
        'accent-green': '#4CAF50',
        'accent-red': '#ff6b6b',
        'success': '#7bffbf',
        'error': '#ff9b9b',
      },
      fontFamily: {
        'sans': ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        'racing': ['Racing Sans One', 'cursive'],
      },
      screens: {
        // Custom breakpoints
        'portrait-monitor': {'raw': '(orientation: portrait) and (hover: hover) and (pointer: fine)'},
        'mobile': {'max': '768px'},
        'multigrain-quarter': {'max': '400px'},
      },
    },
  },
  plugins: [],
}

