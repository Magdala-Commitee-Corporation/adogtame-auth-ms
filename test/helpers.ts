import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { seed } from "../src/db/seed.js";
import type { Evento } from "../src/lib/outbox.js";

export const ADMIN_KEY = "test-admin-key";

/** In-process PostgreSQL (PGlite) with the real migrations and seed: no Docker, no AWS. */
export const createTestDb = async (): Promise<Db> => {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seed(db as unknown as Db);
  return db as unknown as Db;
};

export const createTestApp = async () => {
  const db = await createTestDb();
  const published: Evento[] = [];
  let failPublish = false;
  const app = createApp({
    db,
    adminKey: ADMIN_KEY,
    stage: "test",
    publish: async (evento) => {
      if (failPublish) throw new Error("SNS down");
      published.push(evento);
    },
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-admin-key": ADMIN_KEY }) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, db, call, published, setFailPublish: (v: boolean) => (failPublish = v) };
};

export const persona = (extra: Record<string, unknown> = {}) => ({
  nombre: "Ana Pérez",
  telefono: "0991234567",
  fechaNacimiento: "1995-05-10",
  ...extra,
});
