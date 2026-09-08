-- Runs once when the data volume is first initialized. Integration checks
-- use a dedicated database; the application creates its schema at boot.
CREATE DATABASE agent_studio_test OWNER agent_studio;
