import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { api, setWorkspaceSessionToken } from "../public/api-client.js";

test("browser API attaches the server-issued workspace session and replaces stale caller identity", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    setWorkspaceSessionToken(null);
  });
  setWorkspaceSessionToken("session_current");
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer session_current");
    return Response.json({ ok: true });
  };

  assert.deepEqual(await api("/v1/test", {
    headers: { authorization: "Bearer client_forged" },
  }), { ok: true });
});
