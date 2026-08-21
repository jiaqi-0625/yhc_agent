import { api, authenticatedBlob } from "./api-client.js";

function jsonOptions(method, body) {
  return {
    method: method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const workspaceApi = {
  getCompanyAssetPreview: function (path) { return authenticatedBlob(path); },
  getOwnBudget: function () { return api("/v1/workspace/me/budget"); },
  getProductionStatus: function () { return api("/v1/workspace/me/production-status"); },
  listAdminBrands: function () { return api("/v1/admin/brands"); },
  getProjectCreationOptions: function () { return api("/v1/workspace/project-creation/options"); },
  getProjectAssetPackage: function (vehicleId) {
    return api("/v1/workspace/project-creation/vehicles/" + encodeURIComponent(vehicleId) + "/asset-package");
  },
  getProjectConfiguration: function (vehicleId) {
    return api("/v1/workspace/project-creation/vehicles/" + encodeURIComponent(vehicleId) + "/configuration");
  },
  searchProjectCompanyAssets: function (vehicleId, query = {}) {
    const parameters = new URLSearchParams();
    if (query.category) parameters.append("category", query.category);
    if (query.searchText) parameters.set("searchText", query.searchText);
    if (query.cursor) parameters.set("cursor", query.cursor);
    parameters.set("limit", String(query.limit || 50));
    return api(
      "/v1/workspace/project-creation/vehicles/" + encodeURIComponent(vehicleId) +
      "/company-assets?" + parameters.toString(),
    );
  },
  createBatchProject: function (input) {
    return api("/v1/workspace/batch-projects", jsonOptions("POST", input));
  },
  createVideoTask: function (projectId, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) + "/video-tasks",
      jsonOptions("POST", input),
    );
  },
  getProjectLibrary: function () { return api("/v1/workspace/project-library"); },
  getAssetMatching: function (projectId, videoTaskId) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/asset-matching",
    );
  },
  lockAssetSelection: function (projectId, videoTaskId, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/asset-matching",
      jsonOptions("POST", input),
    );
  },
  uploadTemporaryAsset: function (projectId, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) + "/temporary-assets",
      jsonOptions("POST", input),
    );
  },
  getStageVersions: function (projectId, videoTaskId, stage) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) +
      "/stages/" + encodeURIComponent(stage) + "/versions",
    );
  },
  getStageInvalidations: function (projectId, videoTaskId) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/stage-invalidations",
    );
  },
  confirmStage: function (projectId, videoTaskId, stage, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) +
      "/stages/" + encodeURIComponent(stage) + "/confirmations",
      jsonOptions("POST", input),
    );
  },
  simulateStage: function (projectId, videoTaskId, stage) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) +
      "/stages/" + encodeURIComponent(stage) + "/development-simulation",
      { method: "POST" },
    );
  },
  estimateVideoProduction: function (projectId, videoTaskId) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/video-production/estimate",
    );
  },
  getVideoProduction: function (projectId, videoTaskId) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/video-production",
    );
  },
  startVideoProduction: function (projectId, videoTaskId, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) + "/video-production",
      jsonOptions("POST", input),
    );
  },
  getMediaArtifactAccess: function (projectId, videoTaskId, artifactId, purpose = "playback") {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) +
      "/media-artifacts/" + encodeURIComponent(artifactId) + "/access",
      jsonOptions("POST", { purpose: purpose }),
    );
  },
  rollbackStage: function (projectId, videoTaskId, stage, input) {
    return api(
      "/v1/workspace/batch-projects/" + encodeURIComponent(projectId) +
      "/video-tasks/" + encodeURIComponent(videoTaskId) +
      "/stages/" + encodeURIComponent(stage) + "/rollbacks",
      jsonOptions("POST", input),
    );
  },
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
