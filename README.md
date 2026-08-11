# AutoPushApp

AutoPushApp là bảng điều khiển vận hành build iOS nội bộ. Hệ thống cho phép quản lý nhiều iOS repository, trigger build từ giao diện web hoặc Lark Bot, chạy Fastlane tuần tự trên máy Mac và phân phối IPA qua Firebase App Distribution.

> **CMS trong tài liệu này là giao diện React/Vite nằm ngay trong repository**, không phải Contentful, Strapi, Sanity hoặc một dịch vụ CMS bên thứ ba.

```text
Custom React CMS ─┐
                  ├─> Fastify API -> SQLite -> BullMQ / Redis
Lark Bot ─────────┘                         -> macOS worker (concurrency 1)
                                             -> Fastlane của từng iOS repo
                                             -> Firebase App Distribution
```

## Mục lục

- [1. Thành phần hệ thống](#1-thành-phần-hệ-thống)
- [2. Yêu cầu hệ thống](#2-yêu-cầu-hệ-thống)
- [3. Cài đặt từ máy mới](#3-cài-đặt-từ-máy-mới)
- [4. Xử lý lỗi `npm install`](#4-xử-lý-lỗi-npm-install)
- [5. Cấu hình `.env`](#5-cấu-hình-env)
- [6. Cách lấy các key và credentials](#6-cách-lấy-các-key-và-credentials)
- [7. Chạy development](#7-chạy-development)
- [8. Chuẩn bị iOS repository và Fastlane](#8-chuẩn-bị-ios-repository-và-fastlane)
- [9. Cấu hình project trên CMS](#9-cấu-hình-project-trên-cms)
- [10. Cấu hình Lark Bot](#10-cấu-hình-lark-bot)
- [11. Build, log và retry](#11-build-log-và-retry)
- [12. Build và chạy production](#12-build-và-chạy-production)
- [13. Database, queue và deploy upgrade](#13-database-queue-và-deploy-upgrade)
- [14. API chính](#14-api-chính)
- [15. Bảo mật vận hành](#15-bảo-mật-vận-hành)
- [16. Kiểm tra project](#16-kiểm-tra-project)
- [17. Troubleshooting vận hành](#17-troubleshooting-vận-hành)

---

## 1. Thành phần hệ thống

| Thành phần | Vai trò | Nơi chạy |
| --- | --- | --- |
| React/Vite CMS | Quản lý project, user, build và log | Development server hoặc được Fastify serve trong production |
| Fastify API | Admin API, Lark webhook, validate project, tạo build record và enqueue | Server chạy Node.js |
| SQLite | Lưu project, quyền Lark, build history và config snapshot | `DB_PATH`, mặc định `./data/autopushapp.sqlite` |
| Redis/BullMQ | Queue build iOS | Redis local, Docker hoặc Redis do tổ chức quản lý |
| macOS worker | Lấy job và chạy Fastlane | Máy Mac có Xcode và signing assets |
| Fastlane | Archive, sign và upload build | Nằm trong từng iOS repository |
| Firebase App Distribution | Phân phối build cho tester | Dịch vụ Firebase |
| Lark Bot | Nhận build command và gửi kết quả cuối | Lark internal app |

Các đặc điểm quan trọng:

- API và worker là **hai process riêng**.
- Worker dùng `concurrency: 1`: mỗi Mac runner chỉ chạy một Fastlane build tại một thời điểm.
- BullMQ job chỉ có một automatic attempt. Build lỗi phải retry thủ công để tránh lặp side effect của Xcode/Fastlane/Firebase.
- Project config được snapshot tại thời điểm enqueue. Sửa project sau đó không làm thay đổi build đã nằm trong queue.
- CMS chỉ lưu **tên environment variable** chứa secret; không lưu token/password/private key value vào SQLite.
- API cần thấy các secret env để validate project; worker cần thấy chúng để chạy build.
- API và worker phải dùng cùng `REDIS_URL`, `DB_PATH` và cùng phiên bản code/payload.

> Nếu API và worker chạy trên hai máy khác nhau, SQLite local mặc định không tự đồng bộ giữa hai máy. Cần topology/storage phù hợp hoặc chạy chúng trên cùng host/filesystem.

---

## 2. Yêu cầu hệ thống

### 2.1. Chỉ chạy API/CMS

- macOS hoặc Linux.
- Node.js:
  - Khuyến nghị: **Node.js 22 LTS**.
  - Tối thiểu thực tế với lockfile hiện tại: **Node.js 20.19+** hoặc **22.12+**.
- npm đi kèm Node.js.
- Redis 7+ hoặc Docker Desktop/Docker Engine.
- Xcode Command Line Tools trên macOS nếu native dependency phải build từ source.

Root `package.json` khai báo Node `>=20`, nhưng Vite được khóa trong `package-lock.json` yêu cầu Node `^20.19.0 || >=22.12.0`. Node 20.0–20.18 có thể báo `EBADENGINE` hoặc lỗi khi chạy Vite.

### 2.2. Chạy worker build iOS thật

Ngoài các yêu cầu trên, máy worker phải có:

- macOS.
- Xcode đầy đủ và Xcode Command Line Tools.
- Xcode license đã được chấp nhận và command-line tools đang trỏ đúng Xcode.
- Ruby, Bundler và Fastlane.
- Quyền truy cập các iOS repository.
- Certificate/private key, provisioning profiles hoặc Fastlane Match credentials.
- Firebase App Distribution credentials.
- Đúng macOS user có quyền dùng keychain/signing assets.

### 2.3. Tài khoản/dịch vụ bên ngoài

Tùy tính năng sử dụng:

- Apple Developer Program.
- App Store Connect API key nếu dùng Match mode.
- Firebase project có App Distribution.
- Lark Developer account/internal app nếu dùng Lark Bot.
- Git access tới Match repository nếu certificate/profile được quản lý bằng Match.

---

## 3. Cài đặt từ máy mới

### 3.1. Clone repository

```bash
git clone <AUTO_PUSH_APP_REPOSITORY_URL>
cd AutoPushApp
```

Mọi lệnh npm của AutoPushApp trong tài liệu này được chạy từ **root repository**, không chạy riêng trong `web/`.

### 3.2. Cài Node.js và npm trên macOS

#### Cách khuyến nghị: dùng `nvm`

Cài `nvm` theo hướng dẫn chính thức tại <https://github.com/nvm-sh/nvm>, sau đó:

```bash
nvm install 22
nvm use 22
nvm alias default 22
```

Nếu cài `nvm` bằng Homebrew:

```bash
brew install nvm
mkdir -p ~/.nvm
```

Thêm vào file shell profile phù hợp, ví dụ `~/.zshrc`:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix nvm)/nvm.sh" ] && \. "$(brew --prefix nvm)/nvm.sh"
```

Mở terminal mới rồi cài Node 22:

```bash
nvm install 22
nvm use 22
```

#### Lựa chọn khác

- Cài Node 22 bằng Homebrew.
- Dùng installer từ <https://nodejs.org/>.
- Dùng Node version manager được tổ chức chuẩn hóa như `asdf` hoặc `mise`.

Kiểm tra sau khi cài:

```bash
node --version
npm --version
uname -m
node -p "process.arch"
```

Ví dụ hợp lệ:

```text
v22.x.x
10.x.x hoặc 11.x.x
arm64
arm64
```

Trên Apple Silicon, nên để cả shell và Node chạy native `arm64`; tránh trộn Node x64 chạy qua Rosetta với dependency arm64.

### 3.3. Cài Xcode Command Line Tools

Trên macOS:

```bash
xcode-select --install
```

Kiểm tra:

```bash
xcode-select -p
clang --version
```

Command Line Tools thường chỉ được dùng khi native package như `better-sqlite3` không có prebuilt binary phù hợp và phải build bằng `node-gyp`.

### 3.4. Cài Docker/Redis

Cách đơn giản nhất là cài Docker Desktop, sau đó kiểm tra:

```bash
docker --version
docker compose version
```

Repository có `docker-compose.yml` chỉ chạy Redis 7.

Nếu không dùng Docker, cài Redis bằng phương thức phù hợp với hệ điều hành và đảm bảo `REDIS_URL` kết nối được.

### 3.5. Cài npm dependencies

Từ root repository:

```bash
npm install
```

Project dùng npm workspace với frontend ở `web/` và chỉ có một root `package-lock.json`. Không cần chạy thêm `npm install` trong `web`.

Sau khi cài, có thể kiểm tra workspace:

```bash
npm ls --depth=0
npm ls --workspace web --depth=0
```

### 3.6. Tạo `.env`

```bash
cp .env.example .env
```

Sinh admin token:

```bash
openssl rand -hex 32
```

Copy output vào `CMS_ADMIN_TOKEN` trong `.env`. Token này có 64 ký tự hex và đáp ứng yêu cầu production tối thiểu 32 ký tự.

Xem hướng dẫn chi tiết tại [Cấu hình `.env`](#5-cấu-hình-env) và [Cách lấy các key và credentials](#6-cách-lấy-các-key-và-credentials).

### 3.7. Start Redis

```bash
docker compose up -d redis
```

Kiểm tra container:

```bash
docker compose ps
```

Nếu máy có `redis-cli`:

```bash
redis-cli -u redis://localhost:6379 ping
```

Kết quả mong đợi:

```text
PONG
```

### 3.8. Chạy database migration

```bash
npm run migrate
```

SQLite parent directory sẽ được tạo tự động nếu chưa tồn tại. API và worker cũng chạy migrations idempotently khi start, nhưng nên chạy migration rõ ràng trong bước setup/deploy.

### 3.9. Chạy thử API và CMS

```bash
npm run dev
```

- CMS: <http://localhost:5173>
- API: <http://localhost:3000>
- Health: <http://localhost:3000/health>

Chưa cần chạy worker để kiểm tra CMS. Chỉ start worker khi máy đã được chuẩn bị để nhận build thật.

---

## 4. Xử lý lỗi `npm install`

### 4.1. `EBADENGINE`, Vite yêu cầu Node mới hơn

Kiểm tra:

```bash
node --version
npm --version
```

Nếu đang dùng Node 20.0–20.18, chuyển sang Node 20.19+ hoặc Node 22 LTS:

```bash
nvm install 22
nvm use 22
```

Sau khi đổi Node, cài lại native dependencies từ đầu:

```bash
rm -rf node_modules
npm install
```

Không xóa `package-lock.json` như bước xử lý đầu tiên. Lockfile là nguồn version đã được project khóa.

### 4.2. Lỗi `better-sqlite3`, `node-gyp`, `prebuild-install`

`better-sqlite3` là native Node addon. npm sẽ dùng prebuilt binary nếu có; nếu không có binary phù hợp với Node/OS/CPU hiện tại, nó fallback sang build từ source.

Kiểm tra toolchain:

```bash
xcode-select -p
clang --version
python3 --version
node -p "process.platform + ' ' + process.arch"
```

Cài Command Line Tools nếu thiếu:

```bash
xcode-select --install
```

Sau khi đổi Node hoặc architecture:

```bash
rm -rf node_modules
npm install
```

Bước nâng cao, chỉ dùng khi toolchain đã đúng và cần buộc rebuild:

```bash
npm rebuild better-sqlite3 --build-from-source
```

Các nguyên nhân thường gặp:

- Node version quá mới/cũ so với prebuilt binary có sẵn.
- Copy `node_modules` từ máy khác.
- Node chạy x64 qua Rosetta nhưng shell/hệ thống là arm64, hoặc ngược lại.
- Xcode Command Line Tools chưa cài hoặc path bị hỏng.
- Proxy/firewall chặn tải prebuilt binary.

### 4.3. Lỗi `esbuild` hoặc package sai platform

Dấu hiệu thường gặp:

- Package `@esbuild/<platform>-<arch>` không tồn tại.
- Binary được cài cho Darwin x64 nhưng đang chạy Darwin arm64.
- Optional dependency bị bỏ qua.

Kiểm tra:

```bash
uname -m
node -p "process.arch"
npm config get omit
```

Không reuse `node_modules` giữa:

- Intel Mac và Apple Silicon.
- macOS và Linux.
- Container và host.
- Các Node major version khác nhau.

Cài lại trên chính máy đích:

```bash
rm -rf node_modules
npm install
```

Nếu npm config đang omit optional dependency, sửa config trước khi cài. Không dùng `--omit=optional` cho project này vì esbuild sử dụng package theo platform.

### 4.4. Chạy npm sai thư mục hoặc workspace bị lệch

Đảm bảo đang đứng ở root:

```bash
pwd
ls package.json package-lock.json
```

Cài từ root:

```bash
npm install
```

Không tạo lockfile riêng trong `web/`. Nếu vô tình tạo `web/package-lock.json` hoặc `web/node_modules`, cần review và loại bỏ setup lệch trước khi cài lại từ root.

### 4.5. Lỗi proxy, registry, timeout hoặc TLS

Chẩn đoán:

```bash
npm config get registry
npm config get proxy
npm config get https-proxy
npm ping
npm cache verify
```

Registry mặc định thường là:

```text
https://registry.npmjs.org/
```

Nếu công ty dùng private registry/proxy, dùng cấu hình do tổ chức cung cấp. Nếu có TLS interception, cài CA hợp lệ vào hệ thống/npm thay vì tắt kiểm tra SSL.

Không khuyến nghị:

```bash
npm config set strict-ssl false
```

Chỉ xóa cache khi `npm cache verify` xác nhận vấn đề hoặc cache thật sự bị hỏng:

```bash
npm cache clean --force
```

### 4.6. Clean install theo lockfile

Khi cần môi trường sạch/reproducible và `package-lock.json` không thay đổi:

```bash
rm -rf node_modules
npm ci
```

`npm ci` sẽ fail nếu `package.json` và `package-lock.json` không đồng bộ. Khi đó cần xác định dependency change hợp lệ, không tự động regenerate lockfile chỉ để bỏ qua lỗi.

---

## 5. Cấu hình `.env`

Bắt đầu từ file mẫu:

```bash
cp .env.example .env
```

### 5.1. Ví dụ cấu hình local tối thiểu cho CMS/API

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info

CMS_ADMIN_TOKEN=<RANDOM_TOKEN_FROM_OPENSSL>
CMS_DEV_ORIGIN=http://localhost:5173
SERVE_CMS=false
CMS_DIST_PATH=./web/dist

REDIS_URL=redis://localhost:6379
DB_PATH=./data/autopushapp.sqlite
LOG_DIR=./logs/builds
IOS_REPO_ROOTS=/Users/build/Projects/iOS
FASTLANE_RUNNER_PATH=./scripts/run_fastlane.sh
BUILD_TIMEOUT_MS=3600000
RUNNER_ID=mac-mini-01
```

Để chỉ xem CMS, có thể chưa cấu hình Lark và per-project secret. Tuy nhiên project validation/build sẽ fail nếu thiếu các env mà project tham chiếu.

### 5.2. API/CMS variables

| Variable | Bắt buộc | Default | Mô tả |
| --- | --- | --- | --- |
| `NODE_ENV` | Không | `development` | `development`, `test` hoặc `production` |
| `HOST` | Không | `0.0.0.0` | Interface Fastify listen |
| `PORT` | Không | `3000` | API port |
| `LOG_LEVEL` | Không | `info` | Pino log level |
| `CMS_ADMIN_TOKEN` | Có trong production | Dev fallback có sẵn | Shared Bearer token để login CMS và gọi `/api/*` |
| `CMS_DEV_ORIGIN` | Không | `http://localhost:5173` | CORS origin trong development |
| `SERVE_CMS` | Không | `false` ở development | Cho phép Fastify serve frontend build |
| `CMS_DIST_PATH` | Không | `./web/dist` | Thư mục frontend production build |

Lưu ý:

- `CMS_ADMIN_TOKEN` phải có ít nhất 16 ký tự theo schema và ít nhất **32 ký tự trong production**.
- Ở production, code hiện tự đặt `SERVE_CMS=true` dù `.env` ghi `false`. Vì vậy phải chạy `npm run build` để có `web/dist/index.html` trước khi start API production.
- Browser lưu token trong `sessionStorage` với key `autopush.adminToken` và gửi qua `Authorization: Bearer <token>`.
- Đây là shared admin token MVP, không phải hệ thống tài khoản/SSO nhiều admin.

### 5.3. Redis, SQLite và runner variables

| Variable | Bắt buộc | Default | Mô tả |
| --- | --- | --- | --- |
| `REDIS_URL` | Có | `redis://localhost:6379` | Redis dùng cho BullMQ |
| `DB_PATH` | Có | `./data/autopushapp.sqlite` | SQLite database |
| `LOG_DIR` | Có | `./logs/builds` | Root build log directory |
| `IOS_REPO_ROOTS` | Có để validate/build | Rỗng | Danh sách comma-separated root directories được phép |
| `FASTLANE_RUNNER_PATH` | Có cho worker | `./scripts/run_fastlane.sh` | Wrapper gọi Fastlane |
| `BUNDLE_BIN` | Không | `bundle` từ `PATH` | Absolute path tới Bundler nếu system `bundle` dùng sai Ruby |
| `BUILD_TIMEOUT_MS` | Không | `3600000` | Timeout một Fastlane build, mặc định 1 giờ |
| `RUNNER_ID` | Không | Hostname | ID heartbeat của worker |

Ví dụ nhiều repo root:

```dotenv
IOS_REPO_ROOTS=/Users/build/Projects/iOS,/Volumes/BuildRepos
```

`IOS_REPO_ROOTS` là boundary bảo mật. Backend resolve canonical `realpath` và từ chối repository nằm ngoài các root này, kể cả trường hợp symlink escape.

Nếu `bundle` đúng không nằm trong service `PATH`, tìm path:

```bash
which bundle
```

Sau đó cấu hình, ví dụ:

```dotenv
BUNDLE_BIN=/opt/homebrew/bin/bundle
```

### 5.4. Lark variables

```dotenv
LARK_APP_ID=<LARK_APP_ID>
LARK_APP_SECRET=<LARK_APP_SECRET>
LARK_VERIFICATION_TOKEN=<LARK_EVENT_VERIFICATION_TOKEN>
LARK_ENCRYPT_KEY=<LARK_EVENT_ENCRYPT_KEY>
LARK_API_BASE_URL=https://open.larksuite.com
```

`LARK_API_BASE_URL` nên giữ default, trừ khi tenant/region của tổ chức yêu cầu endpoint khác.

### 5.5. Per-project secret variables

Ví dụ project key `customer-ios`:

```dotenv
CUSTOMER_IOS_FIREBASE_CLI_TOKEN=<FIREBASE_CLI_TOKEN>
CUSTOMER_IOS_MATCH_PASSWORD=<MATCH_PASSWORD>
CUSTOMER_IOS_ASC_KEY_ID=<APP_STORE_CONNECT_KEY_ID>
CUSTOMER_IOS_ASC_ISSUER_ID=<APP_STORE_CONNECT_ISSUER_ID>
CUSTOMER_IOS_ASC_KEY_PATH=/secure/apple/AuthKey_XXXXXXXXXX.p8
```

`.env.example` dùng các tên mẫu `MYAPP_FIREBASE_CLI_TOKEN`, `MYAPP_MATCH_PASSWORD`, `MYAPP_ASC_KEY_ID`, `MYAPP_ASC_ISSUER_ID` và `MYAPP_ASC_KEY_PATH`. Có thể giữ nguyên các tên đó hoặc đổi prefix theo từng project; tên trong CMS phải khớp tuyệt đối với tên trong môi trường API/worker.

Trong CMS chỉ nhập **tên biến**:

```text
Firebase CLI token env: CUSTOMER_IOS_FIREBASE_CLI_TOKEN
Match password env: CUSTOMER_IOS_MATCH_PASSWORD
ASC key ID env: CUSTOMER_IOS_ASC_KEY_ID
ASC issuer ID env: CUSTOMER_IOS_ASC_ISSUER_ID
ASC key path env: CUSTOMER_IOS_ASC_KEY_PATH
```

Không nhập token/password/nội dung `.p8` trực tiếp vào CMS.

Nếu API và worker là hai services riêng, cả hai phải nhận cùng các env trên:

- API dùng value để Validate.
- Worker resolve value và đưa vào Fastlane process khi build.

### 5.6. Optional Fastlane Match variables

Chỉ cần khi Match repo/private Git/custom keychain yêu cầu:

```dotenv
MATCH_GIT_BASIC_AUTHORIZATION=<OPTIONAL_VALUE>
MATCH_GIT_BEARER_AUTHORIZATION=<OPTIONAL_VALUE>
MATCH_GIT_PRIVATE_KEY=/secure/match/match-deploy-key
MATCH_KEYCHAIN_NAME=ci-signing.keychain-db
MATCH_KEYCHAIN_PASSWORD=<OPTIONAL_KEYCHAIN_PASSWORD>
```

Cách tạo/format các giá trị Git auth phụ thuộc Git host và phiên bản Fastlane Match đang dùng. Kiểm tra tài liệu Fastlane/Match của iOS repository thay vì áp dụng một format chung cho mọi hệ thống.

### 5.7. Deprecated variables

Các biến sau chỉ còn để tương thích trong quá trình migrate từ cấu hình single-project cũ và không nên dùng cho setup mới:

```text
ALLOWED_USER_IDS
ALLOWED_PROJECT_IDS
IOS_PROJECT_PATH
FASTLANE_SCRIPT_PATH
START_WORKER_IN_PROCESS
```

---

## 6. Cách lấy các key và credentials

### 6.1. `CMS_ADMIN_TOKEN`

Token này do đội vận hành tự sinh, không lấy từ dịch vụ bên ngoài:

```bash
openssl rand -hex 32
```

Đặt output vào:

```dotenv
CMS_ADMIN_TOKEN=<OUTPUT>
```

Production yêu cầu ít nhất 32 ký tự. Không gửi token qua URL, chat công khai hoặc commit vào Git.

### 6.2. Lark App ID và App Secret

Quy trình tổng quát trong Lark Developer Console:

1. Tạo một **Internal App** cho tenant/tổ chức.
2. Mở phần thông tin cơ bản/credentials của app.
3. Copy:
   - App ID → `LARK_APP_ID`.
   - App Secret → `LARK_APP_SECRET`.
4. Bật capability **Bot**.
5. Cấp quyền nhận message phù hợp và quyền gửi message dưới danh nghĩa bot, gồm `im:message:send_as_bot`.
6. Publish/install app theo quy trình quản trị của tenant.

Tên menu có thể khác theo phiên bản console, Lark/Feishu và region. Cần tìm đúng phần chứa App Credentials của internal app.

### 6.3. Lark Verification Token và Encrypt Key

Trong phần Event Subscription/Security của Lark app:

1. Cấu hình callback HTTPS:

   ```text
   https://<PUBLIC_HOST>/webhook/lark
   ```

2. Copy Verification Token → `LARK_VERIFICATION_TOKEN`.
3. Bật/cấu hình Encrypt Key và copy → `LARK_ENCRYPT_KEY`.
4. Subscribe event:

   ```text
   im.message.receive_v1
   ```

5. Hoàn thành URL verification challenge khi Lark gọi callback.

Code chỉ thực hiện timestamp/signature verification khi `LARK_ENCRYPT_KEY` được đặt. Ở production, thiếu key hiện chỉ log warning, nên đội vận hành phải coi `LARK_ENCRYPT_KEY` là yêu cầu bảo mật bắt buộc.

### 6.4. Firebase App ID

Trong Firebase Console:

1. Mở đúng Firebase project.
2. Vào **Project settings**.
3. Chọn iOS app tương ứng.
4. Copy App ID có dạng gần giống:

   ```text
   1:1234567890:ios:abcdef123456
   ```

5. Nhập value này vào field **Firebase app ID** của project trên CMS.

Không nhầm Firebase App ID với iOS Bundle ID hoặc Google App ID trong file khác.

### 6.5. Firebase tester groups

Trong Firebase App Distribution:

1. Tạo hoặc kiểm tra các tester groups.
2. Dùng group alias/name mà Fastlane Firebase App Distribution plugin chấp nhận.
3. Nhập nhiều group trong CMS, phân cách bằng dấu phẩy, ví dụ:

   ```text
   qa, internal-testers
   ```

### 6.6. Firebase CLI token

Fastlane contract hiện tại truyền `firebase_cli_token` vào Firebase App Distribution plugin. Vì vậy worker cần một token dùng được trong non-interactive build.

Tạo token bằng phương thức được phiên bản Firebase CLI hiện hành hỗ trợ cho tài khoản/tổ chức. Một số phiên bản/workflow cũ sử dụng:

```bash
firebase login:ci
```

Sau khi nhận token:

1. Không paste token vào CMS.
2. Lưu token vào `.env` hoặc secret manager của API/worker:

   ```dotenv
   CUSTOMER_IOS_FIREBASE_CLI_TOKEN=<TOKEN>
   ```

3. Trong CMS nhập tên biến:

   ```text
   CUSTOMER_IOS_FIREBASE_CLI_TOKEN
   ```

Firebase CLI authentication recommendations có thể thay đổi. Kiểm tra tài liệu Firebase CLI/App Distribution plugin đang dùng trước khi rollout. Code hiện không forward `GOOGLE_APPLICATION_CREDENTIALS`, nên service account không phải drop-in replacement nếu chưa sửa implementation/Fastfile.

### 6.7. Fastlane Match password

`MATCH_PASSWORD` là passphrase dùng để mã hóa/giải mã certificate và provisioning profile trong Match storage.

- Nếu Match repository đã tồn tại, lấy password từ secret manager/đội đang quản lý signing.
- Password phải khớp với repository hiện tại; tạo một password mới tùy ý sẽ không giải mã được assets cũ.
- Lưu value vào env, ví dụ:

  ```dotenv
  CUSTOMER_IOS_MATCH_PASSWORD=<MATCH_PASSWORD>
  ```

- Trên CMS chỉ nhập `CUSTOMER_IOS_MATCH_PASSWORD`.

### 6.8. App Store Connect Key ID, Issuer ID và `.p8`

Trong App Store Connect, dùng tài khoản có quyền quản lý API keys:

1. Mở phần Users and Access/Integrations/API Keys tương ứng với UI hiện tại.
2. Tạo hoặc chọn một App Store Connect API key có role phù hợp với workflow build/signing.
3. Ghi lại:
   - **Key ID** → `CUSTOMER_IOS_ASC_KEY_ID`.
   - **Issuer ID** → `CUSTOMER_IOS_ASC_ISSUER_ID`.
4. Download private key `.p8`.
5. Chuyển file tới thư mục bảo mật trên runner, ví dụ:

   ```text
   /secure/apple/AuthKey_XXXXXXXXXX.p8
   ```

6. Đảm bảo macOS user chạy worker có quyền đọc file.
7. Đặt absolute path vào env:

   ```dotenv
   CUSTOMER_IOS_ASC_KEY_PATH=/secure/apple/AuthKey_XXXXXXXXXX.p8
   ```

Apple thường chỉ cho download `.p8` một lần. Phải backup vào secret storage phù hợp; không commit file vào repository.

### 6.9. Manual signing credentials

Manual mode không cần Match password hoặc ASC key env. Thay vào đó:

1. Import Apple Distribution certificate **kèm private key** vào keychain của đúng macOS user chạy worker.
2. Cài provisioning profiles cho app và mọi extension được archive.
3. Xác định Apple Team ID 10 ký tự.
4. Xác định certificate label, mặc định thường là `Apple Distribution`.
5. Xác định tên profile bên trong từng `.mobileprovision`.
6. Trên CMS map từng concrete Bundle ID tới profile name.

Ví dụ:

```text
com.company.customerapp                 -> Customer App AdHoc
com.company.customerapp.Notification    -> Customer Notification AdHoc
com.company.customerapp.Widget          -> Customer Widget AdHoc
```

Không dùng wildcard Bundle ID. CMS không tự import certificate/profile và không tự sửa signing settings trong `.xcodeproj`.

---

## 7. Chạy development

### 7.1. Start Redis

```bash
docker compose up -d redis
```

### 7.2. Start API và CMS

```bash
npm run dev
```

Script này chạy song song:

- API: `tsx watch src/index.ts`.
- Web: Vite workspace `web`.

Vite proxy `/api` sang `http://localhost:3000`.

### 7.3. Start worker riêng

Chỉ chạy trên Mac đã sẵn sàng nhận build:

```bash
npm run dev:worker
```

Không start worker chỉ để kiểm tra giao diện. Khi worker kết nối cùng Redis, nó có thể nhận job và chạy Fastlane thật.

### 7.4. Kiểm tra health

```bash
curl http://localhost:3000/health
```

Health response kiểm tra database, Redis và runner heartbeat.

Nếu worker chưa chạy, phần runner có thể báo chưa sẵn sàng; điều này không ngăn việc phát triển giao diện/API cơ bản.

---

## 8. Chuẩn bị iOS repository và Fastlane

Mỗi iOS repository phải nằm dưới một root trong `IOS_REPO_ROOTS` và có:

```text
<ios-repo>/Gemfile
<ios-repo>/fastlane/Fastfile
```

### 8.1. Cài Ruby dependencies trong iOS repo

```bash
cd /path/to/ios-repo
bundle install
bundle check
```

AutoPushApp validation chạy `bundle check` với timeout 15 giây. Nếu `bundle` của service dùng sai Ruby, cấu hình `BUNDLE_BIN` trong môi trường API/worker.

### 8.2. Fastlane plugin

Fastfile mẫu sử dụng Firebase App Distribution plugin. iOS repo phải có Gemfile/Pluginfile phù hợp và `bundle install` thành công.

Tham khảo các file trong AutoPushApp:

- `fastlane/Fastfile.example`
- `fastlane/Appfile.example`
- `fastlane/Matchfile.example`
- `fastlane/Pluginfile`

Copy/adapt các file mẫu vào **từng iOS repository**; không giả định mọi project có cùng workspace, project hoặc scheme.

### 8.3. Wrapper contract

Worker gọi:

```text
scripts/run_fastlane.sh \
  <repo_path> \
  <lane> \
  <build_number> \
  <release_notes> \
  <scheme> \
  <configuration> \
  <firebase_app_id> \
  <firebase_groups> \
  <app_version>
```

Wrapper chuyển vào repo và chạy tương đương:

```bash
bundle exec fastlane <lane> \
  app_version:"1.1" \
  build_number:"6" \
  release_notes:"..." \
  scheme:"Customer" \
  configuration:"Debug" \
  firebase_app_id:"1:1234567890:ios:abcdef" \
  firebase_groups:"qa,internal-testers"
```

### 8.4. Signing environment được worker truyền

Common:

```text
FIREBASE_CLI_TOKEN=<resolved per-project secret>
AUTOPUSH_SIGNING_MODE=match|manual
```

Match mode:

```text
MATCH_PASSWORD
APP_STORE_CONNECT_API_KEY_ID
APP_STORE_CONNECT_API_ISSUER_ID
APP_STORE_CONNECT_API_KEY_PATH
```

Manual mode:

```text
AUTOPUSH_APPLE_TEAM_ID=AB12CDEFGH
AUTOPUSH_SIGNING_CERTIFICATE=Apple Distribution
AUTOPUSH_PROVISIONING_PROFILES_JSON=[{"bundleId":"com.company.app","profileName":"App AdHoc"}]
```

Ở Manual mode, Match/ASC credentials không được resolve hoặc forward vào Fastlane process.

Fastfile mẫu sử dụng distribution method `ad-hoc`, gọi `increment_version_number`, `increment_build_number`, archive bằng `gym` rồi upload Firebase.

---

## 9. Cấu hình project trên CMS

### 9.1. Login CMS

1. Mở <http://localhost:5173> trong development hoặc URL production.
2. Nhập đúng `CMS_ADMIN_TOKEN`.
3. CMS gọi `GET /api/session` để xác minh.
4. Token được lưu trong `sessionStorage` của browser tab/session.

Đây là shared administrator token. Lark users ở mục Users không dùng để login CMS.

### 9.2. Tạo project mới

Vào **Projects** → **Create project**.

Khuyến nghị tạo project lần đầu ở trạng thái **disabled**, hoàn thành validation rồi mới enable.

#### Nhóm 01 — Identity & repository

| Field | Cách điền |
| --- | --- |
| Project key | ID ổn định, ví dụ `customer-ios`; chỉ dùng chữ, số, `_`, `.`, `-` |
| Display name | Tên hiển thị, ví dụ `Customer iOS` |
| Repository path | Absolute path trên runner, ví dụ `/Users/build/repos/customer-ios` |

Repository path phải tồn tại và canonical path phải nằm dưới `IOS_REPO_ROOTS`.

#### Nhóm 02 — Build settings

| Field | Cách điền |
| --- | --- |
| Fastlane lane | Lane trong iOS Fastfile, mặc định UI là `distribute` |
| Scheme | Scheme mặc định; có thể để trống nếu Fastfile tự quyết định |
| Build configuration | Ví dụ `Debug` hoặc `Release`; mặc định project mới là `Debug` |
| Firebase app ID | Firebase iOS App ID |
| Firebase tester groups | Danh sách group phân cách bằng dấu phẩy |

Giá trị mặc định chỉ là gợi ý của UI, không đảm bảo phù hợp với mọi Xcode project.

#### Nhóm 03 — Ad-hoc signing: Fastlane Match

Chọn **Fastlane Match**, sau đó nhập tên env var:

| CMS field | Ví dụ tên env |
| --- | --- |
| Match password env | `CUSTOMER_IOS_MATCH_PASSWORD` |
| ASC key ID env | `CUSTOMER_IOS_ASC_KEY_ID` |
| ASC issuer ID env | `CUSTOMER_IOS_ASC_ISSUER_ID` |
| ASC key path env | `CUSTOMER_IOS_ASC_KEY_PATH` |

Các field trên là **tên biến**, không phải secret value.

Fastfile mẫu gọi:

```ruby
match(type: "adhoc", readonly: true)
```

Vì chạy `readonly: true`, signing assets cần tồn tại sẵn trong Match storage.

#### Nhóm 03 — Ad-hoc signing: Manual signing

Chọn **Manual signing**, sau đó nhập:

| CMS field | Cách điền |
| --- | --- |
| Apple Team ID | Đúng 10 chữ/số viết hoa, ví dụ `AB12CDEFGH` |
| Signing certificate | Certificate label, ví dụ `Apple Distribution` |
| Provisioning profiles | Mapping mỗi Bundle ID cụ thể tới profile name đã cài |

Yêu cầu:

- Ít nhất một profile mapping.
- Bundle IDs không được trùng.
- Không dùng wildcard.
- App chính và mỗi extension phải có mapping riêng.
- Certificate phải có private key trong keychain của đúng user chạy worker.
- Profile name phải khớp tên profile đã cài, không phải tên file tùy ý.

#### Nhóm 04 — Notifications & runner

| Field | Cách điền |
| --- | --- |
| Lark group chat ID | Optional, bắt đầu bằng `oc_` |
| Firebase CLI token env | Tên env, ví dụ `CUSTOMER_IOS_FIREBASE_CLI_TOKEN` |
| Project enabled | Để tắt khi tạo lần đầu; bật sau khi validation thành công |

### 9.3. Validate project

Sau khi tạo project:

1. Mở Project Detail.
2. Chọn **Run validation/Validate**.
3. Backend kiểm tra:
   - Project fields đúng schema.
   - `IOS_REPO_ROOTS` đã cấu hình.
   - Repository canonical path nằm trong allowed roots.
   - Repo path là directory.
   - Có `Gemfile`.
   - Có `fastlane/Fastfile`.
   - Required env values tồn tại.
   - `bundle check` thành công.
4. Sửa tất cả lỗi được hiển thị.
5. Edit project và bật **Project enabled**.
6. Save; backend validate lại trước khi enable.

Các lỗi phổ biến:

```text
IOS_REPO_ROOTS is not configured
Repository path is outside IOS_REPO_ROOTS
Missing runner environment variables: ...
Project validation failed: ...
```

### 9.4. Project tự disable khi sửa cấu hình

Khi update project, backend reset:

- `enabled = false`.
- validation status về `unknown`.

Sau mọi thay đổi cấu hình, cần Validate và Enable lại. Điều này tránh worker chạy với cấu hình chưa được xác nhận.

### 9.5. Cấu hình Users & permissions cho Lark

Mục này quản lý quyền build từ Lark, không phải CMS login accounts.

1. Vào **Users & permissions**.
2. Add user.
3. Nhập Lark user `open_id`, thường có dạng `ou_...`.
4. Nhập display name.
5. Enable user.
6. Chọn các project user được phép build.
7. Save permissions.

Khi nhận command Lark, API chỉ enqueue nếu sender:

- Tồn tại trong CMS.
- Đang enabled.
- Có quyền build project được yêu cầu.

CMS admin token vẫn có quyền quản trị và trigger build qua CMS/API.

### 9.6. Trigger build từ CMS

Có hai luồng:

- Project Detail → **Trigger build**.
- Builds → **New build** → chọn project enabled.

Thông tin build:

| Field | Ghi chú |
| --- | --- |
| Scheme | Được prefill từ project nhưng CMS có thể override cho build hiện tại |
| App version | Dạng `1`, `1.1` hoặc `1.1.0` |
| Build number | Build identifier theo validation backend |
| Release notes | Optional |

Build từ Lark luôn dùng scheme mặc định của project. Requested scheme override hiện chỉ có từ CMS.

---

## 10. Cấu hình Lark Bot

### 10.1. Lark Developer Console

1. Tạo Internal App.
2. Enable capability **Bot**.
3. Cấp quyền nhận message/event phù hợp.
4. Cấp quyền gửi message bằng bot:

   ```text
   im:message:send_as_bot
   ```

5. Cấu hình Event Subscription:

   ```text
   POST https://<PUBLIC_HOST>/webhook/lark
   ```

6. Subscribe:

   ```text
   im.message.receive_v1
   ```

7. Cấu hình Verification Token và Encrypt Key.
8. Publish/install app.
9. Thêm bot vào group cần dùng.
10. Đưa App ID, App Secret, Verification Token và Encrypt Key vào môi trường API.

Webhook phải truy cập được qua HTTPS từ Lark. Không public toàn bộ CMS nếu chỉ cần public webhook; có thể đặt reverse proxy/routing riêng.

### 10.2. Lệnh build

```text
@AutoPush /build <project_key> <app_version> <build_number> "<release_notes>"
```

Ví dụ:

```text
@AutoPush /build customer-ios 1.4.0 42 "Internal QA build"
```

Parser tự loại phần mention bot. Duplicate webhook deliveries dùng event/message ID để trả lại build hiện có thay vì enqueue job trùng.

### 10.3. Lấy Lark user ID và chat ID

#### User ID

API dùng sender `open_id`, thường bắt đầu bằng `ou_`. Có thể lấy từ webhook event/log khi user gửi message tới bot, sau đó thêm ID vào **Users & permissions**.

#### Group chat ID

Group chat ID thường bắt đầu bằng `oc_`.

Cách thực tế:

1. Thêm bot vào group.
2. Gửi một build command.
3. Kiểm tra API log `Received Lark build command`.
4. Copy `chatId` dạng `oc_...`.
5. Nhập vào project field **Lark group chat ID**.

### 10.4. Notification behavior

- Project có `larkNotificationChatId`: kết quả cuối gửi về group đó.
- Project không có group mặc định:
  - Build từ Lark fallback về chat đã gửi command.
  - Build từ CMS không gửi Lark.
- Hệ thống hiện chỉ gửi kết quả cuối cùng success/failure, không gửi queued/started.

---

## 11. Build, log và retry

### 11.1. Build lifecycle

Luồng chính:

```text
requested -> enqueueing -> queued -> running -> succeeded|failed
```

API ghi build record và config snapshot trước khi enqueue. BullMQ job ID dùng build ID.

### 11.2. Log

Log được ghi dưới:

```text
logs/builds/<build-id>/attempt-<n>.log
```

Đặc điểm:

- Database chỉ lưu relative log path.
- Secret values được redact trước khi ghi.
- Log API không nhận arbitrary filesystem path.
- Backend kiểm tra path traversal và symlink escape.
- CMS hỗ trợ xem tail và download full log.

### 11.3. Retry

- Job chỉ có một automatic attempt.
- Retry là thao tác thủ công trong CMS.
- Retry tạo build record và BullMQ job mới.
- Build mới liên kết build cũ qua `retryOfId`.
- Retry giữ input trước đó nếu không override, gồm requested scheme.
- Nếu worker restart khi build đang `running`, build được đánh failed và cần retry thủ công.

---

## 12. Build và chạy production

### 12.1. Build

```bash
npm run build
```

Lệnh này build tuần tự:

- Backend TypeScript vào `dist/`.
- React/Vite frontend vào `web/dist/`.

### 12.2. Start API/CMS

```bash
NODE_ENV=production npm start
```

Production tự bật static CMS serving và yêu cầu:

```text
web/dist/index.html
```

Nếu chưa build frontend, API sẽ fail với thông báo CMS build bị thiếu.

`CMS_ADMIN_TOKEN` production phải dài ít nhất 32 ký tự.

### 12.3. Start worker

Trong service/process riêng trên Mac runner:

```bash
NODE_ENV=production npm run start:worker
```

### 12.4. Service manager

Nên dùng `launchd`, process manager hoặc hệ thống quản lý service của tổ chức để chạy API và worker riêng biệt.

Mỗi service cần:

- Working directory cố định là root repository.
- Environment/secret injection đầy đủ.
- Restart policy phù hợp.
- Graceful `SIGTERM`.
- Cùng `REDIS_URL`, `DB_PATH` và per-project env references.
- Worker chạy bằng dedicated macOS user có quyền keychain/signing assets.

Không dùng một web process tùy ý để tự start worker.

### 12.5. Reverse proxy

Khuyến nghị đặt Nginx/Caddy/load balancer phía trước để:

- Terminate HTTPS.
- Route CMS/API nội bộ.
- Public riêng `/webhook/lark` nếu cần.
- Hạn chế CMS/API bằng VPN, private network hoặc IP allowlist.
- Thêm request size/timeouts phù hợp.

Không expose Redis port `6379` ra Internet.

---

## 13. Database, queue và deploy upgrade

### 13.1. Backup SQLite

Trước migration/deploy:

```bash
cp data/autopushapp.sqlite data/autopushapp.sqlite.backup
```

Nếu dùng custom `DB_PATH`, backup đúng file tương ứng. Đảm bảo backup được bảo vệ vì database chứa metadata vận hành, dù không nên chứa secret value.

### 13.2. Migration

```bash
npm run migrate
```

Migrations được track trong `schema_migrations` và chạy idempotently. API và worker cũng tự chạy migration khi start.

### 13.3. Queue compatibility

Queue hiện tại:

```text
ios-build-v3
```

Worker yêu cầu payload schema version 3. Khi deploy thay đổi payload/schema:

1. Dừng API hoặc chặn enqueue mới.
2. Drain/xử lý queue cũ.
3. Dừng worker cũ.
4. Backup SQLite.
5. Deploy code mới.
6. Chạy migration.
7. Start API mới.
8. Start worker mới.
9. Kiểm tra `/health`.
10. Chạy một controlled build.

Không chạy API mới cùng worker cũ nếu payload schema không tương thích.

---

## 14. API chính

### Public

- `GET /health`
- `POST /webhook/lark`

### Yêu cầu `Authorization: Bearer <CMS_ADMIN_TOKEN>`

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

Build/retry endpoints yêu cầu header:

```text
Idempotency-Key: <UNIQUE_VALUE>
```

Frontend dùng UUID để tạo idempotency key.

---

## 15. Bảo mật vận hành

### Đã có trong code

- Helmet security headers.
- Rate limit 120 requests/phút.
- Bearer auth cho `/api/*`.
- CORS dev origin.
- Timing-safe compare admin token.
- Secret redaction trong application/build logs.
- Canonical repository root boundary.
- Log path traversal/symlink protection.
- SQLite WAL, foreign keys và busy timeout.
- Lark timestamp/signature verification khi Encrypt Key được cấu hình.

### Đội vận hành phải thực hiện

- Dùng HTTPS.
- Không public Redis.
- Giới hạn quyền truy cập CMS/API.
- Luôn cấu hình `LARK_ENCRYPT_KEY` ở production.
- Dùng dedicated OS user cho worker.
- Hạn chế filesystem permissions của `.env`, `.p8`, Match key, SQLite và logs.
- Bảo vệ keychain và chỉ import signing assets cần thiết.
- Backup SQLite trước deploy/migration.
- Rotate token/key khi có nghi ngờ lộ secret.
- Không đưa token vào command history, issue, screenshot hoặc build log.
- Nâng cấp shared CMS token sang SSO/session/audit identity nếu hệ thống có nhiều admin hoặc được public rộng hơn.

### Không được commit

- `.env` hoặc `.env.*` chứa secret.
- App Store Connect `.p8`.
- `fastlane/api_key.json`.
- Firebase token.
- Match password.
- Git deploy private key.
- Keychain password.
- Certificate/private key.
- Provisioning profile nội bộ nếu chính sách tổ chức không cho phép.
- SQLite data, build logs và IPA artifacts.

---

## 16. Kiểm tra project

### 16.1. Static checks và tests

```bash
npm run typecheck
npm test
npm run build
```

### 16.2. Kiểm tra Docker Compose

```bash
docker compose config
docker compose up -d redis
docker compose ps
```

### 16.3. CMS-only smoke test an toàn

Không start worker/Fastlane nếu chỉ kiểm tra CMS:

1. Dùng Redis/database test hoặc local riêng.
2. Start `npm run dev`.
3. Kiểm tra `/health`.
4. Login bằng admin token test.
5. Mở Dashboard, Projects, Users và Builds.
6. Tạo project disabled.
7. Chạy validation có kiểm soát.
8. Không enable/queue build nếu worker thật đang kết nối cùng Redis.

### 16.4. End-to-end trên runner thật

1. Tạo project disabled.
2. Validate và enable.
3. Gán Lark user permission.
4. Trigger một build từ CMS.
5. Xác nhận chỉ một build chạy tại một thời điểm.
6. Kiểm tra log không lộ secret.
7. Kiểm tra IPA xuất hiện trên Firebase App Distribution.
8. Trigger từ Lark.
9. Gửi lại duplicate webhook/command event nếu có môi trường test và xác nhận không enqueue trùng.
10. Test retry một build failed có kiểm soát.

---

## 17. Troubleshooting vận hành

### `Invalid environment configuration`

Kiểm tra `.env`:

- URL có đúng format không.
- `PORT`/`BUILD_TIMEOUT_MS` có phải số dương không.
- `NODE_ENV` có thuộc `development|test|production` không.
- `CMS_ADMIN_TOKEN` production có ít nhất 32 ký tự không.

### `CMS build is missing`

Frontend production chưa được build hoặc `CMS_DIST_PATH` sai:

```bash
npm run build:web
```

Hoặc build toàn bộ:

```bash
npm run build
```

### `IOS_REPO_ROOTS is not configured`

Đặt ít nhất một allowed root:

```dotenv
IOS_REPO_ROOTS=/Users/build/repos
```

Restart API và worker sau khi đổi env.

### `Repository path is outside IOS_REPO_ROOTS`

- Kiểm tra absolute repo path.
- Kiểm tra symlink/canonical path.
- Thêm đúng parent root vào `IOS_REPO_ROOTS` hoặc chuyển checkout vào allowed root.
- Không thêm `/` hoặc home directory quá rộng chỉ để bỏ qua boundary.

### `Missing runner environment variables: ...`

CMS đang lưu tên env nhưng API process không thấy value.

1. Kiểm tra tên biến viết hoa và khớp tuyệt đối.
2. Đặt value vào `.env` hoặc service secret manager.
3. Đảm bảo cả API và worker nhận biến.
4. Restart services.
5. Validate lại.

### `bundle check` hoặc project validation fail

Trong iOS repo:

```bash
bundle install
bundle check
```

Nếu service dùng sai Ruby/Bundler:

```bash
which ruby
which bundle
bundle --version
```

Đặt `BUNDLE_BIN` thành absolute path đúng và restart API/worker.

### Fastlane timeout

- Kiểm tra full build log.
- Xác định Xcode đang chờ prompt, keychain unlock hoặc signing dialog không.
- Kiểm tra network tới Git/Apple/Firebase.
- Chỉ tăng `BUILD_TIMEOUT_MS` sau khi xác định build thật sự cần lâu hơn.

### `Fastlane exited with code N`

Mở Build Detail và download full log. Kiểm tra lần lượt:

- Lane tồn tại.
- Scheme/configuration đúng.
- Match repo/auth/password.
- ASC Key ID/Issuer ID/path `.p8`.
- Certificate/private key và provisioning profiles.
- Firebase App ID/token/groups.
- Xcode archive/export errors.

### Worker không healthy

- Kiểm tra worker process có chạy không.
- Kiểm tra `REDIS_URL` và `DB_PATH` có giống API không.
- Kiểm tra `RUNNER_ID`.
- Kiểm tra Redis connectivity.
- Kiểm tra worker log và service restart policy.

### Build bị failed sau khi worker restart

Nếu worker bị dừng khi build đang `running`, hệ thống không tự resume Fastlane process. Dùng nút **Retry** trong CMS sau khi xác nhận signing/repository/runner đã ổn định.

### Lark URL verification hoặc signature fail

- Kiểm tra callback HTTPS public.
- Kiểm tra `LARK_VERIFICATION_TOKEN`.
- Kiểm tra `LARK_ENCRYPT_KEY`.
- Kiểm tra `x-lark-request-timestamp`, nonce và signature headers.
- Đồng bộ system clock/NTP của server.
- Kiểm tra reverse proxy có giữ nguyên request body/header không.

### Lark nhận command nhưng không enqueue

- Event phải là `im.message.receive_v1`.
- Command đúng syntax.
- Sender `open_id` đã được thêm và enabled trong CMS.
- User có permission cho project.
- Project đang enabled và validation hợp lệ.
- App version/build number đúng format.

### Lark không gửi notification

- Kiểm tra `LARK_APP_ID` và `LARK_APP_SECRET`.
- Bot có scope `im:message:send_as_bot`.
- App đã publish/install.
- Bot nằm trong group.
- `larkNotificationChatId` bắt đầu bằng `oc_` và đúng group.
- Nếu CMS build không có project chat ID, hệ thống sẽ không có chat fallback để gửi.

### Firebase upload fail

- Kiểm tra Firebase App ID.
- Kiểm tra token env name/value.
- Kiểm tra token còn hiệu lực.
- Kiểm tra tester group alias/name.
- Kiểm tra phiên bản Firebase CLI/Fastlane plugin trong iOS repo.

### Manual signing fail

- Certificate có private key hay không.
- Certificate/profile được cài cho đúng macOS user chạy service hay không.
- Keychain có bị lock không.
- Tất cả app/extension Bundle IDs có mapping không.
- Profile name trong CMS có khớp profile đã cài không.
- Xcode project có thể archive với signing assets local không.

---

## License

Private project — `UNLICENSED`.
