import { createHash, createHmac, randomUUID } from "node:crypto";

export const BOT_ACTOR_ID_HEADER = "x-bot-actor-id";
export const BOT_CHAT_TYPE_HEADER = "x-bot-chat-type";
export const BOT_TIMESTAMP_HEADER = "x-bot-timestamp";
export const BOT_NONCE_HEADER = "x-bot-nonce";
export const BOT_SIGNATURE_HEADER = "x-bot-signature";

export function canonicalJson(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    if (keys.length === 0) return "{}";
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "";
}

export function computeBodySha256(serializedBody = "") {
  return createHash("sha256")
    .update(serializedBody || "", "utf8")
    .digest("hex");
}

export function deriveActorSigningKey(serviceToken, explicitSigningSecret = "") {
  const cleanExplicit = String(explicitSigningSecret ?? "").trim();
  if (cleanExplicit) {
    return cleanExplicit;
  }
  return createHmac("sha256", serviceToken)
    .update("zoppini-bot-actor-signing-v1", "utf8")
    .digest("hex");
}

export function signSiteApiRequest({
  serviceToken,
  signingSecret = "",
  method = "GET",
  fullUrl,
  actorId,
  chatType,
  serializedBody = "",
  timestamp = String(Date.now()),
  nonce = randomUUID(),
}) {
  const parsedUrl = new URL(fullUrl);
  const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
  const upperMethod = method.toUpperCase();
  const bodySha256 =
    upperMethod === "GET" || upperMethod === "HEAD"
      ? computeBodySha256("")
      : computeBodySha256(serializedBody);

  const signingKey = deriveActorSigningKey(serviceToken, signingSecret);
  const payload = [
    "v1",
    timestamp,
    nonce,
    upperMethod,
    pathWithQuery,
    String(actorId),
    String(chatType),
    bodySha256,
  ].join("\n");

  const signature = createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");

  return {
    authorization: `Bearer ${serviceToken}`,
    [BOT_ACTOR_ID_HEADER]: String(actorId),
    [BOT_CHAT_TYPE_HEADER]: String(chatType),
    [BOT_TIMESTAMP_HEADER]: timestamp,
    [BOT_NONCE_HEADER]: nonce,
    [BOT_SIGNATURE_HEADER]: signature,
  };
}
