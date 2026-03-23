# Bingo18 Predictor v1

## Web Tab Tích Hợp

Đã gắn thêm một tab web trực tiếp vào app Node hiện có trong thư mục [bingo18-dashboard](/c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard).

Chạy:

```powershell
cd bingo18-dashboard
npm start
```

Mở route:

```text
http://127.0.0.1:3000/bingo18-top3
```

Tab này đã xuất hiện trong drawer menu của các trang chính.

Ứng dụng web local-first bằng Streamlit để dự đoán `top 3 tổng xúc xắc` cho kỳ tiếp theo, nhập kết quả thực tế, ghi `Trúng / Trượt`, cập nhật state/model nhẹ và xem thống kê hiệu quả.

## Stack đã chọn

- Python-only
- Streamlit cho UI
- Pandas + NumPy cho xử lý dữ liệu
- Plotly cho chart
- Pytest cho test cơ bản

Lý do chọn stack này: ít moving parts, local chạy nhanh, dễ refactor từ `bingo18_predictor.py`, không cần frontend/backend tách riêng cho v1.

## Cấu trúc project

```text
.
|-- app.py
|-- config/
|   `-- paths.json
|-- data/
|   `-- runtime/
|-- backups/
|-- scripts/
|   `-- bootstrap_data.py
|-- src/
|   `-- bingo18_app/
|       |-- analytics.py
|       |-- config.py
|       |-- data.py
|       |-- domain.py
|       |-- engine.py
|       |-- repository.py
|       `-- service.py
`-- tests/
    |-- test_data.py
    `-- test_engine.py
```

## Nguồn dữ liệu ban đầu

App đọc bootstrap từ các file mặc định trong `config/paths.json`:

- `../bingo18_analysis_report.md`
- `../bingo18_prediction_log.csv`
- `../bingo18_model_state.json`
- `../bingo18_predictor.py`
- `../bingo18.csv` (nếu có, dùng làm lịch sử gốc để dự đoán chính xác)

Mặc định các đường dẫn này trỏ tới thư mục cha của repo hiện tại, đúng với layout máy của bạn:

- repo: `C:\Users\giaki\Downloads\bingo18-dashboard`
- source files: `C:\Users\giaki\Downloads\...`

Nếu đổi vị trí file, chỉ cần sửa `config/paths.json`.

## Cách chạy

1. Cài Python 3.11+.
2. Tạo môi trường ảo:

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
```

3. Cài dependency:

```powershell
python -m pip install -r requirements.txt
```

4. Bootstrap dữ liệu runtime:

```powershell
python scripts/bootstrap_data.py
```

5. Chạy app:

```powershell
streamlit run app.py
```

6. Chạy test cơ bản:

```powershell
pytest
```

## Chức năng chính

### 1. Dự đoán hiện tại

- Hiển thị kỳ gần nhất trong dữ liệu
- Hiển thị kỳ đang chờ
- Hiển thị `top 3 tổng`
- Hiển thị xác suất từng tổng
- Hiển thị giải thích ngắn, trung thực, theo ngữ cảnh mềm:
  - prior xác suất 3 xúc xắc
  - phân phối dài hạn
  - ngữ cảnh tổng và trạng thái kỳ trước
  - slot trong ngày
  - xu hướng gần đây

### 2. Nhập kết quả thực tế

- Nhập `mã kỳ`, `ngày`, `slot`
- Nhập `3 viên xúc xắc` hoặc `tổng`
- Nếu nhập đủ 3 viên thì app tự tính tổng
- So sánh với `top 3` đang chờ
- Ghi `Trúng / Trượt`
- Upsert log theo `prediction_key` để tránh duplicate
- Update history + model state

### 3. Lịch sử

- Bảng dự đoán đã ghi log
- Filter theo:
  - gần nhất
  - ngày
  - Trúng / Trượt / Chờ kết quả
  - khoảng slot

### 4. Thống kê

- Hit rate toàn bộ
- Rolling 20 / 50 / 100
- Phân phối các tổng xuất hiện
- So sánh dự đoán vs thực tế
- Hiệu quả theo slot
- Hiệu quả theo trạng thái kỳ trước
- Hiệu quả theo nhóm biên `3-4-5` và `16-17-18`

### 5. Quản lý dữ liệu

- Upload CSV mới
- Validate schema trước khi merge
- Loại trùng theo mã kỳ
- Rebuild/sync state sau import
- Reconcile các pending prediction nếu kỳ đó đã xuất hiện trong history mới

## Logic model

Model hiện tại là bản refactor trực tiếp từ `bingo18_predictor.py`, tách thành các bước rõ ràng:

- `load/normalize history`
- `validate schema`
- `build/sync model state`
- `score_next_totals`
- `get_top3_prediction`
- `compare_with_actual`
- `update_prediction_log`
- `update_model_state`

Điểm chính:

- giữ `prior` lý thuyết 3 xúc xắc để chống overfit
- trộn thêm tín hiệu dài hạn + recent + prev_total + prev_state + slot + weekday
- không dùng luật cứng kiểu “sau Hòa thì phải giảm mạnh Hòa”
- update state theo kiểu incremental khi user nhập kết quả kỳ tiếp theo

## Runtime và an toàn dữ liệu

- File runtime nằm trong `data/runtime/`
- Trước khi ghi đè log/state/history, app backup file cũ vào `backups/`
- Log dùng `prediction_key` để tránh duplicate
- Nếu người dùng nhập lại cùng kỳ, app sẽ `update` thay vì append bừa

## Lưu ý

- Trong môi trường Codex hiện tại không có Python runtime trên PATH, nên tôi không thể chạy `streamlit` hay `pytest` để xác minh thực tế.
- Code đã được triển khai đầy đủ theo cấu trúc chạy local. Sau khi cài Python trên máy, bạn chỉ cần chạy theo các bước ở trên.
