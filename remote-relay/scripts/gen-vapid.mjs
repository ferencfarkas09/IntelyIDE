// Prints a fresh VAPID key pair to the terminal. Store the values with `wrangler secret put`; never commit them.
import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const j = privateKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
void publicKey;
console.log(`VAPID_PRIVATE_KEY=${j.d}`);
console.log(`VAPID_PUBLIC_KEY=${pub.toString("base64url")}`);
