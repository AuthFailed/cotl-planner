import { defineConfig } from "vite";

// Served from https://<user>.github.io/cotl-planner/; data/ is fetched with relative URLs.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
