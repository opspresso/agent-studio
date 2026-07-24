/**
 * Create the single table with GSI1/GSI2 on DynamoDB Local.
 * Refuses to run against non-local endpoints so alpha/prod are never touched.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT_URL ?? "http://localhost:8000";
const tableName = process.env.DYNAMODB_TABLE_NAME ?? "agent-studio";

if (!endpoint.includes("localhost") && !endpoint.includes("127.0.0.1")) {
  console.error(`Refusing to run against non-local endpoint: ${endpoint}`);
  process.exit(1);
}

// DynamoDB Local namespaces tables by access key + region unless started with
// -sharedDb, so this must match the app client (src/infrastructure/db/client.ts).
const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-northeast-2",
  endpoint,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function main() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`Table ${tableName} already exists`);
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
        { AttributeName: "GSI2PK", AttributeType: "S" },
        { AttributeName: "GSI2SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "GSI2PK", KeyType: "HASH" },
            { AttributeName: "GSI2SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log(`Created table ${tableName}`);

  // Row retention: trace/usage/chat and Slack dedup rows carry `expiresAt`.
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    }),
  );
  console.log(`Enabled TTL on ${tableName}.expiresAt`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
