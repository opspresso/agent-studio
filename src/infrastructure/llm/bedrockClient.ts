/**
 * Lazy AWS credential-chain binding for the Bedrock SigV4 transport.
 * Client configuration uses the deployment region; each request's signing
 * region is derived from its endpoint by awsSigner.ts.
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
