/**
 * HTTP API of the Auth service. One Hono app inside one Lambda function;
 * the same app runs in tests against PGlite (app.request()).
 *
 * The administration routes (RF-26 to RF-28) are protected with a temporary
 * `x-admin-key` header until the session authorizer exists (I0.7, ADO-18).
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { type CodigoRol, ROLES } from "./db/schema.js";
import { ApiError, dependenciaNoDisponible, isDatabaseUnavailable } from "./lib/errors.js";
import { type Publisher, publishPending } from "./lib/outbox.js";
import {
  crearUsuario,
  crearUsuarioSchema,
  editarUsuario,
  editarUsuarioSchema,
  eliminarUsuario,
  listarRoles,
  listarUsuarios,
  obtenerUsuario,
  restaurarUsuario,
} from "./users.js";

export interface AppDeps {
  /** Undefined when the stage has no database (adog_ARCH.md §3.6). */
  db?: Db;
  /** Publishes outbox events to SNS. Undefined disables publishing. */
  publish?: Publisher;
  /** Temporary key for the administration routes. Empty disables them. */
  adminKey?: string;
  stage?: string;
}

type Env = { Variables: { db: Db } };

const filtroUsuarios = z.object({
  rol: z.enum(ROLES.map((r) => r.codigo) as [CodigoRol, ...CodigoRol[]]).optional(),
  q: z.string().trim().max(120).optional(),
  incluirEliminados: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const igualSeguro = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const createApp = (deps: AppDeps) => {
  const app = new Hono<Env>();

  /** Requires the database and, after the request, publishes pending outbox events (adog_ARCH.md §4.2). */
  const conBase: MiddlewareHandler<Env> = async (c, next) => {
    if (!deps.db) throw dependenciaNoDisponible();
    c.set("db", deps.db);
    await next();
    if (deps.publish) {
      await publishPending(deps.db, deps.publish).catch((error) =>
        console.error(JSON.stringify({ service: "auth", outbox: "flush-failed", error: String(error) })),
      );
    }
  };

  const soloAdministrador: MiddlewareHandler<Env> = async (c, next) => {
    const clave = c.req.header("x-admin-key") ?? "";
    if (!deps.adminKey || !igualSeguro(clave, deps.adminKey)) {
      throw new ApiError(403, "PROHIBIDO", "No tienes permiso para realizar esta acción.");
    }
    await next();
  };

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ codigo: error.codigo, mensaje: error.message }, error.status);
    }
    if (error instanceof z.ZodError) {
      return c.json(
        {
          codigo: "VALIDACION",
          mensaje: "Los datos enviados no son válidos.",
          detalles: error.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message })),
        },
        400,
      );
    }
    if (isDatabaseUnavailable(error)) {
      const e = dependenciaNoDisponible();
      return c.json({ codigo: e.codigo, mensaje: e.message }, e.status);
    }
    console.error(JSON.stringify({ service: "auth", error: String(error), stack: (error as Error).stack }));
    return c.json({ codigo: "ERROR_INTERNO", mensaje: "Ocurrió un error inesperado." }, 500);
  });

  app.notFound((c) => c.json({ codigo: "NO_ENCONTRADO", mensaje: "El recurso no existe." }, 404));

  app.get("/health", (c) =>
    c.json({ service: "auth", stage: deps.stage ?? "unknown", status: "ok", database: deps.db ? "configured" : "none" }),
  );

  const leerJson = async (c: { req: { json: () => Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      throw new ApiError(400, "VALIDACION", "El cuerpo de la petición debe ser JSON.");
    }
  };

  // Role catalog (public, read-only: the four roles are fixed).
  app.get("/roles", conBase, async (c) => c.json(await listarRoles(c.var.db)));

  // Administration of users (RF-26, RF-27, RF-28).
  const users = new Hono<Env>();
  users.use(soloAdministrador, conBase);
  users.get("/", async (c) => c.json(await listarUsuarios(c.var.db, filtroUsuarios.parse(c.req.query()))));
  users.post("/", async (c) => c.json(await crearUsuario(c.var.db, crearUsuarioSchema.parse(await leerJson(c))), 201));
  users.get("/:id", async (c) => c.json(await obtenerUsuario(c.var.db, c.req.param("id"))));
  users.patch("/:id", async (c) =>
    c.json(await editarUsuario(c.var.db, c.req.param("id"), editarUsuarioSchema.parse(await leerJson(c)))),
  );
  users.delete("/:id", async (c) => c.json(await eliminarUsuario(c.var.db, c.req.param("id"))));
  users.post("/:id/restore", async (c) => c.json(await restaurarUsuario(c.var.db, c.req.param("id"))));
  app.route("/users", users);

  return app;
};
