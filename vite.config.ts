import customMedia from "postcss-custom-media";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [customMedia()] } },
  build: {
    outDir: "dist/web",
  },
});
