CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, ended_at REAL, cwd TEXT, parent_session_id TEXT, input_tokens INTEGER);
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp REAL, active INTEGER);
INSERT INTO sessions VALUES ('hermes-db','cli','Hermes fixture',1700000000,NULL,'/captured/hermes',NULL,3);
INSERT INTO messages VALUES (3,'hermes-db','tool','denied',NULL,'call','read',1700000002,1);
INSERT INTO messages VALUES (1,'hermes-db','user','[this is plain text]',NULL,NULL,NULL,1700000000,0);
INSERT INTO messages VALUES (2,'hermes-db','assistant',char(0) || 'json:[{"type":"text","text":"Reading"}]','[{"id":"call","function":{"name":"read","arguments":"{}"}}]',NULL,NULL,1700000001,1);
INSERT INTO messages VALUES (4,'foreign','user','do not read',NULL,NULL,NULL,1700000003,1);
