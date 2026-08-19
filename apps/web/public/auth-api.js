import { api } from "./api-client.js";

export const authApi = {
  listDevelopmentAccounts: function () { return api("/v1/auth/development-accounts"); },
  getSession: function () { return api("/v1/auth/session"); },
  createOrSwitchSession: function (accountId) {
    return api("/v1/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: accountId }),
    });
  },
};
