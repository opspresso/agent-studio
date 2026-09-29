import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { config } from "@/lib/config";

let provider: ReturnType<typeof defaultProvider> | undefined;

/** Share the SDK's lazy, refreshing credential chain across SigV4 transports. */
export function awsCredentials(): ReturnType<typeof defaultProvider> {
  if (!provider) {
    const region = config.awsRegion;
    provider = defaultProvider({ parentClientConfig: { region: async () => region } });
  }
  return provider;
}
