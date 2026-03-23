# Local AI Maintenance Report

Generated: 2026-03-22T15:59:33.858Z
Latest round: 0158546
Dataset rounds: 67914
Eval rounds: 180
Train window: 320

## A. Thay doi pipeline
- Them pipeline versioned cho Local AI voi 4 triet ly: baseline, ngan han, can bang, on dinh.
- Dung feature co giai thich: nhip ngan han, nhip trung han, nen lich su, transition sau ky truoc, gap, deficit so voi prior, drift, edge boost theo gap.
- Chuan hoa confidence ve thang 0-1 va cham version theo backtest 20-30 ky thay vi chon cam tinh.
- Backfill worker cua AI LOCAL da doi sang baseline versioned thay cho rolling scorer cu.

## B. Danh sach version
- AI LOCAL Baseline (`local-baseline`): baseline doi chieu
- Short Pulse (`local-short-pulse`): thien ngan han
- Balanced Flow (`local-balanced-flow`): can bang ngan han va on dinh
- Stable Anchor (`local-stable-anchor`): thien on dinh trung han

## C. Top 3 tong hien tai cua tung version
- AI LOCAL Baseline: 6 (20.89%), 15 (8.97%), 9 (7.25%) | result=Small | confidence=78.13% | baseline doi chieu; do gan cua tong; do lech so voi tan suat tu nhien; phan ung sau cua ky truoc
- Short Pulse: 6 (12.86%), 15 (7.95%), 9 (7.17%) | result=Small | confidence=56.28% | thien ngan han; do gan cua tong; do lech so voi tan suat tu nhien; phan ung sau cua ky truoc
- Balanced Flow: 6 (16.14%), 15 (8.43%), 9 (7.14%) | result=Small | confidence=70.17% | can bang ngan han va on dinh; do gan cua tong; do lech so voi tan suat tu nhien; phan ung sau cua ky truoc
- Stable Anchor: 6 (20.73%), 15 (8.99%), 9 (7.29%) | result=Small | confidence=80.59% | thien on dinh trung han; do gan cua tong; do lech so voi tan suat tu nhien; prior ly thuyet

## D. Bang doi chieu 2-30 ky cho tung version

### AI LOCAL Baseline

| Window | Hits | Misses | Hit rate | Longest hit | Longest miss | Top totals de xuat nhieu nhat | Avg confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 0 | 2 | 0.00% | 0 | 2 | 6x2, 9x2, 15x2 | 79.87% |
| 3 | 0 | 3 | 0.00% | 0 | 3 | 6x3, 15x3, 9x2 | 81.97% |
| 4 | 0 | 4 | 0.00% | 0 | 4 | 6x4, 15x4, 3x2 | 83.03% |
| 5 | 0 | 5 | 0.00% | 0 | 5 | 6x5, 15x5, 3x2 | 84.03% |
| 6 | 0 | 6 | 0.00% | 0 | 6 | 6x6, 15x6, 3x2 | 83.16% |
| 7 | 1 | 6 | 14.29% | 1 | 6 | 6x7, 15x6, 3x2 | 83.52% |
| 8 | 1 | 7 | 12.50% | 1 | 6 | 6x8, 15x6, 8x3 | 82.91% |
| 9 | 1 | 8 | 11.11% | 1 | 6 | 6x9, 15x6, 3x3 | 83.03% |
| 10 | 1 | 9 | 10.00% | 1 | 6 | 6x10, 15x6, 13x4 | 83.18% |
| 11 | 1 | 10 | 9.09% | 1 | 6 | 6x11, 15x6, 13x5 | 82.70% |
| 12 | 1 | 11 | 8.33% | 1 | 6 | 6x12, 13x6, 15x6 | 82.71% |
| 13 | 1 | 12 | 7.69% | 1 | 6 | 6x13, 13x7, 15x6 | 82.26% |
| 14 | 1 | 13 | 7.14% | 1 | 7 | 6x14, 13x8, 15x6 | 82.03% |
| 15 | 1 | 14 | 6.67% | 1 | 8 | 6x15, 13x8, 8x6 | 81.71% |
| 16 | 1 | 15 | 6.25% | 1 | 9 | 6x16, 13x9, 8x7 | 81.57% |
| 17 | 1 | 16 | 5.88% | 1 | 10 | 6x17, 13x10, 8x8 | 81.95% |
| 18 | 2 | 16 | 11.11% | 1 | 10 | 6x18, 13x10, 8x9 | 82.12% |
| 19 | 3 | 16 | 15.79% | 2 | 10 | 6x19, 8x10, 13x10 | 82.21% |
| 20 | 3 | 17 | 15.00% | 2 | 10 | 6x20, 8x11, 13x10 | 82.25% |
| 21 | 3 | 18 | 14.29% | 2 | 10 | 6x21, 8x12, 13x10 | 82.10% |
| 22 | 4 | 18 | 18.18% | 2 | 10 | 6x22, 8x13, 13x10 | 82.37% |
| 23 | 4 | 19 | 17.39% | 2 | 10 | 6x23, 8x14, 13x10 | 82.24% |
| 24 | 5 | 19 | 20.83% | 2 | 10 | 6x24, 8x14, 13x10 | 82.25% |
| 25 | 5 | 20 | 20.00% | 2 | 10 | 6x25, 8x14, 13x10 | 82.01% |
| 26 | 6 | 20 | 23.08% | 2 | 10 | 6x26, 8x14, 13x10 | 82.24% |
| 27 | 6 | 21 | 22.22% | 2 | 10 | 6x27, 8x14, 13x10 | 82.19% |
| 28 | 6 | 22 | 21.43% | 2 | 10 | 6x28, 8x14, 13x10 | 82.15% |
| 29 | 6 | 23 | 20.69% | 2 | 10 | 6x29, 8x14, 13x10 | 82.16% |
| 30 | 6 | 24 | 20.00% | 2 | 10 | 6x30, 8x14, 15x11 | 82.20% |

### Short Pulse

| Window | Hits | Misses | Hit rate | Longest hit | Longest miss | Top totals de xuat nhieu nhat | Avg confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 0 | 2 | 0.00% | 0 | 2 | 6x2, 9x2, 15x2 | 64.99% |
| 3 | 0 | 3 | 0.00% | 0 | 3 | 6x3, 15x3, 9x2 | 70.25% |
| 4 | 0 | 4 | 0.00% | 0 | 4 | 6x4, 15x4, 8x2 | 72.70% |
| 5 | 0 | 5 | 0.00% | 0 | 5 | 6x5, 15x4, 8x3 | 74.53% |
| 6 | 0 | 6 | 0.00% | 0 | 6 | 6x6, 15x5, 8x4 | 72.47% |
| 7 | 1 | 6 | 14.29% | 1 | 6 | 6x7, 15x5, 8x4 | 73.14% |
| 8 | 1 | 7 | 12.50% | 1 | 6 | 6x8, 15x6, 8x4 | 71.94% |
| 9 | 1 | 8 | 11.11% | 1 | 6 | 6x9, 15x6, 8x4 | 71.91% |
| 10 | 1 | 9 | 10.00% | 1 | 6 | 6x10, 15x6, 13x5 | 71.72% |
| 11 | 1 | 10 | 9.09% | 1 | 6 | 6x11, 13x6, 15x6 | 71.21% |
| 12 | 1 | 11 | 8.33% | 1 | 6 | 6x12, 13x7, 15x6 | 70.97% |
| 13 | 1 | 12 | 7.69% | 1 | 6 | 6x13, 13x8, 8x6 | 70.79% |
| 14 | 1 | 13 | 7.14% | 1 | 7 | 6x14, 13x9, 8x7 | 70.43% |
| 15 | 1 | 14 | 6.67% | 1 | 8 | 6x15, 13x9, 8x8 | 70.07% |
| 16 | 1 | 15 | 6.25% | 1 | 9 | 6x16, 8x9, 13x9 | 70.50% |
| 17 | 1 | 16 | 5.88% | 1 | 10 | 6x17, 8x10, 13x10 | 71.27% |
| 18 | 2 | 16 | 11.11% | 1 | 10 | 6x18, 8x11, 13x10 | 71.47% |
| 19 | 3 | 16 | 15.79% | 2 | 10 | 6x19, 8x12, 13x10 | 71.38% |
| 20 | 3 | 17 | 15.00% | 2 | 10 | 6x20, 8x13, 13x10 | 71.41% |
| 21 | 3 | 18 | 14.29% | 2 | 10 | 6x21, 8x14, 13x10 | 71.02% |
| 22 | 4 | 18 | 18.18% | 2 | 10 | 6x22, 8x15, 13x10 | 71.42% |
| 23 | 4 | 19 | 17.39% | 2 | 10 | 6x23, 8x16, 13x10 | 71.29% |
| 24 | 5 | 19 | 20.83% | 2 | 10 | 6x24, 8x16, 13x10 | 71.19% |
| 25 | 5 | 20 | 20.00% | 2 | 10 | 6x25, 8x16, 13x10 | 70.89% |
| 26 | 6 | 20 | 23.08% | 2 | 10 | 6x26, 8x16, 13x11 | 70.81% |
| 27 | 6 | 21 | 22.22% | 2 | 10 | 6x27, 8x16, 13x11 | 70.38% |
| 28 | 6 | 22 | 21.43% | 2 | 10 | 6x28, 8x16, 13x11 | 70.01% |
| 29 | 7 | 22 | 24.14% | 2 | 10 | 6x29, 8x16, 13x11 | 69.96% |
| 30 | 7 | 23 | 23.33% | 2 | 10 | 6x30, 8x16, 13x11 | 69.85% |

### Balanced Flow

| Window | Hits | Misses | Hit rate | Longest hit | Longest miss | Top totals de xuat nhieu nhat | Avg confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 0 | 2 | 0.00% | 0 | 2 | 6x2, 9x2, 15x2 | 69.51% |
| 3 | 0 | 3 | 0.00% | 0 | 3 | 6x3, 15x3, 9x2 | 73.98% |
| 4 | 0 | 4 | 0.00% | 0 | 4 | 6x4, 15x4, 3x2 | 75.75% |
| 5 | 0 | 5 | 0.00% | 0 | 5 | 6x5, 15x5, 3x2 | 77.16% |
| 6 | 0 | 6 | 0.00% | 0 | 6 | 6x6, 15x6, 3x2 | 76.39% |
| 7 | 1 | 6 | 14.29% | 1 | 6 | 6x7, 15x6, 3x2 | 77.19% |
| 8 | 1 | 7 | 12.50% | 1 | 6 | 6x8, 15x6, 9x3 | 76.60% |
| 9 | 1 | 8 | 11.11% | 1 | 6 | 6x9, 15x6, 3x3 | 77.00% |
| 10 | 1 | 9 | 10.00% | 1 | 6 | 6x10, 15x6, 13x4 | 77.36% |
| 11 | 1 | 10 | 9.09% | 1 | 6 | 6x11, 15x6, 13x5 | 77.09% |
| 12 | 1 | 11 | 8.33% | 1 | 6 | 6x12, 13x6, 15x6 | 77.18% |
| 13 | 1 | 12 | 7.69% | 1 | 6 | 6x13, 13x7, 15x6 | 76.87% |
| 14 | 1 | 13 | 7.14% | 1 | 7 | 6x14, 13x8, 15x6 | 76.76% |
| 15 | 1 | 14 | 6.67% | 1 | 8 | 6x15, 13x8, 15x6 | 76.54% |
| 16 | 1 | 15 | 6.25% | 1 | 9 | 6x16, 13x9, 8x6 | 76.49% |
| 17 | 1 | 16 | 5.88% | 1 | 10 | 6x17, 13x10, 8x7 | 77.17% |
| 18 | 2 | 16 | 11.11% | 1 | 10 | 6x18, 13x10, 8x8 | 77.39% |
| 19 | 3 | 16 | 15.79% | 2 | 10 | 6x19, 13x10, 8x9 | 77.27% |
| 20 | 3 | 17 | 15.00% | 2 | 10 | 6x20, 8x10, 13x10 | 77.35% |
| 21 | 3 | 18 | 14.29% | 2 | 10 | 6x21, 8x11, 13x10 | 77.15% |
| 22 | 4 | 18 | 18.18% | 2 | 10 | 6x22, 8x12, 13x10 | 77.60% |
| 23 | 4 | 19 | 17.39% | 2 | 10 | 6x23, 8x13, 13x10 | 77.50% |
| 24 | 5 | 19 | 20.83% | 2 | 10 | 6x24, 8x13, 13x10 | 77.34% |
| 25 | 5 | 20 | 20.00% | 2 | 10 | 6x25, 8x13, 13x10 | 77.11% |
| 26 | 6 | 20 | 23.08% | 2 | 10 | 6x26, 8x13, 13x10 | 77.34% |
| 27 | 6 | 21 | 22.22% | 2 | 10 | 6x27, 8x13, 13x10 | 77.05% |
| 28 | 6 | 22 | 21.43% | 2 | 10 | 6x28, 8x13, 13x10 | 76.86% |
| 29 | 7 | 22 | 24.14% | 2 | 10 | 6x29, 8x13, 13x10 | 76.71% |
| 30 | 7 | 23 | 23.33% | 2 | 10 | 6x30, 8x13, 15x11 | 76.63% |

### Stable Anchor

| Window | Hits | Misses | Hit rate | Longest hit | Longest miss | Top totals de xuat nhieu nhat | Avg confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 0 | 2 | 0.00% | 0 | 2 | 6x2, 9x2, 15x2 | 82.52% |
| 3 | 0 | 3 | 0.00% | 0 | 3 | 6x3, 15x3, 9x2 | 84.35% |
| 4 | 0 | 4 | 0.00% | 0 | 4 | 6x4, 15x4, 3x2 | 85.26% |
| 5 | 0 | 5 | 0.00% | 0 | 5 | 6x5, 15x5, 3x2 | 85.81% |
| 6 | 0 | 6 | 0.00% | 0 | 6 | 6x6, 15x6, 3x2 | 85.09% |
| 7 | 1 | 6 | 14.29% | 1 | 6 | 6x7, 15x6, 3x2 | 85.51% |
| 8 | 1 | 7 | 12.50% | 1 | 6 | 6x8, 15x6, 9x3 | 84.93% |
| 9 | 1 | 8 | 11.11% | 1 | 6 | 6x9, 15x6, 3x3 | 85.13% |
| 10 | 1 | 9 | 10.00% | 1 | 6 | 6x10, 15x6, 13x4 | 85.33% |
| 11 | 1 | 10 | 9.09% | 1 | 6 | 6x11, 15x6, 13x5 | 84.88% |
| 12 | 1 | 11 | 8.33% | 1 | 6 | 6x12, 13x6, 15x6 | 84.70% |
| 13 | 1 | 12 | 7.69% | 1 | 6 | 6x13, 13x7, 15x6 | 84.26% |
| 14 | 1 | 13 | 7.14% | 1 | 7 | 6x14, 13x8, 15x6 | 84.06% |
| 15 | 1 | 14 | 6.67% | 1 | 8 | 6x15, 13x9, 15x6 | 83.86% |
| 16 | 1 | 15 | 6.25% | 1 | 9 | 6x16, 13x10, 8x6 | 83.74% |
| 17 | 1 | 16 | 5.88% | 1 | 10 | 6x17, 13x11, 8x7 | 83.99% |
| 18 | 2 | 16 | 11.11% | 1 | 10 | 6x18, 13x11, 8x8 | 84.20% |
| 19 | 3 | 16 | 15.79% | 2 | 10 | 6x19, 13x11, 8x9 | 84.33% |
| 20 | 3 | 17 | 15.00% | 2 | 10 | 6x20, 13x11, 8x10 | 84.39% |
| 21 | 3 | 18 | 14.29% | 2 | 10 | 6x21, 8x11, 13x11 | 84.26% |
| 22 | 4 | 18 | 18.18% | 2 | 10 | 6x22, 8x12, 13x11 | 84.43% |
| 23 | 4 | 19 | 17.39% | 2 | 10 | 6x23, 8x13, 13x11 | 84.30% |
| 24 | 5 | 19 | 20.83% | 2 | 10 | 6x24, 8x13, 13x11 | 84.31% |
| 25 | 5 | 20 | 20.00% | 2 | 10 | 6x25, 8x13, 13x11 | 84.08% |
| 26 | 6 | 20 | 23.08% | 2 | 10 | 6x26, 8x13, 13x11 | 84.23% |
| 27 | 6 | 21 | 22.22% | 2 | 10 | 6x27, 8x13, 13x11 | 84.17% |
| 28 | 6 | 22 | 21.43% | 2 | 10 | 6x28, 8x13, 13x11 | 84.13% |
| 29 | 6 | 23 | 20.69% | 2 | 10 | 6x29, 8x13, 13x11 | 84.11% |
| 30 | 6 | 24 | 20.00% | 2 | 10 | 6x30, 8x13, 13x11 | 84.18% |

## E. So sanh version
| Rank | Version | Score | Hit rate 30 ky | Longest miss 30 ky | Avg confidence 30 ky |
| --- | --- | --- | --- | --- | --- |
| 1 | Short Pulse | 0.1266 | 23.33% | 10 | 69.85% |
| 2 | Balanced Flow | 0.1266 | 23.33% | 10 | 76.63% |
| 3 | AI LOCAL Baseline | 0.1232 | 20.00% | 10 | 82.20% |
| 4 | Stable Anchor | 0.1232 | 20.00% | 10 | 84.18% |

## F. Version nen dung chinh
- Nen uu tien **Short Pulse** lam version chinh hien tai vi score backtest tong hop dang cao nhat trong nhom maintenance.

## G. Buoc cai tien tiep theo
- Tiep tuc hieu chinh confidence de giam do lech giua confidence va hit-rate 20-30 ky.
- Dua report maintenance vao UI/route rieng de doi chieu version truc tiep.
- Neu hit-rate 20-30 ky van duoi muc tieu, can them feature theo chuoi ket qua va profile theo khung gio/ngay.
- Khong khang dinh 100%; version duoc chon chi la version co so lieu backtest tot hon o thoi diem maintenance.
