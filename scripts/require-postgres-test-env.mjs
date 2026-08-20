if (!process.env.TEST_DATABASE_URL?.trim()) {
  process.stderr.write(
    "TEST_DATABASE_URL is required for npm run test:postgres; the dedicated PostgreSQL check must not pass by skipping every test.\n",
  );
  process.exit(1);
}
