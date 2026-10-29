import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.SMYS_API_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
