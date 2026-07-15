import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
        display: ['"Playfair Display"', "Georgia", "serif"],
        masthead: ['"Playfair Display"', "Georgia", "serif"],
        sans: ["-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"]
      },
      colors: {
        paper: "#f6f1e3",
        ink: "#1a1a1a",
        rule: "#1a1a1a",
        sepia: "#6b5b3e",
        journal: "#8b1a1a"
      }
    }
  },
  plugins: []
};

export default config;
