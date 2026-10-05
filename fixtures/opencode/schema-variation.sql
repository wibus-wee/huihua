-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
INSERT INTO session VALUES('session-1','fixture','/fixture/project','parent-1',1767225600000,1767225601000);
CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT);
INSERT INTO session_message VALUES('m0','session-1',0,'user',1767225600000,'{"text":"hello","files":[{"url":"file:///fixture/image.png","mime":"image/png"}]}');
INSERT INTO session_message VALUES('m1','session-1',1,'assistant',1767225600000,'{"model":{"id":"fixture-model"},"content":[{"type":"text","text":"reply"},{"type":"reasoning","text":"reason"},{"type":"tool","id":"call","name":"exec","state":{"status":"completed","input":{},"content":[{"type":"text","text":"ok"}]}}],"tokens":{"input":1,"output":2}}');
INSERT INTO session_message VALUES('m2','session-1',2,'future',1767225600000,'{"opaque":[1,2]}');
