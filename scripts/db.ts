/**
 * Applies the migrations and the seed to the `auth` database through the
 * Data API (ADO-14). Safe to run more than once.
 *
 *   npm run db:migrate -- dev
 *   npm run db:seed -- dev
 *
 * The database must exist first: `npm run db:bootstrap -- <stage>` in adogtame-infra.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { migrate } from "drizzle-orm/aws-data-api/pg/migrator";
import { createDataApiDb } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

const [command, stage] = process.argv.slice(2);
if (!["migrate", "seed"].includes(command) || !stage) {
  console.error("Usage: npm run db:migrate -- <stage> | npm run db:seed -- <stage>");
  process.exit(1);
}

const ssm = new SSMClient({ region: "us-east-1" });
const param = async (name: string) =>
  (await ssm.send(new GetParameterCommand({ Name: `/adogtame/${stage}/db/${name}` }))).Parameter!.Value!;

const db = createDataApiDb({
  resourceArn: await param("cluster-arn"),
  secretArn: await param("secret-arn"),
  database: "auth",
});

if (command === "migrate") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: "./drizzle" });
  console.log(`Migrations applied to "auth" (${stage})`);
} else {
  await seed(db);
  console.log(`Seed applied to "auth" (${stage})`);
}
