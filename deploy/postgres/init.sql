-- Runs once, when the data volume is first initialised. The integration check
-- writes and cascade-deletes, so it gets a database of its own; the app
-- creates its schema (and the pgvector extension) at boot.
CREATE DATABASE agent_studio_test OWNER agent_studio;
-- mcp-memory keeps its memories beside the app rather than in S3 Vectors; the
-- server creates its own schema (and the pgvector extension) at first start.
CREATE DATABASE mcp_memory OWNER agent_studio;
