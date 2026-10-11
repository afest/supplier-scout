import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" — сборка открывается и с GitHub Pages (подпуть /supplier-scout/), и локально.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // host 127.0.0.1: по умолчанию Vite слушает только [::1], и браузер или VPN, который ведёт localhost на IPv4, не достучится
  server: { host: "127.0.0.1", port: 5173, fs: { allow: [".."] } },
  // набор поставщиков встраивается в бандл целиком (~400 КБ JSON, 120 КБ в gzip) — для 50 записей это осознанно
  build: { chunkSizeWarningLimit: 800 },
});
