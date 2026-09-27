import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env["VITE_API_TARGET"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  appType: "spa",
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
      routesDirectory: "./src/workflow-routes",
      target: "react",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
