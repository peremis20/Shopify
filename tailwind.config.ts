import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: {
          DEFAULT: "#FBF3E6",
          50: "#FDF9F1",
          100: "#FBF3E6",
          200: "#F6EAD6",
        },
        brand: {
          green: "#16442B",
          "green-mid": "#1E7A46",
          "green-light": "#2E9E5B",
          orange: "#F5871E",
          "orange-dark": "#F26B0F",
          "orange-soft": "#FCE9CF",
        },
        ink: {
          DEFAULT: "#3F3B36",
          muted: "#7A736B",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        script: ["var(--font-script)", "cursive"],
      },
      boxShadow: {
        card: "0 10px 30px -12px rgba(22, 68, 43, 0.18)",
        "card-hover": "0 18px 40px -14px rgba(22, 68, 43, 0.28)",
        soft: "0 6px 20px -10px rgba(0,0,0,0.15)",
      },
      borderRadius: {
        xl2: "1.25rem",
      },
    },
  },
  plugins: [],
};

export default config;
