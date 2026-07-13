import { defineConfig } from "vite";

// Vite 配置:开发端口需与 tauri.conf.json 的 devUrl 一致(5173)。
export default defineConfig({
  // Tauri 期望前端产物落在 dist/(对应 tauri.conf.json 的 frontendDist)。
  build: {
    outDir: "dist",
    target: "esnext",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // 避免 Vite 清屏,方便看 Rust 侧日志。
  clearScreen: false,
});
