import { defineConfig } from "drizzle-kit";

// Only used to generate migrations (`npm run db:generate`); they are applied
// with `npm run db:migrate` through the Data API (scripts/migrate.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
