import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { handle } from "hono/aws-lambda";
import { createApp } from "../app.js";
import { createDataApiDb, dataApiConfigFromEnv } from "../db/client.js";
import type { Publisher } from "../lib/outbox.js";

const dbConfig = dataApiConfigFromEnv();
const topicArn = process.env.AUTH_EVENTS_TOPIC_ARN;
const sns = new SNSClient({});

// Consumers filter by the `tipo` attribute (adog_ARCH.md §4.2).
const publish: Publisher | undefined = topicArn
  ? async (evento) => {
      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(evento),
          MessageAttributes: { tipo: { DataType: "String", StringValue: evento.tipo } },
        }),
      );
    }
  : undefined;

export const handler = handle(
  createApp({
    db: dbConfig ? createDataApiDb(dbConfig) : undefined,
    publish,
    adminKey: process.env.ADMIN_API_KEY,
    stage: process.env.STAGE,
  }),
);
