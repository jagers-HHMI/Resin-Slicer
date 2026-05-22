const { defineConfig } = require("vite");

module.exports = defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
