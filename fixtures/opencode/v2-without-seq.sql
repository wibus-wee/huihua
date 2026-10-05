-- Synthetic compatibility variant observed in ccusage; not the pinned official schema.
CREATE TABLE session_v2(id TEXT PRIMARY KEY,title TEXT,fork_session_id TEXT,fork_boundary TEXT,time_created INTEGER,cost REAL,tokens_input INTEGER);
INSERT INTO session_v2 VALUES('v2-child','forked','v2-parent','{"type":"through","messageID":"m1"}',1767225600000,0.01,12);
CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT);
INSERT INTO session_message VALUES('m1','v2-child','user','{"text":"copied history survives"}');
INSERT INTO session_message VALUES('m2','v2-child','assistant','{"model":{"id":"example-model"},"content":[{"type":"text","text":"child reply"}],"tokens":{"input":12,"output":3}}');
