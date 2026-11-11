import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  publicDir: "../web/public",
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/avatars": { target: "http://localhost:8787" },
    },
  },
});
