-- Runs once, when the data volume is first initialised. The integration check
-- writes and cascade-deletes, so it gets a database of its own; the app
-- creates its schema (and the pgvector extension) at boot.
CREATE DATABASE agent_studio_test OWNER agent_studio;
