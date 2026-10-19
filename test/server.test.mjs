import "./env.mjs";

process.env.LITFETCH_UI_TOKEN = "test-token-123";

const assert = (await import("node:assert/strict")).default;
const { after, before, test } = await import("node:test");
const { config } = await import("../src/config.js");
const { createApp } = await import("../server/index.js");

let server;
let base;
before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const queue = (headers = {}) =>
  fetch(`${base}/api/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ input: "10.1000/ui-test" }),
  });

test("the UI listens on loopback unless LITFETCH_UI_HOST says otherwise", () => {
  assert.equal(config.ui.host, "127.0.0.1");
});

test("changing the library needs the token", async () => {
  assert.equal((await queue()).status, 401);
  assert.equal((await queue({ "X-Litfetch-Token": "wrong-token-12" })).status, 401);
  const ok = await queue({ "X-Litfetch-Token": "test-token-123" });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).id, "doi-10.1000-ui-test");
});

test("a mirror outside the allowlist is refused before any request", async () => {
  // The offline guard in env.mjs would end the process if a request left this machine.
  for (const path of ["/api/search?query=x&tld=evil", "/api/download?md5=" + "0".repeat(32) + "&tld=evil"]) {
    const resp = await fetch(base + path, { headers: { Authorization: "Bearer k" } });
    assert.equal(resp.status, 400, path);
    assert.match((await resp.json()).error, /unknown mirror/);
  }
});
