import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentRuntime, type LocalAgentConfig } from "@firefly/agent";

import { startApiServer } from "../src/server.ts";

const testConfig: LocalAgentConfig = {
  provider: "mock",
  modelId: "mock-local",
  baseUrl: "local://mock",
  thinkingLevel: "off",
  persistSessions: false,
  dataDirectory: ".data/test-management-web-assets",
};

test("management center modules are served under the existing locked-down web boundary", async (context) => {
  const server = await startApiServer(0, "127.0.0.1", new LocalAgentRuntime(testConfig));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = "http://127.0.0.1:" + address.port;

  const [pageResponse, styleResponse, apiResponse, centerResponse, appResponse] =
    await Promise.all([
      fetch(baseUrl + "/"),
      fetch(baseUrl + "/management-center.css"),
      fetch(baseUrl + "/management-api.js"),
      fetch(baseUrl + "/management-center.js"),
      fetch(baseUrl + "/app.js"),
    ]);

  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /management-center\.css\?build=management-center-ws409-v1/u);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type") ?? "", /^text\/css/u);
  assert.match(await styleResponse.text(), /\.management-center-page/u);
  assert.equal(apiResponse.status, 200);
  assert.match(apiResponse.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.match(await apiResponse.text(), /replaceVehicleAssetAssociations/u);
  assert.equal(centerResponse.status, 200);
  assert.match(await centerResponse.text(), /createManagementCenter/u);
  assert.equal(appResponse.status, 200);
  const app = await appResponse.text();
  assert.match(app, /\.\/management-api\.js/u);
  assert.match(app, /\.\/management-center\.js/u);
  assert.match(app, /managementCenter\.setAccount/u);
});
