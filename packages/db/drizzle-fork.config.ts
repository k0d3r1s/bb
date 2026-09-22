import { defineConfig } from "drizzle-kit";
import baseConfig from "./drizzle.config";

export default defineConfig({
  ...baseConfig,
  schema: "./src/schema.fork.ts",
  out: "./drizzle-fork",
});
