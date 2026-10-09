/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Yoga-retreat palette
        paper: "#F4F2EE", // page background
        linen: "#FBFAF8", // cards
        mist: "#E0E4E8",
        sand: "#DDD3C0",
        taupe: "#BBA28B",
        dusty: "#B3C3CE",
        slate: "#4A4F5C",
        ink: "#3B3F49", // primary text
        stone: "#8B8D92", // secondary text
        // Form status (tuned for light backgrounds)
        good: "#5F829A",
        warn: "#B98B4E",
        bad: "#B35A4B",
        done: "#6F927A",
      },
      fontFamily: {
        display: ["var(--font-cormorant)", "Georgia", "serif"],
        sans: ["var(--font-jost)", "system-ui", "sans-serif"],
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(18px)" }, to: { opacity: "1", transform: "none" } },
        "fade-in": { from: { opacity: "0", transform: "scale(0.96)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        "fade-up": "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) both",
        "fade-in": "fade-in 0.6s ease-out both",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(59,63,73,0.04), 0 12px 32px -12px rgba(59,63,73,0.12)",
      },
    },
  },
  plugins: [],
};
