-- Drops every table. Only ever run against staging (see package.json db:staging:reset and scripts/clone.mjs).
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS rebuild_failures;
DROP TABLE IF EXISTS encounters;
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS accounts;
