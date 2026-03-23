from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from bingo18_app.data import normalize_history_dataframe, upsert_prediction_log  # noqa: E402


def test_normalize_history_dataframe_parses_result_and_slot() -> None:
    raw_df = pd.DataFrame(
        {
            "date": ["2026-03-22", "2026-03-22"],
            "id": ["158546", "158547"],
            "result": ["2 3 3", "6 6 6"],
        }
    )

    normalized = normalize_history_dataframe(raw_df)

    assert list(normalized["period_id"]) == ["158546", "158547"]
    assert list(normalized["slot_in_day"]) == [1, 2]
    assert list(normalized["total"]) == [8, 18]
    assert list(normalized["state"]) == ["Nhỏ", "Lớn"]


def test_upsert_prediction_log_prevents_duplicate_key() -> None:
    empty_log = pd.DataFrame()
    record = {
        "prediction_key": "period:158547",
        "predicted_period_id": "158547",
        "predicted_date": "2026-03-23",
        "predicted_slot_in_day": 1,
        "predicted_weekday": "Thứ Hai",
        "prediction_created_at": "2026-03-23T06:00:00+07:00",
        "status": "pending",
        "prev_total": 8,
        "prev_state": "Nhỏ",
        "predicted_top3": "11,10,12",
        "pred_1": 11,
        "pred_2": 10,
        "pred_3": 12,
        "prob_1": 0.12,
        "prob_2": 0.11,
        "prob_3": 0.10,
        "actual_total": None,
        "actual_state": None,
        "hit_top3": "Chờ kết quả",
        "model_version": "v1",
        "state_version": 2,
        "source": "test",
    }

    first_log, first_action = upsert_prediction_log(empty_log, record)
    second_log, second_action = upsert_prediction_log(first_log, record)

    assert first_action == "created"
    assert second_action == "unchanged"
    assert len(second_log) == 1
