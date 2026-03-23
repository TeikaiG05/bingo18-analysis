import json
import pandas as pd
import numpy as np
from collections import defaultdict, deque
from datetime import datetime, timedelta

TOTALS = list(range(3, 19))
THEO = {t: 0 for t in TOTALS}
for a in range(1, 7):
    for b in range(1, 7):
        for c in range(1, 7):
            THEO[a + b + c] += 1
THEO_PROB = {t: THEO[t] / 216 for t in TOTALS}

def parse_date(s):
    s = str(s)
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except Exception:
            pass
    return pd.to_datetime(s, dayfirst=True, errors="coerce").date()

def clean_history(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    nums = df["result"].astype(str).str.extract(r"(\d+)\s+(\d+)\s+(\d+)").astype(int)
    nums.columns = ["d1", "d2", "d3"]
    df = pd.concat([df, nums], axis=1)
    df["date_parsed"] = df["date"].apply(parse_date)
    df = df.sort_values("id").drop_duplicates(subset=["id"], keep="first").reset_index(drop=True)
    df["slot_in_day"] = df.groupby("date_parsed").cumcount() + 1
    df["weekday_idx"] = pd.to_datetime(df["date_parsed"]).dt.weekday
    return df

def init_empty_state():
    return {
        "version": 1,
        "weights": {
            "theoretical": 1.0,
            "global": 1.0,
            "recent_short": 0.0,
            "recent_medium": 0.1,
            "prev_state": 0.25,
            "prev_total": 0.25,
            "slot": 0.4,
            "weekday": 0.05,
        },
        "window_short": 50,
        "window_medium": 300,
        "totals": TOTALS,
        "theoretical_prob": {str(t): THEO_PROB[t] for t in TOTALS},
        "counts": {
            "global": {str(t): 0 for t in TOTALS},
            "prev_state": {k: {str(t): 0 for t in TOTALS} for k in ["Hòa", "Lớn", "Nhỏ"]},
            "prev_total": {str(k): {str(t): 0 for t in TOTALS} for k in TOTALS},
            "slot": {},
            "weekday": {str(i): {str(t): 0 for t in TOTALS} for i in range(7)},
        },
        "recent_windows": {"short": [], "medium": []},
        "last_observation": None,
    }

def ensure_slot(state, slot: int):
    slot = str(slot)
    if slot not in state["counts"]["slot"]:
        state["counts"]["slot"][slot] = {str(t): 0 for t in TOTALS}

def score_next(state, next_slot: int, next_weekday_idx: int, prev_total: int, prev_state: str):
    w = state["weights"]
    p = np.zeros(len(TOTALS), dtype=float)

    def vec_from_dict(d):
        return np.array([d[str(t)] for t in TOTALS], dtype=float)

    theo = np.array([state["theoretical_prob"][str(t)] for t in TOTALS], dtype=float)
    p += w["theoretical"] * theo

    global_cnt = vec_from_dict(state["counts"]["global"])
    p += w["global"] * ((global_cnt + 5 * theo) / (global_cnt.sum() + 5))

    short_list = state["recent_windows"]["short"]
    if w["recent_short"] and len(short_list) > 0:
        short_cnt = np.array([short_list.count(t) for t in TOTALS], dtype=float)
        p += w["recent_short"] * ((short_cnt + 2 * theo) / (short_cnt.sum() + 2))

    med_list = state["recent_windows"]["medium"]
    if w["recent_medium"] and len(med_list) > 0:
        med_cnt = np.array([med_list.count(t) for t in TOTALS], dtype=float)
        p += w["recent_medium"] * ((med_cnt + 2 * theo) / (med_cnt.sum() + 2))

    if prev_state in state["counts"]["prev_state"]:
        cnt = vec_from_dict(state["counts"]["prev_state"][prev_state])
        p += w["prev_state"] * ((cnt + theo) / (cnt.sum() + 1))

    prev_total = str(prev_total)
    if prev_total in state["counts"]["prev_total"]:
        cnt = vec_from_dict(state["counts"]["prev_total"][prev_total])
        p += w["prev_total"] * ((cnt + theo) / (cnt.sum() + 1))

    ensure_slot(state, next_slot)
    cnt = vec_from_dict(state["counts"]["slot"][str(next_slot)])
    p += w["slot"] * ((cnt + theo) / (cnt.sum() + 1))

    cnt = vec_from_dict(state["counts"]["weekday"][str(next_weekday_idx)])
    p += w["weekday"] * ((cnt + theo) / (cnt.sum() + 1))

    p = p / p.sum()
    order = np.argsort(-p)
    return [{"total": int(TOTALS[i]), "prob": float(p[i])} for i in order[:3]]

def update_state_with_actual(state, total: int, slot_in_day: int, weekday_idx: int, prev_total=None, prev_state=None, date_str=None, row_id=None):
    total = int(total)
    ensure_slot(state, slot_in_day)
    state["counts"]["global"][str(total)] += 1
    state["counts"]["slot"][str(slot_in_day)][str(total)] += 1
    state["counts"]["weekday"][str(weekday_idx)][str(total)] += 1

    if prev_state in ("Hòa", "Lớn", "Nhỏ"):
        state["counts"]["prev_state"][prev_state][str(total)] += 1
    if prev_total is not None:
        state["counts"]["prev_total"][str(int(prev_total))][str(total)] += 1

    state["recent_windows"]["short"].append(total)
    state["recent_windows"]["short"] = state["recent_windows"]["short"][-state["window_short"]:]
    state["recent_windows"]["medium"].append(total)
    state["recent_windows"]["medium"] = state["recent_windows"]["medium"][-state["window_medium"]:]

    state["last_observation"] = {
        "date": str(date_str),
        "id": int(row_id),
        "slot_in_day": int(slot_in_day),
        "weekday_idx": int(weekday_idx),
        "prev_total_for_next": int(total),
        "prev_state_for_next": "Hòa" if total in (10, 11) else ("Nhỏ" if total < 10 else "Lớn"),
    }

def build_state_from_history(df: pd.DataFrame):
    state = init_empty_state()
    prev_total = None
    prev_state = None
    for _, row in df.iterrows():
        update_state_with_actual(
            state=state,
            total=int(row["total"]),
            slot_in_day=int(row["slot_in_day"]),
            weekday_idx=int(row["weekday_idx"]),
            prev_total=prev_total,
            prev_state=prev_state,
            date_str=row["date_parsed"],
            row_id=int(row["id"]),
        )
        prev_total = int(row["total"])
        prev_state = "Hòa" if prev_total in (10, 11) else ("Nhỏ" if prev_total < 10 else "Lớn")
    return state

def next_context_from_last(state):
    last = state["last_observation"]
    if last is None:
        raise ValueError("State has no observations.")
    last_date = datetime.strptime(last["date"], "%Y-%m-%d").date()
    if int(last["slot_in_day"]) >= 159:
        next_date = last_date + timedelta(days=1)
        next_slot = 1
    else:
        next_date = last_date
        next_slot = int(last["slot_in_day"]) + 1
    next_weekday_idx = next_date.weekday()
    return next_date, next_slot, next_weekday_idx

def append_prediction_log(log_path: str, record: dict):
    try:
        log_df = pd.read_csv(log_path)
        log_df = pd.concat([log_df, pd.DataFrame([record])], ignore_index=True)
    except FileNotFoundError:
        log_df = pd.DataFrame([record])
    log_df.to_csv(log_path, index=False, encoding="utf-8-sig")

def main(history_csv="bingo18.csv", state_json="bingo18_model_state.json"):
    df = clean_history(history_csv)
    state = build_state_from_history(df)
    next_date, next_slot, next_weekday_idx = next_context_from_last(state)
    prev_total = state["last_observation"]["prev_total_for_next"]
    prev_state = state["last_observation"]["prev_state_for_next"]
    top3 = score_next(state, next_slot, next_weekday_idx, prev_total, prev_state)

    with open(state_json, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    print("Next context:", next_date, "slot", next_slot)
    print("Top 3 prediction:")
    for item in top3:
        print(item)

if __name__ == "__main__":
    main()
