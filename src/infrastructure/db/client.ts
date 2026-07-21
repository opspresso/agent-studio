import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "@/lib/config";

let documentClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    const client = new DynamoDBClient({
      region: config.awsRegion,
      ...(config.dynamodbEndpointUrl
        ? {
            endpoint: config.dynamodbEndpointUrl,
            credentials: { accessKeyId: "local", secretAccessKey: "local" },
          }
        : {}),
    });
    documentClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

export function getTableName(): string {
  return config.tableName;
}
