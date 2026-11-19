#!/usr/bin/env python3
"""Contract test for packages/store/schema/schema.sql.

Two promises are checked against a real SQLite database, not a mock:

1. every constraint the design relies on actually rejects bad data
   (23 cases), and
2. every normal path the product needs actually inserts (11 cases),

plus the query plans, the event sequence trigger, and the Korean search
fallback. The script exits non-zero when any expectation is not met, so CI
cannot go green on a schema that quietly stopped enforcing something.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "packages" / "store" / "schema" / "schema.sql"
SCHEMA_V2 = ROOT / "packages" / "store" / "schema" / "schema-v2.sql"

results: list[tuple[str, str, str, str]] = []


def record(label: str, group: str, ok: bool, detail: str = "") -> None:
    results.append((label, group, "OK" if ok else "FAIL", detail))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA.read_text())
    return conn


def seed(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        INSERT INTO doc(id,title,rev,created_at)
          VALUES('D_aaaaaaaaaaaa','주문 취소 정책',3,'2026-11-19T09:00:00+09:00');
        INSERT INTO obj(id,kind,subtype,title,props,state,rev,hash,created_at,updated_at)
          VALUES('G_aaaaaaaaaaaa','goal',NULL,'취소 문의 30% 감소','{}','active',1,'h-goal','t','t');
        INSERT INTO obj(id,kind,subtype,title,props,state,rev,hash,created_at,updated_at)
          VALUES('N_bbbbbbbbbbbb','specnode','policy','배송 전 취소 가능','{}','agreed',1,'h-n1','t','t');
        INSERT INTO obj(id,kind,subtype,title,props,state,rev,hash,created_at,updated_at)
          VALUES('S_cccccccccccc','screen',NULL,'주문 상세',
                 '{"ref":{"kind":"route","value":"/orders/:id"}}','linked',1,'h-s1','t','t');
        INSERT INTO obj(id,kind,subtype,title,parent_id,props,state,rev,hash,created_at,updated_at)
          VALUES('P_dddddddddddd','pin','policy','취소 버튼','S_cccccccccccc','{}','open',1,'h-p1','t','t');
        INSERT INTO block(id,doc_id,parent_id,idx,type,text,hash,commit_seq)
          VALUES('B_eeeeeeeeeeee','D_aaaaaaaaaaaa',NULL,'a0','paragraph',
                 '배송이 시작되기 전까지만 취소할 수 있다.','hb1',1);
        INSERT INTO link(id,type,src,dst,created_at)
          VALUES('L_ffffffffffff','applies_to','N_bbbbbbbbbbbb','S_cccccccccccc','t');
        """
    )


def expect_reject(conn: sqlite3.Connection, label: str, sql: str, params: tuple = ()) -> None:
    try:
        conn.execute(sql, params)
        conn.commit()
    except (sqlite3.IntegrityError, sqlite3.OperationalError) as exc:
        record(label, "reject", True, str(exc).splitlines()[0])
        return
    record(label, "reject", False, "the schema accepted data it must reject")


def expect_accept(conn: sqlite3.Connection, label: str, sql: str, params: tuple = ()) -> None:
    try:
        conn.execute(sql, params)
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - report whatever the database said
        record(label, "accept", False, str(exc))
        return
    record(label, "accept", True)


def obj_insert(conn: sqlite3.Connection, label: str, **kw) -> None:
    row = dict(
        id="X_" + "z" * 12,
        kind="goal",
        subtype=None,
        title="t",
        parent_id=None,
        props="{}",
        state="active",
        rev=1,
        hash="h",
        created_at="t",
        updated_at="t",
    )
    row.update(kw)
    sql = "INSERT INTO obj(" + ",".join(row) + ") VALUES(" + ",".join("?" * len(row)) + ")"
    expect_reject(conn, label, sql, tuple(row.values()))


def check(conn: sqlite3.Connection, label: str, group: str, sql: str, expected) -> None:
    value = conn.execute(sql).fetchone()[0]
    record(label, group, value == expected, f"expected {expected!r}, got {value!r}")


def main() -> int:
    conn = connect()

    objects = conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
    record("DDL executes", "schema", objects == 77, f"{objects} objects in sqlite_master")

    seed(conn)
    record("seed rows", "schema", True, "goal / specnode / screen / pin / doc / block / link")

    # ── 23 constraints that must reject ────────────────────────────────────
    obj_insert(conn, "specnode subtype is NULL", kind="specnode", subtype=None, state="draft")
    obj_insert(conn, "pin subtype typo", kind="pin", subtype="wibble", state="open",
               parent_id="S_cccccccccccc")
    obj_insert(conn, "screen carries a subtype", kind="screen", subtype="policy", state="linked")
    obj_insert(conn, "specnode state typo", kind="specnode", subtype="policy", state="wibble")
    obj_insert(conn, "goal state typo", kind="goal", state="in-progress")
    obj_insert(conn, "empty hash", kind="goal", hash="")
    obj_insert(conn, "pin without a parent", kind="pin", subtype="policy", state="open",
               parent_id=None)
    obj_insert(conn, "pin parent is not a screen", kind="pin", subtype="policy", state="open",
               parent_id="N_bbbbbbbbbbbb")
    obj_insert(conn, "props is not JSON", kind="goal", props="not json")

    expect_reject(conn, "obj.kind is immutable",
                  "UPDATE obj SET kind='goal' WHERE id='N_bbbbbbbbbbbb'")
    expect_reject(
        conn,
        "link between the wrong kinds",
        "INSERT INTO link(id,type,src,dst,created_at) "
        "VALUES('L_100000000001','derives','S_cccccccccccc','G_aaaaaaaaaaaa','t')",
    )
    expect_reject(
        conn,
        "link type not registered",
        "INSERT INTO link(id,type,src,dst,created_at) "
        "VALUES('L_100000000002','contains','N_bbbbbbbbbbbb','S_cccccccccccc','t')",
    )
    expect_reject(
        conn,
        "sibling idx collision",
        "INSERT INTO block(id,doc_id,parent_id,idx,type,text,hash) "
        "VALUES('B_100000000001','D_aaaaaaaaaaaa',NULL,'a0','paragraph','x','hx')",
    )
    expect_reject(
        conn,
        "block type not registered",
        "INSERT INTO block(id,doc_id,parent_id,idx,type,text,hash) "
        "VALUES('B_100000000002','D_aaaaaaaaaaaa',NULL,'a1','quux','x','hx')",
    )
    expect_reject(
        conn,
        "table_cell without a table_row",
        "INSERT INTO block(id,doc_id,parent_id,idx,type,text,hash) "
        "VALUES('B_100000000003','D_aaaaaaaaaaaa',NULL,'a2','table_cell','x','hx')",
    )
    expect_reject(
        conn,
        "proposal_op view is not JSON",
        "INSERT INTO proposal_op(id,proposal_id,seq,kind,target_block,view) "
        "VALUES('op_1','PR_000000000000',1,'replace','B_eeeeeeeeeeee','not json')",
    )
    expect_reject(
        conn,
        "adopted proposal without decided_at",
        "INSERT INTO proposal(id,doc_id,origin,summary,base_rev,author_kind,state,created_at) "
        "VALUES('PR_000000000001','D_aaaaaaaaaaaa','pin','요약',3,'ai','adopted','t')",
    )
    expect_reject(
        conn,
        "state_def target is a pin",
        "INSERT INTO state_def(id,screen_id,name,level,seed,selectors,evidence) "
        "VALUES('ST_000000000001','P_dddddddddddd','default','L2','{}','{\"root\":\"#x\"}',0)",
    )
    expect_reject(
        conn,
        "state_def seed is 'null'",
        "INSERT INTO state_def(id,screen_id,name,level,seed,selectors,evidence) "
        "VALUES('ST_000000000002','S_cccccccccccc','empty','L2','null','{\"root\":\"#x\"}',0)",
    )
    expect_reject(
        conn,
        "L2 state without a seed",
        "INSERT INTO state_def(id,screen_id,name,level,seed,selectors,evidence) "
        "VALUES('ST_000000000003','S_cccccccccccc','error','L2',NULL,'{\"root\":\"#x\"}',0)",
    )
    expect_reject(
        conn,
        "L0 state claiming evidence",
        "INSERT INTO state_def(id,screen_id,name,level,ref,seed,selectors,evidence) "
        "VALUES('ST_000000000004','S_cccccccccccc','error','L0','figma://f/123',NULL,'{}',1)",
    )

    # The first publish goes through; the same idempotency key may not.
    expect_accept(
        conn,
        "publish_record first write",
        "INSERT INTO publish_record(id,doc_id,target,page_id,version,output_kind,status,idem_key,at) "
        "VALUES('PB_000000000001','D_aaaaaaaaaaaa','confluence','123',4,'body','ok','k1','t')",
    )
    expect_reject(
        conn,
        "duplicate idempotency key",
        "INSERT INTO publish_record(id,doc_id,target,page_id,version,output_kind,status,idem_key,at) "
        "VALUES('PB_000000000002','D_aaaaaaaaaaaa','confluence','123',5,'body','ok','k1','t')",
    )
    expect_reject(conn, "physical delete of a linked object",
                  "DELETE FROM obj WHERE id='S_cccccccccccc'")

    # ── 10 more normal paths (11 with the publish record above) ────────────
    normal_paths = [
        ("state_def L0",
         "INSERT INTO state_def(id,screen_id,name,level,ref,selectors,evidence) "
         "VALUES('ST_000000000010','S_cccccccccccc','default','L0','figma://f/9','{}',0)"),
        ("state_def L2",
         "INSERT INTO state_def(id,screen_id,name,level,seed,selectors,evidence) "
         "VALUES('ST_000000000011','S_cccccccccccc','error',"
         "'L2','{\"fixtures\":[\"order\"],\"flags\":[\"api.500\"]}',"
         "'{\"root\":\"[data-testid=order-detail]\"}',1)"),
        ("proposal adopted",
         "INSERT INTO proposal(id,doc_id,origin,summary,base_rev,author_kind,risk,state,created_at,decided_at) "
         "VALUES('PR_000000000010','D_aaaaaaaaaaaa','pin','취소 문장을 좁힌다',3,'ai','low','adopted','t','t')"),
        ("proposal_op replaces a block",
         "INSERT INTO proposal_op(id,proposal_id,seq,kind,target_block,base_hash,base_text,new_text,view,state,decision) "
         "VALUES('op_10','PR_000000000010',1,'replace','B_eeeeeeeeeeee','hb1',"
         "'배송이 시작되기 전까지만 취소할 수 있다.',"
         "'배송 시작 전까지만 취소할 수 있다.',"
         "'{\"type\":\"paragraph\",\"text\":\"배송 시작 전까지만 취소할 수 있다.\"}','adopted','replace')"),
        ("flow node",
         "INSERT INTO flow(id,project,kind,ref,x,y,w,h,z,data) "
         "VALUES('F_000000000001','PRJ_a','node','S_cccccccccccc',10,20,240,120,1,'{}')"),
        ("flow edge",
         "INSERT INTO flow(id,project,kind,src,dst,label,z,data) "
         "VALUES('F_000000000002','PRJ_a','edge','F_000000000001','F_000000000001','applies_to',2,'{}')"),
        ("thread",
         "INSERT INTO thread(id,kind,created_at) VALUES('doc:D_aaaaaaaaaaaa','doc','t')"),
        ("event",
         "INSERT INTO event(thread_id,type,payload,at) "
         "VALUES('doc:D_aaaaaaaaaaaa','object.upsert','{\"id\":\"N_bbbbbbbbbbbb\"}','t')"),
        ("op_log",
         "INSERT INTO op_log(at,actor,kind,target,before,after) "
         "VALUES('t','person:u1','block.update','B_eeeeeeeeeeee','{\"text\":\"old\"}','{\"text\":\"new\"}')"),
        ("citation",
         "INSERT INTO citation(id,claim_id,block_id,source_kind,source_ref,quote) "
         "VALUES('CT_000000000001','N_bbbbbbbbbbbb','B_eeeeeeeeeeee','meeting','meet:2026-11-11',"
         "'배송 중에는 취소가 안 됩니다')"),
    ]
    for label, sql in normal_paths:
        expect_accept(conn, label, sql)

    # ── query plans: the indexes the design promises ───────────────────────
    plan_link = " | ".join(r[3] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT * FROM link WHERE src='N_bbbbbbbbbbbb'"))
    record("link.src uses link_src", "plan", "link_src" in plan_link, plan_link)

    plan_queue = " | ".join(r[3] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT * FROM link WHERE suspect_since IS NOT NULL AND acked_at IS NULL"))
    record("recheck queue uses link_queue", "plan", "link_queue" in plan_queue, plan_queue)

    plan_block = " | ".join(r[3] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT * FROM block "
        "WHERE doc_id='D_aaaaaaaaaaaa' AND parent_key='' AND idx='a0'"))
    record("sibling idx uses block_doc", "plan", "block_doc" in plan_block, plan_block)

    last_seq = conn.execute("SELECT last_seq FROM thread WHERE id='doc:D_aaaaaaaaaaaa'").fetchone()[0]
    record("thread.last_seq advances with events", "plan", last_seq == 1, f"last_seq={last_seq}")

    # ── Korean search: trigram for 3+ syllables, bigram as the fallback ─────
    def bigrams(text: str) -> str:
        packed = "".join(ch for ch in text if not ch.isspace())
        return " ".join(packed[i:i + 2] for i in range(len(packed) - 1))

    corpus = [
        ("B_100000000100", "배송이 시작되면 취소가 불가능합니다"),
        ("B_100000000101", "결제 취소 정책은 관리자가 승인합니다"),
        ("B_100000000102", "배송지 변경은 배송 시작 전까지 가능합니다"),
    ]
    for i, (block_id, text) in enumerate(corpus):
        conn.execute(
            "INSERT INTO block(id,doc_id,parent_id,idx,type,text,hash) "
            "VALUES(?,?,NULL,?,'paragraph',?,?)",
            (block_id, "D_aaaaaaaaaaaa", f"b{i}", text, "h" + block_id),
        )
        conn.execute("INSERT INTO search_chunk(id,block_id,ord,norm) VALUES(?,?,0,?)",
                     (i + 1, block_id, text.replace(" ", "")))
        conn.execute("INSERT INTO search(rowid,body,norm) VALUES(?,?,?)",
                     (i + 1, text, text.replace(" ", "")))
        conn.execute("INSERT INTO search_bi(rowid,bi) VALUES(?,?)", (i + 1, bigrams(text)))
    conn.commit()

    trigram3 = conn.execute("SELECT count(*) FROM search WHERE search MATCH '배송이'").fetchone()[0]
    trigram2 = conn.execute("SELECT count(*) FROM search WHERE search MATCH '배송'").fetchone()[0]
    bigram2 = conn.execute("SELECT count(*) FROM search_bi WHERE search_bi MATCH '배송'").fetchone()[0]
    bigram_phrase = conn.execute(
        "SELECT count(*) FROM search_bi WHERE search_bi MATCH '취소 정책'").fetchone()[0]

    record("trigram finds a 3-syllable query", "search", trigram3 == 1, f"{trigram3} rows")
    record("trigram cannot answer a 2-syllable query", "search", trigram2 == 0, f"{trigram2} rows")
    record("bigram answers a 2-syllable query", "search", bigram2 == 2, f"{bigram2} rows")
    record("bigram answers a phrase query", "search", bigram_phrase == 1, f"{bigram_phrase} rows")

    # Editing a block removes its chunks; the old text stops matching.
    conn.execute("DELETE FROM search WHERE rowid IN "
                 "(SELECT id FROM search_chunk WHERE block_id='B_100000000100')")
    conn.execute("DELETE FROM search_bi WHERE rowid IN "
                 "(SELECT id FROM search_chunk WHERE block_id='B_100000000100')")
    conn.execute("DELETE FROM search_chunk WHERE block_id='B_100000000100'")
    conn.commit()
    after = conn.execute("SELECT count(*) FROM search WHERE search MATCH '배송이'").fetchone()[0]
    record("deleting a chunk removes its match", "search", after == 0, f"{after} rows")

    # ── v2 is additive and executes on top of v1 ───────────────────────────
    try:
        conn.executescript(SCHEMA_V2.read_text())
        record("schema-v2 applies additively", "v2", True, "run · run_log · checkpoint")
    except Exception as exc:  # noqa: BLE001
        record("schema-v2 applies additively", "v2", False, str(exc))

    # ── report ─────────────────────────────────────────────────────────────
    width = max(len(label) for label, _, _, _ in results)
    for label, group, status, detail in results:
        print(f"{status:4s} [{group:6s}] {label.ljust(width)}  {detail}")

    groups = {
        "schema": 0,
        "reject": 0,
        "accept": 0,
        "plan": 0,
        "search": 0,
        "v2": 0,
    }
    totals = dict(groups)
    for _, group, status, _ in results:
        totals[group] += 1
        if status == "OK":
            groups[group] += 1

    print()
    for group in ("schema", "reject", "accept", "plan", "search", "v2"):
        print(f"{group:7s} {groups[group]:2d}/{totals[group]:2d}")

    failed = [label for label, _, status, _ in results if status != "OK"]
    if failed:
        print(f"\nFAILED: {len(failed)} expectation(s)")
        for label in failed:
            print(f"  - {label}")
        return 1
    print("\nPASS: schema contract holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
