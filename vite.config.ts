import { defineConfig } from "vite";

// Served from https://map.cotl.info/ (the github.io address redirects there); data/ is fetched with relative URLs.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
