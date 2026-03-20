# Deploy len Render

## 1. Day code len GitHub

Repo cua ban nen co cau truc:

- `render.yaml`
- `bingo18-dashboard/`

## 2. Tao Web Service tren Render

1. Dang nhap Render
2. Chon `New` -> `Blueprint`
3. Chon repo GitHub cua ban
4. Render se doc `render.yaml`
5. Bam `Apply`

Sau khi deploy xong, app se public qua URL dang:

- `https://<ten-service>.onrender.com`

## 3. Cac URL quan trong

- `/` : Dashboard chinh
- `/selective` : Selective V1
- `/selective-v2` : Selective V2
- `/predict` : JSON V1
- `/predict-v2` : JSON V2
- `/healthz` : Health check

## 4. Cach update trang web bat cu luc nao

Cach de nhat:

1. Sua code local
2. Commit
3. Push len nhanh chinh
4. Render tu dong redeploy vi `autoDeploy: true`

Neu muon redeploy thu cong:

1. Mo service trong Render
2. Chon `Manual Deploy`
3. Chon `Deploy latest commit`

## 5. Dieu can biet voi goi free

- Free Web Service co the sleep khi khong co request vao trong mot khoang thoi gian
- Moi lan redeploy hoac restart, file local co the khong duoc coi la luu tru ben vung
- App nay van co the tu dong dong bo lai du lieu tu source khi khoi dong

## 6. Bien moi truong co the chinh sau nay

- `PORT` : Render tu cap
- `NODE_ENV=production`
- `POLL_INTERVAL_MS=6000`
- `DATA_DIR`
- `DATA_FILE`

Neu khong set `DATA_DIR`/`DATA_FILE`, app mac dinh dung file:

- `bingo18-dashboard/data.json`
