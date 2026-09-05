-- Custom migration 0001 — seed data + schema guards that drizzle-kit cannot express.
--
-- 1. Enforce "at most one open incident per monitor" at the database level
--    (PRD §17.5; repository-layer guard also applies for defense in depth).
CREATE UNIQUE INDEX `incidents_one_open_per_monitor_idx` ON `incidents` (`monitor_id`) WHERE `status` = 'open';--> statement-breakpoint

-- 2. Seed the Morabeza client for internal sites (PRD §33).
--    No production monitors are seeded in migration SQL; they are added via the
--    admin UI / bulk import after the monitoring engine passes smoke testing.
INSERT INTO `clients` (`id`, `name`, `slug`, `active`, `created_at`, `updated_at`)
VALUES (
  'cli_morabeza',
  'Morabeza',
  'morabeza',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
