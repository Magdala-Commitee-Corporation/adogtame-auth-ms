import { RDSDataClient } from "@aws-sdk/client-rds-data";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import * as schema from "./schema.js";

/** Any Drizzle PostgreSQL database with this schema: Data API in AWS, PGlite in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, any>;

export interface DataApiConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
}

const RESUME_RETRIES = 8;
const RESUME_DELAY_MS = 2500;

/**
 * Drizzle over the Aurora Data API (adog_ARCH.md §3.6).
 * The cluster pauses at 0 ACU; while it resumes (about 15 s) the Data API
 * answers DatabaseResumingException, so every call is retried for up to
 * ~20 s, below the 30 s limit of the function.
 */
export const createDataApiDb = (config: DataApiConfig): Db => {
  const client = new RDSDataClient({});
  client.middlewareStack.add(
    (next) => async (args) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await next(args);
        } catch (error) {
          if ((error as Error).name !== "DatabaseResumingException" || attempt >= RESUME_RETRIES) throw error;
          await new Promise((resolve) => setTimeout(resolve, RESUME_DELAY_MS));
        }
      }
    },
    { step: "finalizeRequest", name: "retryWhileResuming" },
  );
  return drizzle(client, { ...config, schema }) as unknown as Db;
};

/** Reads the Data API settings from the environment, or undefined if the stage has no database. */
export const dataApiConfigFromEnv = (): DataApiConfig | undefined => {
  const { DB_RESOURCE_ARN, DB_SECRET_ARN, DB_NAME } = process.env;
  if (!DB_RESOURCE_ARN || !DB_SECRET_ARN) return undefined;
  return { resourceArn: DB_RESOURCE_ARN, secretArn: DB_SECRET_ARN, database: DB_NAME ?? "auth" };
};
