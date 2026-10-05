-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
INSERT INTO session VALUES('session-1','fixture','/fixture/project','parent-1',1767225600000,1767225601000);
CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
INSERT INTO message VALUES('m1','session-1',1767225600000,'{"role":"assistant","modelID":"fixture-model","tokens":{"input":1,"output":2}}');
INSERT INTO part VALUES('p0','m1','session-1',1767225600000,'{broken');
INSERT INTO part VALUES('p1','m1','session-1',1767225600000,'{"type":"text","text":"survives"}');
