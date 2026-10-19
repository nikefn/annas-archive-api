/**
 * Stream a URL to disk, hashing as it goes. The file lands at `dest` only when
 * the transfer completed and stayed under the size cap.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { config } from "./config.js";
import { client } from "./http.js";

const http = client();

export async function download(url, dest, { headers } = {}) {
  const resp = await http.request(url, { headers, redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const declared = Number(resp.headers.get("content-length"));
  if (declared > config.maxBytes) throw new Error(`larger than ${config.maxBytes} bytes`);

  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  let bytes = 0;
  const part = `${dest}.part`;
  try {
    await pipeline(
      Readable.fromWeb(resp.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > config.maxBytes) throw new Error(`larger than ${config.maxBytes} bytes`);
          md5.update(chunk);
          sha256.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(part)
    );
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return {
    bytes,
    md5: md5.digest("hex"),
    sha256: sha256.digest("hex"),
    contentType: resp.headers.get("content-type") || "",
    finalUrl: resp.url,
  };
}
