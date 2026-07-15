import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
        sans: ["-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"]
      },
      colors: {
        paper: "#faf7f0",
        ink: "#1a1a1a",
        rule: "#1a1a1a"
      }
    }
  },
  plugins: []
};

export default config;
