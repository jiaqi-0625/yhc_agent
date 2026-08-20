import { pathToFileURL } from "node:url";

import { parsePostgresDatabaseConfig } from "./database-config.ts";
import {
  applyDatabaseMigrations,
  loadDatabaseMigrations,
  verifyDatabaseSchema,
} from "./database-migrations.ts";
import { createPostgresDatabase } from "./postgres-database.ts";

export async function runDatabaseCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const command = arguments_[0];
  if (command !== "migrate" && command !== "verify" && command !== "ping") {
    throw new Error("Usage: database-cli.ts <migrate|verify|ping>");
  }

  const database = createPostgresDatabase(parsePostgresDatabaseConfig(environment));
  try {
    if (command === "ping") {
      await database.ping();
      return "PostgreSQL connection is healthy.";
    }
    const migrations = await loadDatabaseMigrations();
    const version = command === "migrate"
      ? await applyDatabaseMigrations(database, migrations)
      : await verifyDatabaseSchema(database, migrations);
    return `Database schema version ${version.currentVersion} verified.`;
  } finally {
    await database.close();
  }
}
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runDatabaseCli(process.argv.slice(2))
    .then((message) => {
      process.stdout.write(`${message}\n`);
    })
    .catch(() => {
      // Do not print driver errors: they can contain connection configuration.
      process.stderr.write("Database command failed.\n");
      process.exitCode = 1;
    });
}
