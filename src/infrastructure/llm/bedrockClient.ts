/**
 * Shared lazy Bedrock client for Titan and Cohere embedding adapters.
 * Region comes from deployment config; credentials use the AWS SDK chain.
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { config } from "@/lib/config";

let client: BedrockRuntimeClient | undefined;

export function bedrockRuntime(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: config.awsRegion });
  }
  return client;
}
