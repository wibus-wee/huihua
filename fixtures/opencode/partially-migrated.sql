-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
INSERT INTO session VALUES('session-1','fixture','/fixture/project','parent-1',1767225600000,1767225601000);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); INSERT INTO message VALUES('m1','session-1','{"role":"user"}');
