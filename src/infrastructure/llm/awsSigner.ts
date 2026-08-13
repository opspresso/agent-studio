/**
 * A `fetch` that signs its request with AWS SigV4, for the OpenAI-compatible
 * endpoints AWS serves.
 *
 * Bedrock's chat-completions endpoint speaks the same wire protocol as every
 * other channel and differs in one thing: it takes AWS credentials instead of a
 * bearer key. That is a *transport* difference, so it is handled by swapping the
 * SDK's `fetch` rather than by writing a second channel adapter — the request
 * body, the streaming, and the response mapping stay the one implementation in
 * `channel.ts`.
 *
 * The pod carries no key: its Pod Identity association is the credential, which
 * is the whole reason to sign rather than to mint a long-lived Bedrock API key.
 * Credentials come from the Bedrock client that already exists for embeddings,
 * so refresh is the SDK's problem and there is exactly one credential chain in
 * the process.
 */

import { createHash, createHmac } from "node:crypto";
import { SignatureV4 } from "@smithy/signature-v4";
import { bedrockRuntime } from "./bedrockClient";

/**
 * The hash SigV4 needs, over `node:crypto`.
 *
 * `@smithy/hash-node` is what the AWS SDK uses for this and is not a dependency
 * here; it wraps the same two calls. Constructed with a secret it is an HMAC —
 * the signer uses both forms from one constructor.
 */
class NodeHash {
  private readonly hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash = secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", toBytes(secret));
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(toBytes(data));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
}

function toBytes(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf-8");
  }
  return ArrayBuffer.isView(data)
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(data);
}

/** `bedrock-mantle.ap-northeast-1.api.aws` → `ap-northeast-1`. */
const REGION_LABEL = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * The region a host is in, read off the host itself.
 *
 * Deliberately *not* `AWS_REGION`: the app runs in ap-northeast-2, where the
 * OpenAI-compatible Bedrock endpoint does not exist, so the channel's base URL
 * names a different region than the rest of the deployment. Signing for the
 * app's region would fail every request with a signature error that says
 * nothing about which of the two regions is wrong.
 */
function regionOf(host: string): string {
  const label = host.split(".").find((part) => REGION_LABEL.test(part));
  if (!label) {
    throw new Error(`SigV4 channel host names no region: ${host}`);
  }
  return label;
}

/**
 * Signs the body it is handed, which must already be bytes.
 *
 * A stream or a `FormData` cannot be signed without draining it first, and a
 * request signed over the wrong payload fails at AWS as an opaque 403 — so an
 * unsignable body is refused here, where the message can say what happened.
 * Chat completions always arrive as a JSON string; the multipart image edit
 * path never reaches an AWS channel.
 */
function payloadOf(body: BodyInit | null | undefined): string | Uint8Array {
  if (body === null || body === undefined) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  throw new Error(`SigV4 channel cannot sign a ${body.constructor.name} body`);
}

/**
 * The one AWS service this app signs LLM traffic for. Bedrock's
 * OpenAI-compatible host is `bedrock-mantle.<region>.api.aws`, which signs as
 * `bedrock` — the host prefix and the signing name are not the same string,
 * which is why this is stated rather than derived.
 */
export const AWS_SIGNING_SERVICE = "bedrock";

/**
 * A `fetch` that signs every request for `service` before sending it.
 *
 * The service is passed in rather than guessed from the host: `bedrock-mantle`
 * signs as `bedrock`, and a heuristic that strips the suffix would answer
 * confidently for a host it has never seen, whose only symptom is a 403.
 */
export function createSignedFetch(service: string): typeof fetch {
  const signer = new SignatureV4({
    service,
    // Resolved per request by the signer; the region is per URL (see regionOf),
    // so this one is a placeholder the sign call overrides.
    region: "us-east-1",
    credentials: bedrockRuntime().config.credentials,
    sha256: NodeHash,
  });

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = payloadOf(init?.body);

    const signed = await signer.sign(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: {
          ...Object.fromEntries(headers.entries()),
          host: url.host,
        },
        body,
      },
      { signingRegion: regionOf(url.hostname) },
    );

    return fetch(url, { ...init, method, headers: signed.headers });
  };
}
