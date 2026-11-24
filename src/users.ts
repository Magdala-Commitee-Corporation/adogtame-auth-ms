/**
 * Accounts, roles and profiles (adog_MS.md §3). Functional style: each
 * function receives the database and controls its own transaction.
 */
import { and, asc, eq, ilike, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { type CodigoRol, ROLES, persona, refugio, rol, usuario, usuarioRol } from "./db/schema.js";
import { ApiError, isUniqueViolation, noEncontrado } from "./lib/errors.js";
import { enqueue } from "./lib/outbox.js";

// ---------- Validation (RNF-21) ----------

const CODIGOS_ROL = ROLES.map((r) => r.codigo) as [CodigoRol, ...CodigoRol[]];
const telefono = z.string().regex(/^09\d{8}$/, "El teléfono debe tener 10 dígitos e iniciar con 09.");
const texto = (max: number) => z.string().trim().min(1).max(max);
const opcional = (max: number) => z.string().trim().max(max).nullish();

const edadEnAnios = (fecha: string, hoy = new Date()) => {
  const nacimiento = new Date(`${fecha}T00:00:00Z`);
  let edad = hoy.getUTCFullYear() - nacimiento.getUTCFullYear();
  const mes = hoy.getUTCMonth() - nacimiento.getUTCMonth();
  if (mes < 0 || (mes === 0 && hoy.getUTCDate() < nacimiento.getUTCDate())) edad--;
  return edad;
};

const datosPersona = z.object({
  nombre: texto(120),
  telefono,
  fechaNacimiento: z.iso.date().refine((f) => edadEnAnios(f) >= 18, "Debe ser mayor de 18 años."),
  descripcion: opcional(500),
  fotoPerfilUrl: opcional(255),
});

const datosRefugio = z.object({
  nombreInstitucion: texto(120),
  ubicacion: texto(255),
  telefono,
  descripcion: opcional(500),
  fotoPerfilUrl: opcional(255),
  fechaCreacion: z.iso
    .date()
    .refine((f) => new Date(`${f}T00:00:00Z`) <= new Date(), "La fecha de creación no puede ser futura.")
    .nullish(),
  paginaWeb: z
    .string()
    .trim()
    .max(255)
    .regex(/^https?:\/\//, "La página web debe iniciar con http o https.")
    .nullish(),
});

export const crearUsuarioSchema = z
  .object({
    correo: z.string().trim().toLowerCase().pipe(z.email().max(120)),
    rol: z.enum(CODIGOS_ROL),
    persona: datosPersona.optional(),
    refugio: datosRefugio.optional(),
  })
  .strict()
  .refine((d) => (d.rol === "REFUGIO" ? d.refugio && !d.persona : d.persona && !d.refugio), {
    message: "El perfil no corresponde al rol: REFUGIO lleva `refugio`; los demás roles llevan `persona`.",
  });

// Email, password and role are not editable here (RF-27).
export const editarUsuarioSchema = z
  .object({
    persona: datosPersona.partial().strict().optional(),
    refugio: datosRefugio.partial().strict().optional(),
  })
  .strict()
  .refine((d) => !(d.persona && d.refugio), { message: "Envía solo `persona` o solo `refugio`." });

export type CrearUsuario = z.infer<typeof crearUsuarioSchema>;
export type EditarUsuario = z.infer<typeof editarUsuarioSchema>;

// ---------- Queries ----------

const ROL_POR_CODIGO = Object.fromEntries(ROLES.map((r) => [r.codigo, r.idRol])) as Record<CodigoRol, number>;
const ID_ADMIN = ROL_POR_CODIGO.ADMINISTRADOR;

const seleccion = {
  usuario: {
    idUsuario: usuario.idUsuario,
    correo: usuario.correo,
    correoConfirmado: usuario.correoConfirmado,
    eliminado: usuario.eliminado,
    fechaEliminacion: usuario.fechaEliminacion,
    fechaRegistro: usuario.fechaRegistro,
  },
  rol: { codigo: rol.codigo, nombre: rol.nombre, fechaAsignacion: usuarioRol.fechaAsignacion },
  persona,
  refugio,
};

const consultaBase = (db: Db) =>
  db
    .select(seleccion)
    .from(usuario)
    .innerJoin(usuarioRol, eq(usuarioRol.idUsuario, usuario.idUsuario))
    .innerJoin(rol, eq(rol.idRol, usuarioRol.idRol))
    .leftJoin(persona, eq(persona.idUsuario, usuario.idUsuario))
    .leftJoin(refugio, eq(refugio.idUsuario, usuario.idUsuario));

type Fila = Awaited<ReturnType<ReturnType<typeof consultaBase>["execute"]>>[number];

const aRespuesta = ({ usuario: u, rol: r, persona: p, refugio: f }: Fila) => ({
  ...u,
  rol: r,
  perfil: p
    ? { tipo: "persona" as const, ...omitir(p, "idUsuario") }
    : f
      ? { tipo: "refugio" as const, ...omitir(f, "idUsuario") }
      : null,
});

const omitir = <T extends object, K extends keyof T>(obj: T, clave: K): Omit<T, K> => {
  const { [clave]: _, ...resto } = obj;
  return resto;
};

export type Usuario = ReturnType<typeof aRespuesta>;

export const listarRoles = (db: Db) => db.select().from(rol).orderBy(asc(rol.idRol));

export const obtenerUsuario = async (db: Db, idUsuario: string): Promise<Usuario> => {
  if (!z.uuid().safeParse(idUsuario).success) throw noEncontrado();
  const [fila] = await consultaBase(db).where(eq(usuario.idUsuario, idUsuario));
  if (!fila) throw noEncontrado();
  return aRespuesta(fila);
};

export interface FiltroUsuarios {
  rol?: CodigoRol;
  q?: string;
  incluirEliminados?: boolean;
}

export const listarUsuarios = async (db: Db, filtro: FiltroUsuarios = {}) => {
  const condiciones = [
    filtro.rol ? eq(rol.codigo, filtro.rol) : undefined,
    filtro.incluirEliminados ? undefined : eq(usuario.eliminado, false),
    filtro.q
      ? or(
          ilike(usuario.correo, `%${filtro.q}%`),
          ilike(persona.nombre, `%${filtro.q}%`),
          ilike(refugio.nombreInstitucion, `%${filtro.q}%`),
        )
      : undefined,
  ];
  const filas = await consultaBase(db)
    .where(and(...condiciones))
    .orderBy(asc(usuario.fechaRegistro))
    .limit(100);
  return filas.map(aRespuesta);
};

// ---------- Commands ----------

const correoEnUso = () => new ApiError(409, "CORREO_EN_USO", "El correo ya pertenece a una cuenta.");

/**
 * Creates the account, its role and its profile in one transaction (RF-26).
 * The account has no password yet; it is defined with the email link (RN-13).
 */
export const crearUsuario = async (db: Db, datos: CrearUsuario): Promise<Usuario> => {
  try {
    const idUsuario = await db.transaction(async (tx) => {
      const [creado] = await tx.insert(usuario).values({ correo: datos.correo }).returning({ id: usuario.idUsuario });
      await tx.insert(usuarioRol).values({ idUsuario: creado.id, idRol: ROL_POR_CODIGO[datos.rol] });
      if (datos.persona) await tx.insert(persona).values({ ...datos.persona, idUsuario: creado.id });
      if (datos.refugio) await tx.insert(refugio).values({ ...datos.refugio, idUsuario: creado.id });
      return creado.id;
    });
    return obtenerUsuario(db, idUsuario);
  } catch (error) {
    if (isUniqueViolation(error)) throw correoEnUso();
    throw error;
  }
};

export const editarUsuario = async (db: Db, idUsuario: string, cambios: EditarUsuario): Promise<Usuario> => {
  const actual = await obtenerUsuario(db, idUsuario);
  const tipo = actual.perfil?.tipo;
  if ((cambios.persona && tipo !== "persona") || (cambios.refugio && tipo !== "refugio")) {
    throw new ApiError(400, "VALIDACION", "El perfil no corresponde al tipo de cuenta.");
  }
  if (cambios.persona && Object.keys(cambios.persona).length) {
    await db.update(persona).set(cambios.persona).where(eq(persona.idUsuario, idUsuario));
  }
  if (cambios.refugio && Object.keys(cambios.refugio).length) {
    await db.update(refugio).set(cambios.refugio).where(eq(refugio.idUsuario, idUsuario));
  }
  return obtenerUsuario(db, idUsuario);
};

/**
 * Logical deletion (RF-28, RNF-10). Never leaves the system without an
 * active administrator (RN-11): the active administrators are locked inside
 * the transaction so two simultaneous deletions cannot both pass.
 * Publishes `CuentaEliminada` through the outbox.
 */
export const eliminarUsuario = async (db: Db, idUsuario: string): Promise<Usuario> => {
  const actual = await obtenerUsuario(db, idUsuario);
  if (actual.eliminado) throw noEncontrado();

  await db.transaction(async (tx) => {
    if (actual.rol.codigo === "ADMINISTRADOR") {
      const otros = await tx
        .select({ id: usuario.idUsuario })
        .from(usuario)
        .innerJoin(usuarioRol, eq(usuarioRol.idUsuario, usuario.idUsuario))
        .where(and(eq(usuarioRol.idRol, ID_ADMIN), eq(usuario.eliminado, false), ne(usuario.idUsuario, idUsuario)))
        .for("update", { of: usuario });
      if (otros.length === 0) {
        throw new ApiError(409, "ULTIMO_ADMINISTRADOR", "No se puede eliminar al único administrador activo.");
      }
    }
    const fecha = new Date();
    await tx
      .update(usuario)
      .set({ eliminado: true, fechaEliminacion: fecha })
      .where(and(eq(usuario.idUsuario, idUsuario), eq(usuario.eliminado, false)));
    await enqueue(tx, "CuentaEliminada", { idUsuario, fechaCambio: fecha.toISOString() });
  });
  return obtenerUsuario(db, idUsuario);
};

/** Restores a deleted account (RF-28) and publishes `CuentaRestaurada`. */
export const restaurarUsuario = async (db: Db, idUsuario: string): Promise<Usuario> => {
  const actual = await obtenerUsuario(db, idUsuario);
  if (!actual.eliminado) return actual;
  await db.transaction(async (tx) => {
    await tx
      .update(usuario)
      .set({ eliminado: false, fechaEliminacion: null })
      .where(eq(usuario.idUsuario, idUsuario));
    await enqueue(tx, "CuentaRestaurada", { idUsuario, fechaCambio: new Date().toISOString() });
  });
  return obtenerUsuario(db, idUsuario);
};
