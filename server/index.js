/**
 * Web UI server: serves server/public and mounts each file in server/api as a
 * route. Handlers are framework-agnostic (req.query / req.body in,
 * res.status().json() out); all logic lives in src/.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import downloadHandler from "./api/download.js";
import queueHandler from "./api/queue.js";
import searchHandler from "./api/search.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.get("/api/search", searchHandler);
app.get("/api/download", downloadHandler);
app.post("/api/queue", express.json({ limit: "16kb" }), queueHandler);
app.use(express.static(join(here, "public")));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`litfetch UI at http://localhost:${PORT}`));

// Without this an in-use port makes the process exit silently with code 0.
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is in use; set PORT, e.g. PORT=4020 npm run ui` : err);
  process.exit(1);
});
