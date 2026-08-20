import assert from "node:assert/strict";
import test from "node:test";

import {
  errorStatus,
  requestErrorBody,
} from "../src/http-boundary.ts";
import {
  PostgresDatabaseClosedError,
  PostgresPersistenceError,
} from "../src/postgres-database.ts";
import { ProjectAssetRuntimeError } from "../src/project-asset-runtime.ts";

test("PostgreSQL constraint failures map to a stable conflict without driver details", () => {
  const driverError = Object.assign(
    new Error("duplicate key on secret_table at db.internal"),
    { code: "23505" },
  );
  const error = new PostgresPersistenceError("transaction query", driverError);

  assert.equal(errorStatus(error), 409);
  const body = requestErrorBody(error);
  assert.deepEqual(body, {
    code: "AIC-PERSISTENCE-CONFLICT",
    message: "The persistence operation conflicted with current database state.",
    retryable: false,
    charged: false,
  });
  assert.doesNotMatch(JSON.stringify(body), /secret_table|db\.internal|duplicate key/u);
});
test("PostgreSQL concurrency and availability failures expose only retry-safe metadata", () => {
  const serializationFailure = new PostgresPersistenceError(
    "commit",
    Object.assign(new Error("transaction internals"), { code: "40001" }),
  );
  assert.equal(errorStatus(serializationFailure), 409);
  assert.equal(requestErrorBody(serializationFailure).retryable, true);

  const connectionFailure = new PostgresPersistenceError(
    "connect",
    new Error("postgresql://user:password@private.internal/firefly"),
  );
  assert.equal(errorStatus(connectionFailure), 503);
  const body = requestErrorBody(connectionFailure);
  assert.deepEqual(body, {
    code: "AIC-PERSISTENCE-UNAVAILABLE",
    message: "The persistence service is temporarily unavailable.",
    retryable: true,
    charged: false,
  });
  assert.doesNotMatch(JSON.stringify(body), /password|private\.internal|postgresql/u);
  assert.equal(errorStatus(new PostgresDatabaseClosedError()), 503);
});

test("project asset selection errors preserve stable business codes and statuses", () => {
  const stale = new ProjectAssetRuntimeError(
    "AIC-ASSET-SELECTION-REVISION-CONFLICT",
    "The project asset pool changed.",
  );
  assert.equal(errorStatus(stale), 409);
  assert.deepEqual(requestErrorBody(stale), {
    code: "AIC-ASSET-SELECTION-REVISION-CONFLICT",
    message: "The project asset pool changed.",
    retryable: false,
    charged: false,
  });

  const invalid = new ProjectAssetRuntimeError(
    "AIC-ASSET-SELECTION-INVALID",
    "The selected asset is invalid.",
  );
  assert.equal(errorStatus(invalid), 400);
  assert.equal(requestErrorBody(invalid).code, "AIC-ASSET-SELECTION-INVALID");
});
