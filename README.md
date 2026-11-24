# adogtame-auth-ms

Microservicio `Auth` de Adogtame. Función AWS Lambda en TypeScript detrás de su propia API HTTP de API Gateway, desplegada con SST v4.

Documentación del servicio: [`adog_MS.md`](https://github.com/Magdala-Commitee-Corporation/adogtame-docs/blob/main/agent/instruments/adog_MS.md).

## Ambientes

| Stage | API directa | Por CloudFront |
|---|---|---|
| `dev` | https://auth-api.dev.adogtame.vieerr.xyz | https://dev.adogtame.vieerr.xyz/api/auth |
| `prod` | https://auth-api.adogtame.vieerr.xyz | https://adogtame.vieerr.xyz/api/auth |

La API limita el tráfico a 50 peticiones por segundo con ráfagas de 100 y responde 429 al exceder (RNF-23).

## Datos

- **PostgreSQL** (base `auth` en el cluster de Aurora de `adogtame-infra`): `usuario`, `rol`, `usuario_rol`, `persona`, `refugio` y `outbox`. El esquema está en `src/db/schema.ts` y las migraciones en `drizzle/`. Acceso con Drizzle por la Data API, sin VPC. El cluster se pausa a los 5 minutos sin uso; la primera petición después tarda unos 15 s más.
- **DynamoDB** (tabla `Sessions`): sesiones y enlaces de correo por hash, con TTL en `expiraEn`.
- Hoy solo la etapa `dev` tiene base. En `prod`, las rutas que la usan responden `503 DEPENDENCIA_NO_DISPONIBLE`.

Detalle en `adog_MS.md` §3.2.

## API

| Método y ruta | Descripción |
|---|---|
| `GET /health` | Estado del servicio y si tiene base configurada. |
| `GET /roles` | Catálogo de los 4 roles. |
| `GET /users?rol=&q=&incluirEliminados=` | Lista usuarios con su rol y perfil. |
| `POST /users` | Crea usuario, rol y perfil (persona o refugio) en una transacción. |
| `GET /users/{id}` | Obtiene un usuario. |
| `PATCH /users/{id}` | Edita el perfil (no correo, contraseña ni rol). |
| `DELETE /users/{id}` | Borrado lógico; nunca deja el sistema sin administradores. Publica `CuentaEliminada`. |
| `POST /users/{id}/restore` | Restaura la cuenta. Publica `CuentaRestaurada`. |

Las rutas de `/users` exigen la cabecera `x-admin-key` mientras no exista el autorizador de sesión (ADO-18). La clave es un secreto de SST:

```bash
npx sst secret set AdminApiKey "<clave larga>" --stage dev
```

Sin clave, esas rutas responden 403.

## Uso

```bash
npm install
npm test             # pruebas con PGlite: sin Docker ni AWS
npm run dev          # sst dev: funciones locales contra los recursos de dev
npm run deploy:dev
npm run deploy:prod
```

Base de datos (después de `npm run db:bootstrap -- dev` en `adogtame-infra`):

```bash
npm run db:generate          # nueva migración tras cambiar src/db/schema.ts
npm run db:migrate -- dev    # aplica las migraciones
npm run db:seed -- dev       # carga los roles
```

Requiere el perfil de AWS `bier-personal`.

## Ramas

`main` (producción), `dev` (integración) y `testing` (pruebas).

## Eventos

Una cola SQS (`Events`) suscrita a los temas de `adogtame-infra` con filtro por tipo de evento, y una cola de mensajes fallidos (`EventsDlq`) tras 5 intentos. El consumidor (`src/handlers/events.ts`) tiene un límite de 60 s. Detalle de los eventos en `adog_MS.md` §7.
