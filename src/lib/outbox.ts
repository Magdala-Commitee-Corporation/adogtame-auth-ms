import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { outbox } from "../db/schema.js";

export type TipoEvento = "CuentaEliminada" | "CuentaRestaurada" | "CorreoSolicitado";

export interface Evento {
  idEvento: string;
  tipo: string;
  fechaCambio: string;
  datos: unknown;
}

/** Publishes one event; resolves when the broker accepted it. */
export type Publisher = (evento: Evento) => Promise<void>;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Saves an event in the same transaction as the change (outbox pattern, adog_ARCH.md §4.2). */
export const enqueue = (tx: Tx, tipo: TipoEvento, datos: Record<string, unknown>) =>
  tx.insert(outbox).values({ tipo, datos });

const MAX_PER_INVOCATION = 10;

/**
 * Publishes pending events, oldest first. Runs at the end of every request
 * that used the database, so a failed publish is retried by the next request
 * without a scheduled job that would wake the paused cluster.
 * Delivery is at least once: consumers are idempotent.
 */
export const publishPending = async (db: Db, publish: Publisher): Promise<number> => {
  const pendientes = await db
    .select()
    .from(outbox)
    .where(isNull(outbox.fechaEnvio))
    .orderBy(asc(outbox.fechaCambio))
    .limit(MAX_PER_INVOCATION);

  let enviados = 0;
  for (const evento of pendientes) {
    try {
      await publish({
        idEvento: evento.idEvento,
        tipo: evento.tipo,
        fechaCambio: new Date(evento.fechaCambio).toISOString(),
        datos: evento.datos,
      });
    } catch (error) {
      console.error(
        JSON.stringify({ service: "auth", outbox: "publish-failed", idEvento: evento.idEvento, error: String(error) }),
      );
      break; // keep the order; the next request retries
    }
    await db.update(outbox).set({ fechaEnvio: new Date() }).where(eq(outbox.idEvento, evento.idEvento));
    enviados++;
  }
  return enviados;
};
