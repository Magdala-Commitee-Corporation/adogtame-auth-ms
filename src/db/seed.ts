import type { Db } from "./client.js";
import { ROLES, rol } from "./schema.js";

/** Loads the fixed role catalog. Idempotent: existing roles get their name updated. */
export const seed = async (db: Db) => {
  for (const r of ROLES) {
    await db.insert(rol).values(r).onConflictDoUpdate({ target: rol.idRol, set: { codigo: r.codigo, nombre: r.nombre } });
  }
};
