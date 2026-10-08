"""Read-only source inspection; all database operations use isolated :memory:."""
import json
import re
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
schema_source = (root / "src-tauri/src/records/schema.rs").read_text()
auth_source = (root / "src-tauri/src/records/auth.rs").read_text()
schema = re.search(r'execute_batch\(\s*"(.*?)",\s*\)', schema_source, re.S).group(1)
predicate = re.search(r'let sql = format!\(\s*"(.*?)"', auth_source, re.S).group(1)
predicate = predicate.replace("{alias}", "r").replace("{scope}", "0=1")
db = sqlite3.connect(":memory:")
db.executescript(schema)
insert = """INSERT INTO records
  (id,kind,origin,principal_id,conversation_id,observed_at,recorded_at,locator_json,capture_state)
  VALUES('restored-record','web_fetch','external_observation','p','c',1,1,'{}','complete')"""
db.execute(insert)
# Model Journal::open's record-tombstone replay into a pre-forget backup.
db.execute("INSERT INTO record_tombstones VALUES('restored-record',42,42,'journal')")
query = "SELECT EXISTS(SELECT 1 FROM records r WHERE " + predicate + ")"
visible = bool(db.execute(query, ("p", "c")).fetchone()[0])
blocked = False
try:
    db.execute(insert)
except sqlite3.IntegrityError as error:
    blocked = "record forgotten" in str(error)
# Negative control: normal forget_at additionally updates the row.
db.execute("UPDATE records SET forget_epoch=42 WHERE id='restored-record'")
hidden = not bool(db.execute(query, ("p", "c")).fetchone()[0])
assert visible and blocked and hidden
print(json.dumps({
    "probe": "Actual records schema and authorization SQL; isolated tombstone-replay component probe",
    "sqlite_version": sqlite3.sqlite_version,
    "tombstone_replay_existing_record_visible": visible,
    "insert_same_record_blocked": blocked,
    "normal_forget_epoch_update_hidden": hidden,
    "scope": "Not a Tauri restore or production exposure test; journal sync omission is source-traced separately.",
}, indent=2))
