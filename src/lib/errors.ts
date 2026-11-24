/** Error contract shared by the services: a code and a message in Spanish (adog_ARCH.md §4.5). */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export const noEncontrado = () => new ApiError(404, "NO_ENCONTRADO", "El recurso no existe.");

export const dependenciaNoDisponible = () =>
  new ApiError(503, "DEPENDENCIA_NO_DISPONIBLE", "El servicio no está disponible en este momento. Intenta de nuevo.");

type Wrapped = { code?: unknown; cause?: unknown; message?: unknown; name?: unknown } | undefined;

/** PostgreSQL error code, looking through Drizzle and Data API wrappers. */
const pgCode = (error: unknown): string | undefined => {
  for (let e = error as Wrapped; e; e = e.cause as Wrapped) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    // The Data API only returns the PostgreSQL message.
    if (typeof e.message === "string" && e.message.includes("duplicate key value violates unique constraint")) return "23505";
  }
  return undefined;
};

export const isUniqueViolation = (error: unknown) => pgCode(error) === "23505";

/** True when the Data API could not reach the database (still resuming, throttled, etc.). */
export const isDatabaseUnavailable = (error: unknown) => {
  for (let e = error as Wrapped; e; e = e.cause as Wrapped) {
    if (["DatabaseResumingException", "DatabaseUnavailableException", "ServiceUnavailableError"].includes(e.name as string))
      return true;
  }
  return false;
};
