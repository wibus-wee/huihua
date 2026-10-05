CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER, created_at INTEGER, PRIMARY KEY(session_id,seq));
INSERT INTO session_windows VALUES ('openclaw-db','agent:main:main',1700000000000,1700000001000);
INSERT INTO transcript_events VALUES ('openclaw-db',0,'{"type":"session","id":"openclaw-db","version":3,"cwd":"/captured/openclaw"}',NULL,NULL,1700000000000);
INSERT INTO transcript_events VALUES ('openclaw-db',1,'{"type":"message","id":"repeat","message":{"role":"user","content":"SQLite prompt"}}',NULL,NULL,1700000000000);
INSERT INTO transcript_events VALUES ('openclaw-db',2,NULL,X'28b52ffd24948503001207171a804b73888595485093b1cf8c0e8d88a47610ec3da7a88c8c2808ef215e97a4d9017c2518108a0cff803df39992a8e9597aaacc9428ae0d3435203ca780ce81ce11400e526c5be9e9a55ed32737bb6215aaa65ea44caf62dd96b71106002a027ac2f062350887e255913570504176780c',148,1700000001000);
INSERT INTO transcript_events VALUES ('openclaw-db',3,'{broken',NULL,NULL,1700000001001);
INSERT INTO transcript_events VALUES ('foreign',0,'{"type":"message","message":{"role":"user","content":"do not read"}}',NULL,NULL,1700000000000);
