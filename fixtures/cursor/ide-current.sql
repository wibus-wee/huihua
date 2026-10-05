-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
INSERT INTO cursorDiskKV VALUES('composerData:composer-1','{"composerId":"composer-1","name":"fixture","createdAt":1767225600000,"fullConversationHeadersOnly":[{"bubbleId":"b1"},{"bubbleId":"b2"},{"bubbleId":"b3"}],"extra":{"future":true}}');
INSERT INTO cursorDiskKV VALUES('bubbleId:composer-1:b3','{"type":55,"future":{"nested":true}}');
INSERT INTO cursorDiskKV VALUES('bubbleId:composer-1:b2','{"type":2,"text":[{"type":"tool_use","id":"call","name":"native-shell","input":{"cmd":"echo hi"}}]}');
INSERT INTO cursorDiskKV VALUES('bubbleId:composer-1:b1','{"type":1,"text":"hello"}');
INSERT INTO cursorDiskKV VALUES('bubbleId:composer-1:broken',x'ff00');
INSERT INTO cursorDiskKV VALUES('checkpointId:composer-1:check-1','{"files":[{"uri":{"path":"/fixture/a.rs"},"originalModelDiffWrtV0":[{"modified":["new"]}]}]}');
INSERT INTO cursorDiskKV VALUES('messageRequestContext:composer-1:b1','{"attachedFiles":{"a.rs":"historical file content"}}');
