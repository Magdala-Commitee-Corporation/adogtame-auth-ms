/// <reference path="./.sst/platform/config.d.ts" />

const ROOT_DOMAIN = "vieerr.xyz";
const SERVICE = "auth";

export default $config({
  app(input) {
    return {
      name: "adogtame-auth",
      removal: input?.stage === "prod" ? "retain" : "remove",
      protect: input?.stage === "prod",
      home: "aws",
      providers: {
        aws: { profile: "bier-personal", region: "us-east-1" },
      },
    };
  },
  async run() {
    const isProd = $app.stage === "prod";
    const base = isProd ? `adogtame.${ROOT_DOMAIN}` : `${$app.stage}.adogtame.${ROOT_DOMAIN}`;

    const api = new sst.aws.ApiGatewayV2("Api", {
      domain: { name: `${SERVICE}-api.${base}`, dns: sst.aws.dns() },
      transform: {
        // RNF-23: 50 requests/s with bursts of 100; API Gateway answers 429 above that.
        stage: (args) => {
          args.defaultRouteSettings = {
            ...args.defaultRouteSettings,
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
          };
        },
      },
    });

    const topicArn = (publisher: string) =>
      aws.ssm.getParameterOutput({
        name: `/adogtame/${$app.stage}/topics/${publisher}-events-arn`,
      }).value;

    // Aurora cluster from adogtame-infra, only in the stages that have it
    // (adog_ARCH.md §3.6). Without it the API answers DEPENDENCIA_NO_DISPONIBLE.
    const dbParams = await aws.ssm.getParametersByPath({ path: `/adogtame/${$app.stage}/db`, withDecryption: false });
    const dbParam = (name: string) => dbParams.values[dbParams.names.indexOf(`/adogtame/${$app.stage}/db/${name}`)];
    const db = dbParams.names.length ? { clusterArn: dbParam("cluster-arn"), secretArn: dbParam("secret-arn") } : undefined;

    // Sessions and email tokens (adog_MS.md §3.2): looked up by hash, cleaned by TTL.
    const sessions = new sst.aws.Dynamo("Sessions", {
      fields: { pk: "string", idUsuario: "string", tipoFecha: "string" },
      primaryIndex: { hashKey: "pk" },
      globalIndexes: { PorUsuario: { hashKey: "idUsuario", rangeKey: "tipoFecha" } },
      ttl: "expiraEn",
    });

    // Temporary key for the administration routes until the session
    // authorizer exists (ADO-18). Empty keeps them closed.
    const adminApiKey = new sst.Secret("AdminApiKey", "");

    const authEventsTopicArn = topicArn("auth");

    // One function for the whole HTTP API (Hono). Public functions: 30 s (adog_ARCH.md §4.4).
    api.route("$default", {
      handler: "src/handlers/api.handler",
      timeout: "30 seconds",
      link: [sessions],
      environment: {
        STAGE: $app.stage,
        DB_NAME: "auth",
        DB_RESOURCE_ARN: db?.clusterArn ?? "",
        DB_SECRET_ARN: db?.secretArn ?? "",
        ADMIN_API_KEY: adminApiKey.value,
        AUTH_EVENTS_TOPIC_ARN: authEventsTopicArn,
      },
      permissions: [
        { actions: ["sns:Publish"], resources: [authEventsTopicArn] },
        ...(db
          ? [
              {
                actions: [
                  "rds-data:ExecuteStatement",
                  "rds-data:BatchExecuteStatement",
                  "rds-data:BeginTransaction",
                  "rds-data:CommitTransaction",
                  "rds-data:RollbackTransaction",
                ],
                resources: [db.clusterArn],
              },
              { actions: ["secretsmanager:GetSecretValue"], resources: [db.secretArn] },
            ]
          : []),
      ],
    });

    // Events (adog_ARCH.md §4.2): one queue per consumer, DLQ after 5 attempts.
    // Consumers time out at 60 s; SQS hides a message for 6x that time.

    const eventsDlq = new sst.aws.Queue("EventsDlq");
    const events = new sst.aws.Queue("Events", {
      visibilityTimeout: "6 minutes",
      dlq: { queue: eventsDlq.arn, retry: 5 },
    });
    events.subscribe({ handler: "src/handlers/events.handler", timeout: "60 seconds" });
    sst.aws.SnsTopic.get("RequestsEvents", topicArn("requests")).subscribeQueue("RequestsEventsToQueue", events, {
      filter: { tipo: ["RescatistaAprobado"] },
    });
    sst.aws.SnsTopic.get("AuthEvents", topicArn("auth")).subscribeQueue("AuthEventsToQueue", events, {
      filter: { tipo: ["CorreoSolicitado"] },
    });

    return { api: api.url, eventsQueue: events.url, eventsDlq: eventsDlq.url, sessionsTable: sessions.name, database: db ? "auth" : "none" };
  },
});
