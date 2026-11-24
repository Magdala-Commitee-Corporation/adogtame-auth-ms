/**
 * Relational schema of the `auth` database (adog_MER.md §4, adog_MS.md §3.2).
 * Foreign keys only point to tables of this same database.
 * Sessions and email tokens live in DynamoDB (table `auth-sessions`).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const usuario = pgTable(
  "usuario",
  {
    idUsuario: uuid("id_usuario").primaryKey().defaultRandom(),
    correo: varchar("correo", { length: 120 }).notNull(),
    contrasenaHash: varchar("contrasena_hash", { length: 255 }),
    correoConfirmado: boolean("correo_confirmado").notNull().default(false),
    eliminado: boolean("eliminado").notNull().default(false),
    fechaEliminacion: timestamp("fecha_eliminacion", { withTimezone: true }),
    fechaRegistro: timestamp("fecha_registro", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An email is never reused, not even after the account is deleted (RN-07).
    uniqueIndex("usuario_correo_uk").on(sql`lower(${t.correo})`),
  ],
);

export const rol = pgTable("rol", {
  idRol: smallint("id_rol").primaryKey(),
  codigo: varchar("codigo", { length: 20 }).notNull().unique(),
  nombre: varchar("nombre", { length: 50 }).notNull(),
});

export const usuarioRol = pgTable(
  "usuario_rol",
  {
    idUsuario: uuid("id_usuario")
      .notNull()
      .references(() => usuario.idUsuario),
    idRol: smallint("id_rol")
      .notNull()
      .references(() => rol.idRol),
    fechaAsignacion: timestamp("fecha_asignacion", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.idUsuario, t.idRol] }),
    // Exactly one role per user, enforced by the database.
    unique("usuario_rol_usuario_uk").on(t.idUsuario),
    index("usuario_rol_rol_idx").on(t.idRol),
  ],
);

const TELEFONO = sql`'^09[0-9]{8}$'`;

export const persona = pgTable(
  "persona",
  {
    idPersona: uuid("id_persona").primaryKey().defaultRandom(),
    idUsuario: uuid("id_usuario")
      .notNull()
      .unique()
      .references(() => usuario.idUsuario),
    nombre: varchar("nombre", { length: 120 }).notNull(),
    telefono: varchar("telefono", { length: 10 }).notNull(),
    fotoPerfilUrl: varchar("foto_perfil_url", { length: 255 }),
    descripcion: varchar("descripcion", { length: 500 }),
    // The 18+ rule is checked by the service: a CHECK using the current
    // date would not be deterministic.
    fechaNacimiento: date("fecha_nacimiento").notNull(),
  },
  (t) => [check("persona_telefono_ck", sql`${t.telefono} ~ ${TELEFONO}`)],
);

export const refugio = pgTable(
  "refugio",
  {
    idRefugio: uuid("id_refugio").primaryKey().defaultRandom(),
    idUsuario: uuid("id_usuario")
      .notNull()
      .unique()
      .references(() => usuario.idUsuario),
    nombreInstitucion: varchar("nombre_institucion", { length: 120 }).notNull(),
    ubicacion: varchar("ubicacion", { length: 255 }).notNull(),
    telefono: varchar("telefono", { length: 10 }).notNull(),
    fotoPerfilUrl: varchar("foto_perfil_url", { length: 255 }),
    descripcion: varchar("descripcion", { length: 500 }),
    fechaCreacion: date("fecha_creacion"),
    paginaWeb: varchar("pagina_web", { length: 255 }),
  },
  (t) => [
    check("refugio_telefono_ck", sql`${t.telefono} ~ ${TELEFONO}`),
    check("refugio_pagina_web_ck", sql`${t.paginaWeb} IS NULL OR ${t.paginaWeb} ~ '^https?://'`),
  ],
);

/** Events waiting to be published to SNS (adog_ARCH.md §4.2). */
export const outbox = pgTable(
  "outbox",
  {
    idEvento: uuid("id_evento").primaryKey().defaultRandom(),
    tipo: varchar("tipo", { length: 50 }).notNull(),
    datos: jsonb("datos").notNull(),
    fechaCambio: timestamp("fecha_cambio", { withTimezone: true }).notNull().defaultNow(),
    fechaEnvio: timestamp("fecha_envio", { withTimezone: true }),
  },
  (t) => [index("outbox_pendientes_idx").on(t.fechaCambio).where(sql`${t.fechaEnvio} IS NULL`)],
);

/** Fixed role catalog (adog_MER.md §4). Loaded by the seed and by the tests. */
export const ROLES = [
  { idRol: 1, codigo: "MIEMBRO", nombre: "Miembro" },
  { idRol: 2, codigo: "RESCATISTA", nombre: "Rescatista" },
  { idRol: 3, codigo: "REFUGIO", nombre: "Refugio" },
  { idRol: 4, codigo: "ADMINISTRADOR", nombre: "Administrador" },
] as const;

export type CodigoRol = (typeof ROLES)[number]["codigo"];
