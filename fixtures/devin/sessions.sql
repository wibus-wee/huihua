CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, working_directory TEXT, created_at INTEGER, last_activity_at INTEGER, main_chain_id INTEGER, hidden INTEGER);
CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER);
INSERT INTO sessions VALUES ('devin-session','Devin fixture','/captured/devin',1700000000,1700000005,3,0);
INSERT INTO message_nodes VALUES (1,'devin-session',2,1,'{"message_id":"repeat","role":"assistant","content":"Reading","tool_calls":[{"id":"call","name":"read","arguments":{"path":"a"}}]}',1700000001);
INSERT INTO message_nodes VALUES (2,'devin-session',4,1,'{"message_id":"branch","role":"assistant","content":"Abandoned branch"}',1700000002);
INSERT INTO message_nodes VALUES (3,'devin-session',1,NULL,'{"message_id":"repeat","role":"user","content":"Inspect"}',1700000000);
INSERT INTO message_nodes VALUES (4,'devin-session',3,2,'{"role":"tool","tool_call_id":"call","content":"denied","is_error":true}',1700000003);
INSERT INTO message_nodes VALUES (5,'devin-session',5,4,'{"role":"future","opaque":true}',1700000004);
INSERT INTO message_nodes VALUES (6,'foreign',1,NULL,'{"role":"user","content":"do not read"}',1700000000);
