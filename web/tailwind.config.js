/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        // 极简克制配色：主色 1（深蓝，仅用于结构与标题）+ 状态色（固定四色，见 src/types.ts）
        brand: { DEFAULT: '#1F3A5F', light: '#33557F', bg: '#F7F8FA' },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
