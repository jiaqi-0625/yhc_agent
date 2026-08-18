import { api } from "./api-client.js";

function jsonOptions(method, body) {
  return {
    method: method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const workspaceApi = {
  listWorks: function () { return api("/v1/works"); },
  getWork: function (workId) { return api("/v1/works/" + encodeURIComponent(workId)); },
  createWork: function (input) { return api("/v1/works", jsonOptions("POST", input)); },
  copyWork: function (workId, input) {
    return api("/v1/works/" + encodeURIComponent(workId) + "/copy", jsonOptions("POST", input));
  },
  generateStrategy: function (workId, input) {
    return api("/v1/works/" + encodeURIComponent(workId) + "/strategy/generate", jsonOptions("POST", input));
  },
  updateStrategy: function (workId, input) {
    return api("/v1/works/" + encodeURIComponent(workId) + "/strategy", jsonOptions("PATCH", input));
  },
  requestStrategyApproval: function (workId, input) {
    return api("/v1/works/" + encodeURIComponent(workId) + "/strategy/approval-request", jsonOptions("POST", input));
  },
  decideStrategy: function (workId, input) {
    return api("/v1/works/" + encodeURIComponent(workId) + "/strategy/decision", jsonOptions("POST", input));
  },
};
