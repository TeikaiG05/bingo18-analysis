from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from bingo18_app.data import normalize_history_dataframe  # noqa: E402
from bingo18_app.engine import build_state_from_history, compare_with_actual, get_top3_prediction  # noqa: E402


def _sample_history() -> pd.DataFrame:
    raw_df = pd.DataFrame(
        {
            "date": ["2026-03-21", "2026-03-21", "2026-03-21", "2026-03-22"],
            "id": ["158543", "158544", "158545", "158546"],
            "result": ["4 4 3", "3 3 5", "5 5 4", "2 3 3"],
            "total": [11, 11, 14, 8],
        }
    )
    return normalize_history_dataframe(raw_df)


def test_get_top3_prediction_returns_three_ranked_totals() -> None:
    history_df = _sample_history()
    state = build_state_from_history(history_df)
    prediction = get_top3_prediction(history_df, state)

    assert len(prediction.top3) == 3
    assert prediction.top3[0].prob >= prediction.top3[1].prob >= prediction.top3[2].prob
    assert all(3 <= item.total <= 18 for item in prediction.top3)


def test_compare_with_actual_marks_hit_and_miss() -> None:
    history_df = _sample_history()
    state = build_state_from_history(history_df)
    prediction = get_top3_prediction(history_df, state)

    hit_total = prediction.top3[0].total
    miss_total = 3 if 3 not in prediction.top3_totals else 18

    assert compare_with_actual(prediction, hit_total)["hit_top3"] == "Trúng"
    assert compare_with_actual(prediction, miss_total)["hit_top3"] == "Trượt"
