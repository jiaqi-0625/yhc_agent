import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser module is intentionally plain JavaScript.
import { ApiError, api, setWorkspaceSessionToken } from "../public/api-client.js";

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

test("browser API preserves the standard error response for action-card handling", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({
    code: "AIC-COST-BUDGET_EXCEEDED",
    message: "Budget exceeded.",
    requestId: "request_budget_1",
    retryable: false,
    charged: false,
  }, { status: 409 });

  await assert.rejects(
    api("/v1/test"),
    (error: unknown) => {
      if (!(error instanceof ApiError)) return false;
      const apiError = error as Error & {
        code: string;
        status: number;
        requestId?: string;
        retryable: boolean;
        charged: boolean;
      };
      return apiError.code === "AIC-COST-BUDGET_EXCEEDED"
        && apiError.message === "Budget exceeded."
        && apiError.status === 409
        && apiError.requestId === "request_budget_1"
        && apiError.retryable === false
        && apiError.charged === false;
    },
  );
});

test("browser API uses a safe structured fallback for malformed error responses", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("not json", { status: 502 });

  await assert.rejects(
    api("/v1/test"),
    (error: unknown) => {
      if (!(error instanceof ApiError)) return false;
      const apiError = error as Error & {
        code: string;
        status: number;
        retryable: boolean;
        charged: boolean;
      };
      return apiError.code === "AIC-API-REQUEST_FAILED"
        && apiError.message === "请求失败（HTTP 502）"
        && apiError.status === 502
        && apiError.retryable === false
        && apiError.charged === false;
    },
  );
});
