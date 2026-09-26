"""API 冒烟测试。"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_analyze_ok():
    resp = client.post("/api/analyze", json={
        "start_stitches": 10,
        "rows": ["k10", "[inc1 k1]*5"],
    })
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "ok"
    assert rows[0]["remaining"] == 10
    assert rows[1]["status"] == "ok"
    assert rows[1]["consumed"] == 10
    assert rows[1]["produced"] == 10


def test_analyze_shortage_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 5,
        "rows": ["k2 dec4"],
    })
    row = resp.json()["rows"][0]
    assert row["status"] == "shortage"
    assert row["failing_instruction"] == "dec4"
    assert row["shortage"] == 1
    assert row["failing_start"] == 3 and row["failing_end"] == 7


def test_analyze_validation_error():
    resp = client.post("/api/analyze", json={"start_stitches": -1, "rows": []})
    assert resp.status_code == 422


def test_analyze_adaptive_repeat_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 20,
        "rows": ["[k2]*~4 k4"],
    })
    row = resp.json()["rows"][0]
    assert row["status"] == "ok"
    assert len(row["adaptive_blocks"]) == 1
    blk = row["adaptive_blocks"][0]
    assert blk["actual_repeats"] == 8
    assert blk["target_remaining"] == 4
    assert blk["star_pos"] == 4 and blk["start"] == 0 and blk["end"] == 7
    assert row["expanded_count"] == 9


def test_analyze_adaptive_indivisible_error():
    resp = client.post("/api/analyze", json={
        "start_stitches": 20,
        "rows": ["[k2]*~5", "k1"],
    })
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "error"
    assert rows[0]["error_pos"] == 4
    assert rows[1]["status"] == "blocked"


def test_index_served():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "编织" in resp.text


def test_analyze_stitch_changes_payload():
    resp = client.post("/api/analyze", json={
        "start_stitches": 10,
        "rows": ["[inc2]*~4 k4", "k16"],
    })
    rows = resp.json()["rows"]
    row = rows[0]
    assert row["status"] == "ok"
    assert row["stitch_changes"] == [
        {"start": 1, "end": 5, "instruction": "inc2", "executions": 6,
         "consumed": 6, "produced": 12, "net": 6},
    ]
    # 净变化合计与该行产出减消耗核对一致
    assert row["stitch_net"] == 6 == row["produced"] - row["consumed"]
    # 纯 k 行生成空清单，净变化为 0
    assert rows[1]["status"] == "ok"
    assert rows[1]["stitch_changes"] == [] and rows[1]["stitch_net"] == 0


def test_analyze_stitch_changes_absent_for_failed_and_blocked():
    resp = client.post("/api/analyze", json={
        "start_stitches": 4,
        "rows": ["dec5", "inc2"],
    })
    rows = resp.json()["rows"]
    assert rows[0]["status"] == "shortage"
    assert rows[0]["stitch_changes"] == [] and rows[0]["stitch_net"] is None
    assert rows[1]["status"] == "blocked"
    assert rows[1]["stitch_changes"] == [] and rows[1]["stitch_net"] is None
