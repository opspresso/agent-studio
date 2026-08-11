/**
 * The one Bedrock runtime client.
 *
 * Two embedding adapters invoke Bedrock — Titan and Cohere — and they differ
 * only in the body they send. Everything about *reaching* the service is the
 * same question with one answer: which region, and whether the pod has
 * credentials at all (it does, through the Pod Identity association on its
 * service account; nothing here passes a key).
 *
 * Lazily built and reused, like the S3 clients: constructing it at module load
 * would resolve credentials in every process that imports the module, including
 * ones that never embed anything.
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
