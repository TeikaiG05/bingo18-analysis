# Phân tích dữ liệu Bingo18

## 1) Tóm tắt dữ liệu
- File gốc có **67,914** dòng.
- Sau khi loại **11** ID trùng lặp, còn **67,903** kỳ hợp lệ.
- Khoảng thời gian: **2024-12-03** đến **2026-03-22**.
- Phần lớn các ngày đầy đủ có **159 kỳ/ngày**.

## 2) Kết quả quan trọng
- Phân phối tổng thực tế bám rất sát mô hình **3 xúc xắc công bằng**.
- Kiểm định chi-square cho phân phối tổng:
  - chi2 = **15.311**
  - p-value = **0.429**
- Ý nghĩa: **không thấy lệch mạnh** đủ để kết luận có quy luật cứng.

### Top 6 tổng xuất hiện nhiều nhất
total
10    0.124324
11    0.123294
12    0.116166
9     0.115297
13    0.097757
8     0.096844

## 3) Đánh giá giả thuyết “ra Hòa thì kỳ sau nên giảm mạnh cửa Hòa”
- Tỷ lệ Hòa chung toàn bộ dữ liệu: **22.58%**
- Tỷ lệ Hòa ngay sau một kỳ Hòa: **23.60%**
- Tỷ lệ biên (3,4,5,16,17,18) chung: **9.27%**
- Tỷ lệ biên ngay sau kỳ Hòa: **9.01%**

### Kết luận
- **Không nên áp dụng luật cứng** kiểu “vừa Hòa xong thì giảm mạnh 10-11”.
- Trong dữ liệu, **Hòa sau Hòa không hề giảm rõ**, còn hơi nhỉnh hơn mức nền.
- Các số biên **không có dấu hiệu bật mạnh lên sau Hòa**.
- Vì vậy, app nên dùng **cơ chế chấm điểm xác suất mềm** thay vì boost/penalty cố định.

## 4) Thuật toán đề xuất
Mô hình: **Bayesian Contextual Scoring**
1. Giữ prior lý thuyết 3 xúc xắc.
2. Trộn với phân phối toàn lịch sử.
3. Điều chỉnh theo:
   - tổng kỳ trước,
   - trạng thái kỳ trước (Nhỏ/Lớn/Hòa),
   - slot trong ngày,
   - thứ trong tuần,
   - xu hướng trung hạn gần đây.
4. Dùng shrinkage để chống overfit.
5. Trả ra **Top 3 tổng** thay vì chốt 1 số duy nhất.

### Trọng số dùng trong bản mẫu
- theoretical: 1.00
- global: 1.00
- recent_medium: 0.10
- prev_state: 0.25
- prev_total: 0.25
- slot: 0.40
- weekday: 0.05

## 5) Kết quả backtest
- Baseline cố định top3 phổ biến nhất: **[10, 11, 12]**
- Hit@3 baseline trên holdout cuối tập: **36.60%**
- Hit@3 mô hình đề xuất trên holdout cuối tập: **36.76%**

### Diễn giải
- Mô hình có cải thiện, nhưng **không lớn**.
- Điều này cho thấy dữ liệu có thể chỉ chứa **tín hiệu yếu**, không phải quy luật mạnh.

## 6) Dự đoán kế tiếp từ dòng cuối file
Dòng cuối hiện tại:
- ID: **158546**
- Date: **2026-03-22**
- Total: **8**
- State: **Nhỏ**

Ngữ cảnh kế tiếp:
- **Ngày 2026-03-23**
- **slot 1 trong ngày**

Top 3 tổng cho kỳ kế tiếp:
1. **11** (12.41%)
2. **10** (12.38%)
3. **12** (11.58%)

## 7) Prompt gợi ý cho version app AI
```text
Bạn là AI phân tích lịch sử Bingo18 theo hướng xác suất có kiểm soát.

Mục tiêu:
- Đọc file lịch sử các kỳ quay.
- Làm sạch dữ liệu, loại trùng ID, chuẩn hóa ngày, tách 3 viên xúc xắc, tính tổng.
- Phân tích phân phối tổng theo:
  1) toàn bộ lịch sử,
  2) 50 kỳ gần nhất,
  3) 300 kỳ gần nhất,
  4) cùng slot trong ngày,
  5) cùng thứ trong tuần,
  6) sau trạng thái trước đó (Nhỏ/Lớn/Hòa),
  7) sau tổng trước đó.

Yêu cầu suy luận:
- Không dùng luật cứng.
- Không boost cực đoan cho các số biên chỉ vì vừa xuất hiện vài lần.
- Luôn giữ prior lý thuyết của 3 xúc xắc để chống overfit.
- Nếu tín hiệu ngữ cảnh yếu, ưu tiên bám xác suất nền.
- Nếu dữ liệu gần như ngẫu nhiên, phải nói rõ mức tự tin thấp.

Đầu ra mỗi kỳ:
- Top 3 tổng có xác suất cao nhất.
- Xác suất ước lượng cho từng tổng.
- Giải thích ngắn vì sao chọn 3 tổng đó.
- Sau khi có kết quả thực tế, tự động so sánh và ghi:
  date, id, prev_total, prev_state, pred_1, pred_2, pred_3, actual_total, hit_top3
- Cập nhật bộ nhớ thống kê để dùng cho kỳ sau mà không cần train lại toàn bộ.
```

## 8) File xuất ra
- `bingo18_prediction_log.csv`: log dự đoán vs thực tế, có cột Trúng/Trượt.
- `bingo18_model_state.json`: trạng thái thống kê hiện tại để app nạp lại nhanh.
- `bingo18_predictor.py`: mã mẫu để đọc file, dự đoán, cập nhật log và state.
