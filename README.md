# AutoPushApp

AutoPushApp là CMS nội bộ để quản lý và build nhiều iOS project trên một Mac runner. Hệ thống hỗ trợ trigger build từ giao diện web hoặc Lark Bot, chạy Fastlane tuần tự qua BullMQ/Redis, phân phối bản build qua Firebase App Distribution, lưu lịch sử và hiển thị live log.

```text
React CMS / Lark
        -> Fastify API
        -> SQLite project registry + build snapshot
        -> BullMQ / Redis
        -> macOS worker (concurrency 1)
        -> Fastlane của từng iOS repository
        -> Firebase App Distribution
```

## Tính năng

- React/Vite CMS với admin Bearer token.
- CRUD project, validate cấu hình, enable/disable project.
- Mỗi project có repo path, Fastlane lane, scheme/configuration, Firebase App ID và tester groups riêng.
- Secret được giữ trong environment của runner; SQLite chỉ lưu **tên env var tham chiếu**, không lưu secret value.
- Quản lý Lark users và quyền build theo project.
- Trang **New build** cho phép chọn project iOS cần build thay vì dùng project cố định.
- Trigger build từ CMS hoặc lệnh `/build` trên Lark.
- Immutable project-config snapshot tại thời điểm enqueue.
- Idempotency cho CMS request và Lark webhook retry.
- Build history, dashboard, runner heartbeat, queue status và log viewer/download.
- Worker tuần tự trên Mac; retry là thao tác thủ công để tránh chạy lặp Fastlane/Firebase side effect.
- SQLite migrations giữ lại lịch sử của schema cũ.

## Yêu cầu

- Node.js >= 20 và npm.
- Redis 7+.
- macOS runner có Xcode, Ruby, Bundler và Fastlane.
- Mỗi iOS repo có `Gemfile` và `fastlane/Fastfile`.
- Apple Developer/App Store Connect credentials và Firebase App Distribution.

## Cài đặt

```bash
npm install
cp .env.example .env
docker compose up -d redis
npm run migrate
```

Tạo admin token đủ mạnh:

```bash
openssl rand -hex 32
```

Sau đó đặt kết quả vào `CMS_ADMIN_TOKEN` trong `.env`.

## Chạy development

API và React CMS:

```bash
npm run dev
```

- CMS: <http://localhost:5173>
- API: <http://localhost:3000>
- Health: <http://localhost:3000/health>

Worker chạy ở terminal khác trên máy Mac có Xcode:

```bash
npm run dev:worker
```

Không tự động start worker cùng API. Điều này tránh việc một web process vô tình chạy Fastlane trên host không phải build runner.

## Build production

```bash
npm run build
NODE_ENV=production SERVE_CMS=true npm start
npm run start:worker
```

`NODE_ENV=production` yêu cầu `CMS_ADMIN_TOKEN` dài ít nhất 32 ký tự. Fastify phục vụ bundle trong `web/dist` khi `SERVE_CMS=true`.

## Environment chính

Xem đầy đủ tại `.env.example`.

```dotenv
CMS_ADMIN_TOKEN=<random-token>
REDIS_URL=redis://localhost:6379
DB_PATH=./data/autopushapp.sqlite
LOG_DIR=./logs/builds
IOS_REPO_ROOTS=/Users/build/Projects/iOS,/Volumes/BuildRepos
FASTLANE_RUNNER_PATH=./scripts/run_fastlane.sh
BUILD_TIMEOUT_MS=3600000
RUNNER_ID=mac-mini-01
```

`IOS_REPO_ROOTS` là boundary bảo mật. CMS chỉ cho phép project có canonical `realpath` nằm dưới một trong các thư mục này.

### Secret theo project

Mọi project cần Firebase CLI token. Project dùng Match cần thêm Match password và App Store Connect API key:

```dotenv
MYAPP_FIREBASE_CLI_TOKEN=...
MYAPP_MATCH_PASSWORD=...
MYAPP_ASC_KEY_ID=...
MYAPP_ASC_ISSUER_ID=...
MYAPP_ASC_KEY_PATH=/secure/AuthKey_XXXXXXXXXX.p8
```

Trong CMS, project chỉ lưu tên biến môi trường:

```text
firebaseCliTokenEnvVar = MYAPP_FIREBASE_CLI_TOKEN
matchPasswordEnvVar = MYAPP_MATCH_PASSWORD
appStoreConnectKeyIdEnvVar = MYAPP_ASC_KEY_ID
appStoreConnectIssuerIdEnvVar = MYAPP_ASC_ISSUER_ID
appStoreConnectKeyPathEnvVar = MYAPP_ASC_KEY_PATH
```

Không nhập token/password/key content vào database hoặc project form. Nếu API và worker chạy thành hai process/service riêng, cả hai phải nhận cùng bộ biến môi trường: API dùng chúng khi Validate, worker dùng chúng khi thực thi build.

### Chế độ ký ad-hoc

Mỗi project chọn một trong hai signing mode:

- **Fastlane Match**: worker dùng Match password và App Store Connect API key, sau đó chạy `match(type: "adhoc", readonly: true)`. Worker cũng forward các biến Match tùy chọn cho private Git/custom keychain như `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_GIT_BEARER_AUTHORIZATION`, `MATCH_GIT_PRIVATE_KEY`, `MATCH_KEYCHAIN_NAME` và `MATCH_KEYCHAIN_PASSWORD`.
- **Manual signing**: không dùng Match hoặc App Store Connect credential. CMS lưu Apple Team ID, tên signing certificate và nhiều mapping `Bundle ID -> Provisioning Profile Name`.

Manual signing yêu cầu certificate kèm private key và các provisioning profile đã được cài sẵn cho đúng macOS user chạy worker. Xcode project phải được cấu hình để archive bằng các signing asset cục bộ đó; CMS mappings được đưa vào `exportOptions` để ký/export IPA và không tự sửa signing settings trong `.xcodeproj`. App chính, widget, notification service hoặc extension khác phải có mapping riêng. Tên profile trong CMS phải trùng với `Name` bên trong file `.mobileprovision`.

Các project cũ tự động giữ chế độ Match sau migration. Distribution method vẫn cố định là `ad-hoc`.

## Thêm một iOS project

1. Đảm bảo repo nằm dưới `IOS_REPO_ROOTS`.
2. Repo phải có `Gemfile` và `fastlane/Fastfile` theo contract mới trong `fastlane/Fastfile.example`.
3. Chạy `bundle install` trong repo.
4. Đăng nhập CMS bằng `CMS_ADMIN_TOKEN`.
5. Tạo project ở trạng thái disabled và điền:
   - project key + display name
   - absolute repository path
   - Fastlane lane, ví dụ `distribute`
   - scheme mặc định và optional build configuration; project mới mặc định dùng configuration `Debug`
   - Firebase App ID, tester groups và tên env var chứa Firebase token
   - signing mode: Match hoặc Manual
   - với Match: các tên env var Match/ASC
   - với Manual: Apple Team ID, signing certificate và toàn bộ Bundle ID/profile mappings
6. Chọn **Validate**. Backend kiểm tra path boundary, file bắt buộc, mode-specific configuration/env references và `bundle check`.
7. Enable project sau khi validation thành công.
8. Với Manual mode, chạy một build kiểm soát để xác nhận keychain identity và provisioning profiles thực sự khả dụng cho worker.

Mỗi lần sửa build configuration, project tự chuyển về disabled/validation unknown và cần validate lại. Khi trigger từ CMS, field Scheme được điền sẵn từ project nhưng có thể override riêng cho build đó; retry giữ lại scheme đã chọn. Build từ Lark tiếp tục dùng scheme mặc định đã lưu trong project.

## Fastlane lane contract

Worker gọi wrapper:

```text
scripts/run_fastlane.sh <repo_path> <lane> <build_number> <release_notes> <scheme> <configuration> <firebase_app_id> <firebase_groups> <app_version>
```

Wrapper chạy trong chính repository:

```bash
bundle exec fastlane <lane> \
  app_version:"1.1" \
  build_number:"6" \
  release_notes:"..." \
  scheme:"..." \
  configuration:"..." \
  firebase_app_id:"..." \
  firebase_groups:"..."
```

Worker giữ nguyên positional contract trên và truyền signing config qua environment:

```text
AUTOPUSH_SIGNING_MODE=match|manual
AUTOPUSH_APPLE_TEAM_ID=AB12CDEFGH
AUTOPUSH_SIGNING_CERTIFICATE=Apple Distribution
AUTOPUSH_PROVISIONING_PROFILES_JSON=[{"bundleId":"com.example.app","profileName":"Example App AdHoc"}]
```

Ở Match mode, worker tiếp tục truyền `MATCH_PASSWORD` và `APP_STORE_CONNECT_API_KEY_*`. Ở Manual mode, các credential này không được resolve hoặc đưa vào Fastlane process.

Dùng `fastlane/Fastfile.example` làm mẫu và cập nhật Fastfile trong từng iOS repository. Lane nhận riêng `app_version` và `build_number`, sau đó gọi `increment_version_number` và `increment_build_number` trước khi archive. Mỗi repo vẫn chịu trách nhiệm workspace/project và logic build riêng; AutoPushApp chuẩn hóa input, signing configuration và credentials.

## Lark Bot

Trong Lark Developer Console:

1. Enable capability **Bot**.
2. Cấp quyền nhận message gửi cho bot/group mention và quyền gửi message dưới danh nghĩa bot (`im:message:send_as_bot`).
3. Cấu hình Event Subscription tới public HTTPS endpoint:

```text
POST https://your-host/webhook/lark
```

4. Subscribe event `im.message.receive_v1`.
5. Publish/install app và thêm bot vào từng group cần nhận build notification.

Đặt `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`, `LARK_ENCRYPT_KEY` trong `.env`.

Mỗi project có field optional `larkNotificationChatId`, ví dụ `oc_xxxxxxxxxxxxxxxx`. AutoPush chỉ gửi kết quả cuối cùng tới group: `Đã có bản build 1.1 (6) trên Firebase.` khi thành công hoặc `build failed 1.1 (6)` khi thất bại; không gửi queued/started. Nếu project chưa có group mặc định, build được gọi từ Lark sẽ fallback về chat đã gửi command; CMS build sẽ không gửi Lark.

Để tìm `chat_id`, thêm bot vào group rồi gửi một build command. API log `Received Lark build command` chứa `chatId`, `userId` và `projectKey`; copy giá trị `oc_...` vào project settings trong CMS.

Lệnh:

```text
@AutoPush /build <project_key> <app_version> <build_number> "<release_notes>"
```

Ví dụ:

```text
@AutoPush /build prank-call-ios 1.1 6 "Lark notification test"
```

Parser tự loại bỏ phần mention bot. Trước khi enqueue, sender `open_id` phải tồn tại, đang enabled và được gán quyền build project đó trong CMS. Duplicate Lark deliveries dùng event/message ID để trả lại build hiện có thay vì tạo job mới.

Build mới bắt buộc nhập app version dạng `1`, `1.1` hoặc `1.1.0`. Build lịch sử trước migration có thể không có app version; retry các build này phải truyền app version mới và sẽ không gửi Lark nếu version không xác định.

## API

Public:

- `GET /health`
- `POST /webhook/lark`

Các endpoint dưới đây yêu cầu `Authorization: Bearer <CMS_ADMIN_TOKEN>`:

- `GET /api/session`
- `GET /api/dashboard`
- `GET|POST /api/projects`
- `GET|PUT|DELETE /api/projects/:projectKey`
- `POST /api/projects/:projectKey/validate`
- `POST /api/projects/:projectKey/builds`
- `GET|POST /api/users`
- `GET|PUT|DELETE /api/users/:userId`
- `PUT /api/users/:userId/project-permissions`
- `GET /api/builds`
- `GET /api/builds/:buildId`
- `GET /api/builds/:buildId/log`
- `GET /api/builds/:buildId/log/download`
- `POST /api/builds/:buildId/retry`

Build và retry endpoints yêu cầu header `Idempotency-Key`.

## Database và migration

SQLite mặc định nằm tại `data/autopushapp.sqlite`. Khi deploy:

```bash
cp data/autopushapp.sqlite data/autopushapp.sqlite.backup
npm run migrate
```

API và worker đều chạy migrations idempotently khi khởi động. Migration từ schema cũ giữ lịch sử nhưng không expose lại legacy absolute log paths.

## Queue và retry

Queue hiện tại là `ios-build-v3`. Worker dùng `concurrency: 1` và job chỉ có một automatic attempt. Nếu build fail hoặc worker bị dừng giữa Fastlane, dùng nút **Retry** trong CMS; hệ thống tạo record/job mới có liên kết tới build cũ.

Signing snapshot V2 làm thay đổi payload nên API và worker phải được deploy cùng phiên bản. Trước khi nâng cấp, dừng API enqueue mới, drain queue `ios-build-v2`, dừng worker cũ, rồi khởi động API/worker dùng `ios-build-v3`. Không chạy API mới cùng worker cũ.

## Log và bảo mật

- Log path do backend sinh: `logs/builds/<build-id>/attempt-<n>.log`.
- Database chỉ lưu relative path.
- Secret values được redact trước khi ghi log.
- Log API không nhận filesystem path và kiểm tra path traversal/symlink escape.
- Admin token lưu trong `sessionStorage`, không nằm trong URL hoặc frontend build.
- Production phải cấu hình `LARK_ENCRYPT_KEY`.
- Không commit `.env`, `.p8`, token, certificate hoặc Match password.
- Admin token là cơ chế MVP dùng chung; nếu CMS public hoặc có nhiều admin, nên nâng cấp sang SSO/session và audit identity riêng.

## Kiểm tra

```bash
npm run typecheck
npm test
npm run build
```

Kiểm tra end-to-end quan trọng:

1. Tạo project disabled, validate và enable.
2. Gán Lark user cho project.
3. Trigger từ CMS và Lark; xác nhận queue không tạo duplicate.
4. Sửa project sau khi enqueue; worker phải dùng snapshot cũ.
5. Xác nhận hai build không chạy overlap.
6. Xác nhận secret không xuất hiện trong log, SQLite, Redis payload hoặc API response.
7. Chạy một controlled build trên iOS repo thật trước khi rollout production.
