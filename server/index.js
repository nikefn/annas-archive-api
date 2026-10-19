/**
 * Web UI server: serves server/public and mounts each file in server/api as a
 * route. Handlers are framework-agnostic (req.query / req.body in,
 * res.status().json() out); all logic lives in src/.
 *
 * It listens on 127.0.0.1 unless LITFETCH_UI_HOST says otherwise. Routes that
 * change the library need the X-Litfetch-Token header to equal
 * LITFETCH_UI_TOKEN; with no token configured they are refused. Pages may only
 * run the server's own script and style files.
 */

import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { config } from "../src/config.js";
import { assertLibrary } from "../src/store.js";
import downloadHandler from "./api/download.js";
import queueHandler from "./api/queue.js";
import searchHandler from "./api/search.js";

const here = dirname(fileURLToPath(import.meta.url));

function requireToken(req, res, next) {
  const given = Buffer.from(String(req.headers["x-litfetch-token"] ?? ""));
  const want = Buffer.from(config.ui.token);
  if (want.length && given.length === want.length && timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: config.ui.token ? "wrong or missing X-Litfetch-Token" : "set LITFETCH_UI_TOKEN on the server to allow changes" });
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  app.get("/api/search", searchHandler);
  app.get("/api/download", downloadHandler);
  app.post("/api/queue", requireToken, express.json({ limit: "16kb" }), queueHandler);
  app.use(express.static(join(here, "public")));
  // Errors (e.g. malformed JSON) come back as JSON, without a stack trace.
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.expose ? err.message : "request failed" });
  });
  return app;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertLibrary();
  const { host, port } = config.ui;
  if (!LOOPBACK.has(host)) {
    console.warn(`WARNING: listening on ${host}, reachable from other machines. Anyone who can reach it can use it.`);
  }
  const server = createApp().listen(port, host, () => console.log(`litfetch UI at http://${host}:${port}`));
  // Without this an in-use port makes the process exit silently with code 0.
  server.on("error", (err) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use; set LITFETCH_UI_PORT, e.g. LITFETCH_UI_PORT=4020 npm run ui` : err);
    process.exit(1);
  });
}
