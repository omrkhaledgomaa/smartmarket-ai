# SmartMarket AI — backend starter (V0.8.1 — supplier and purchase management)

This is a local/development backend upgrade of the SmartMarket AI prototype. It is **not public production deployment** and must not be exposed to customers until the deployment checklist below is completed.

## Release V0.6.0 — verification and backup/restore

- Release package version is synchronized to 0.6.0.
- Backup and restore scripts included; restore requires explicit confirmation.
- End-to-end smoke tests run on Node.js 22.16 and pass (20 checks).
- This is still a starter; public production launch remains blocked by the checklist below.

## What's new in V0.4

- SQLite-backed persistence (`node:sqlite`), WAL mode, foreign-key checks, and busy timeout.
- Order creation and stock updates are transactional; stock updates are guarded against overselling.
- Order cancellation/reactivation updates inventory transactionally.
- Admin session cookies contain random tokens; only SHA-256 token hashes are stored in SQLite. Sessions survive a server restart and can be revoked on logout.
- Admin password can be checked against a scrypt hash (`ADMIN_PASSWORD_HASH`) or plain environment secret for local development compatibility. Use the hash in production.
- A hidden-input password hashing utility is provided (`npm run hash-password`).
- Same-origin `Origin` validation and JSON content-type checks on mutating routes.
- CSP, frame denial, and other security headers.
- Login and order-tracking rate limits are present but are in-process only (not production-grade shared limits).
- Legacy `data/store.json` import is attempted once if the database has no orders.
- SQLite backup utility, verified restore utility, and end-to-end smoke test script are included.

## Requirements and local run

- Node.js **22.16 or newer** (built-in SQLite is experimental in this release; Node may emit a warning).
- Copy `.env.example` values into your shell or environment. Never publish your real secrets.
- Development example:

  ```sh
  ADMIN_PASSWORD='use-a-long-unique-password-here' npm start
  ```

- Open `http://localhost:3000/` (store) or `http://localhost:3000/admin` (admin panel).
- Local testing can use `COOKIE_SECURE=false`. For HTTPS production, set `NODE_ENV=production`, which enables Secure cookies. Do not use production mode over plain HTTP.

### Prefer a scrypt password hash

Run the utility in a terminal. It reads the password without echoing it when run interactively:

```sh
npm run hash-password
```

Copy the generated `ADMIN_PASSWORD_HASH=...` value into your hosting environment. Set `ADMIN_PASSWORD_HASH` and leave `ADMIN_PASSWORD` unset/empty. Do not put secrets in source files or commit `.env`.

## Database and backups

- Database path: `data/smartmarket.sqlite` (or `DATA_DIR` if set).
- Legacy JSON file: `data/store.json` is retained after import; keep it as a pre-migration backup until you verify data.
- Create a SQLite-aware backup (not a plain file copy while the server is active):

  ```sh
  npm run backup
  ```

- Restore a backup only while the application is stopped. Inspect the chosen backup first, then run:

  ```sh
  RESTORE_CONFIRM=YES npm run restore -- /absolute/path/to/backup.sqlite
  ```

  The restore script validates SQLite integrity and required SmartMarket tables, creates a safety backup of the current database if present, and only then replaces it. Test restores in a separate data directory before relying on this procedure. Never restore into a database while the server is running.

- Optional destination folder: `BACKUP_DIR=/path/to/backups npm run backup`.
- Optional data folder: `DATA_DIR=/path/to/data`.

## Tests

Run the automated end-to-end smoke test:

```sh
npm test
```

It starts the app using a temporary SQLite directory and verifies catalog, login protection, checkout, tracking, cancellation/restock, reactivation, hashed session persistence across server restart, scrypt authentication, logout revocation, and backup generation. It deletes the temporary test database when complete.

## API

- `GET /health` — health endpoint.
- `GET /api/products` — public product catalog.
- `GET /api/public/settings` — public shipping setting.
- `POST /api/orders` — same-origin, server-validated checkout.
- `GET /api/orders/:orderNo?phone=...` — order tracking with phone match and in-process rate limiting.
- `POST /api/admin/login` and `POST /api/admin/logout` — admin session.
- `GET /api/admin/orders` — admin-only order list.
- `GET /api/admin/settings` / `PUT /api/admin/settings` — admin shipping setting.
- `POST /api/admin/products`; `PUT` / `DELETE` `/api/admin/products/:id` — product administration.
- `PATCH /api/admin/orders/:orderNo` — order status management.

## Public launch checklist (still required)

1. Deploy behind HTTPS with a managed host/reverse proxy and set production environment variables.
2. Replace in-process login/tracking rate limits with shared durable rate limiting; add monitoring/logging.
3. Add an explicit CSRF token scheme and review origin handling for the intended hosting/proxy topology.
4. Configure off-server scheduled backups, encrypt backups, restrict access, and test restoration.
5. Complete privacy policy, terms, returns policy, data-retention, and customer-data deletion processes.
6. Add a payment provider only after choosing one; never store card data.
7. Add shipping-provider integration only after choosing a provider.
8. Conduct security review, load testing, and full browser testing on mobile/desktop.
9. Connect a real AI service only through server-side secrets, with cost/abuse controls.
10. Add admin password setup/reset flow and preferably multi-factor authentication.
11. Define and test a safe product-image upload/storage policy if uploads are added.

## Test status

Local smoke tests pass for: SQLite initialization, catalog, admin route protection, login, checkout, order tracking, cancel/restock, reactivation/restock, session persistence across restart, scrypt authentication, logout revocation, SQLite backup generation, restore confirmation guard, and verified restore to a separate test directory. No public deployment has been made.

## Container deployment starter (new)

A Docker image and Compose file are provided for a **single-host deployment behind an HTTPS reverse proxy**. The app binds to `127.0.0.1:3000` on the host, persists SQLite in a named volume, and uses production mode (Secure cookies enabled). It does not configure TLS itself; put a maintained reverse proxy / managed HTTPS in front of it before public use.

1. Install Docker Engine and the Docker Compose plugin on your server.
2. Generate an admin scrypt hash locally with `npm run hash-password` (run with Node 22+). Use a unique password; do not share it or the generated hash.
3. Create a `.env` file in this folder containing exactly the generated setting, e.g. `ADMIN_PASSWORD_HASH=scrypt$...` (quote it if your shell/editor treats `$` specially). Keep `.env` private and never commit it.
4. Start the service: `docker compose up -d --build`.
5. Verify on the server: `curl http://127.0.0.1:3000/health` should return `{"ok":true,...}`. Open the public site only through your HTTPS reverse proxy. The Compose file intentionally binds to loopback, not all network interfaces.
6. Review logs: `docker compose logs -f smartmarket`.
7. Stop: `docker compose down` (the named data volume remains). To delete the persistent database volume, use `docker compose down -v`—this is destructive.

Production mode now refuses to start if only a plaintext `ADMIN_PASSWORD` is configured; a valid scrypt `ADMIN_PASSWORD_HASH` is required. This guard is also covered by the test suite.

### Important deployment caveats

- Do not expose port 3000 directly to the public Internet. Configure HTTPS termination, forwarding rules, and security headers at the reverse proxy and review proxy/Origin behavior.
- Compose's named SQLite volume is persistent on this host but is not an off-site backup. Set up encrypted backups elsewhere and test restoration before accepting customer orders.
- The current in-process rate limits are not shared across replicas; keep one instance until durable/shared rate limiting is added.
- This starter has not been deployed to a real server, domain, or hosting account from this chat. Hosting credentials, DNS, and a chosen provider are still needed for actual publication.


## Release notes — V0.6.2

- Fixed Egyptian mobile-number validation in the storefront: comma is no longer accepted as a prefix character; supported prefixes are 010, 011, 012, and 015.
- Added matching client-side validation in server-connected checkout to provide earlier feedback before submitting to the API.
- Added automated checks for valid/invalid phone formats and storefront validation pattern.
- Version bump from 0.6.0; no production deployment performed.
\n\n## V0.6.4 release notes\n- Product deletion now returns HTTP 409 and prevents deletion when the product is referenced by any historical order, protecting order history and cancellation/reactivation consistency.\n- Added regression tests for protected deletion and deletion of an unused product.\n

## V0.6.4 inventory regression checks
- Added assertions that checkout reserves exactly the purchased quantity.
- Cancellation restores stock exactly once, including repeated cancel requests.
- Reactivation reserves stock again, while repeated active status does not double-reserve.


## Release 0.6.5 — Stock controls in admin
- Product editing no longer overwrites stock counts; inventory changes are handled through dedicated adjustments.
- Admin product list shows low-stock warnings (threshold: 3) and has add/remove stock controls.
- Added transactional stock adjustment endpoint; negative inventory adjustments are rejected.


## Release 0.6.6 — Admin search and filtering

- Product list supports search by name/category and filters for low stock, available, and out-of-stock.
- Order list supports search by order number, customer name, or phone, plus status filtering.
- Admin summary now shows a low-stock product count.
- UI smoke assertions cover filter controls and rendering hooks.


## Release 0.6.7
- Product metadata editing uses a responsive modal form instead of prompt dialogs.
- Inventory add/remove uses a quantity modal that displays current stock.
- Modal forms include cancel controls and backdrop dismissal.
- Added static regression assertions for modal markup.

## V0.6.8
- Added order-detail modal with customer, contact, address, date, status, itemized quantities and unit prices, subtotal, discount, shipping, and total.
- Order detail opening is delegated from the order list and safely escapes customer/order content.
- Added source-level regression checks for order-detail UI.

## Release 0.6.9 — Order status history
- Added SQLite-backed order status history, with timestamped entries at checkout and each actual status change.
- Admin order list includes a collapsible status timeline, newest entry first.
- Repeated status updates are idempotent and do not create duplicate history events.
- Existing orders without history receive a one-entry backfill using their existing order date/status.
- Tests cover checkout history, cancellation, reactivation, and duplicate status updates.


## Release 0.7.0 — Delivery assignment

- Admin order cards support courier name, courier phone, and tracking code fields.
- Delivery metadata is persisted in SQLite and returned in the admin order list.
- PATCH order endpoint accepts delivery metadata independently from status updates; changing order status preserves saved delivery details.
- Database migration adds the delivery fields to existing databases without replacing order records.
- Delivery field lengths are validated server-side.
- Tests cover persistence, validation, and preservation across status changes.


## Release 0.7.1 — Printable order invoice

- Added a print action in the admin order details dialog.
- Opens a dedicated print-ready invoice containing order/customer details, itemized quantities and prices, subtotal, discount, shipping, final total, and courier/tracking information.
- Uses escaped text values in the print document and a print layout designed for paper/PDF output.
- Browser popup restrictions are handled with an explicit user message.
- Regression tests check the invoice action and required invoice fields in the admin source.

## Release 0.7.3
- Local demo storefront supports optional HTTP(S) product image URLs when adding products.
- Product cards lazy-load remote images and show an emoji fallback if the image fails.
- Server product schema and database remain unchanged in this release; image URLs are local-demo data only.


## Release 0.7.4

- Product detail dialog now displays the actual product image URL (with fallback emoji), clearer category/price/stock metadata, and stock-aware add-to-cart action.
- Escape key closes storefront product and cart dialogs.
- Existing catalog/cart/order behavior retained.


## Release 0.7.5
- Added customer-facing availability filters for all, in-stock, and out-of-stock products.
- Availability filtering composes with category, Arabic search, and favorites filters.


## Release 0.7.6
- Added optional promotional sale price to locally managed products.
- Storefront displays sale badge and crossed-out original price.
- Cart subtotal and locally recorded order line prices use the valid sale price.
- Sale price must be positive and lower than the original price.


## V0.7.7 — إدارة أكواد الخصم المحلية
- إدارة كوبونات محلية: نسبة أو مبلغ ثابت، حد أدنى، تاريخ انتهاء، تفعيل/إيقاف وحذف.
- ترحيل الكودين التجريبيين SMART10 وSAVE50 تلقائيًا عند عدم وجود إعدادات محفوظة.
- تضمين الكوبونات في النسخ الاحتياطي والاستعادة.
- هذه الكوبونات للعرض المحلي فقط؛ واجهة المتجر تخفيها عند الاتصال بالسيرفر لأن واجهة API لم تعتمد كوبونات قابلة للإدارة بعد.


## Release V0.7.8 — server-managed coupon codes

- Admin panel now manages coupons stored in SQLite: create, edit, enable/disable, and delete.
- Supports percentage and fixed-amount discounts, minimum order subtotal, and optional expiry date.
- Checkout revalidates coupon status, minimum, and expiry on the server before calculating the discount.
- Percentage discounts are capped by their 100% validation limit; fixed discounts cannot exceed the subtotal.
- Existing coupon databases are migrated safely with expiry and enabled columns; SMART10 and SAVE50 remain available.
- End-to-end tests: 97/97 PASS. Browser visual testing has not been performed.


## الإصدار 0.7.9
- دليل عملاء مستخرج من الطلبات مع بحث وفرز حسب الأحدث وإجمالي المشتريات وعدد الطلبات.
- استبعاد الطلبات الملغاة من عدد الطلبات وإجمالي المشتريات مع إظهار عدد الملغى بشكل منفصل.
- لا يخزن النظام بيانات شخصية إضافية؛ يتم تجميعها من بيانات الطلبات القائمة.


## الإصدار 0.8.0
- تقارير مبيعات قابلة للتصفية لآخر 7 أيام أو 30 يومًا أو كامل الفترة.
- ملخص الإيرادات والطلبات غير الملغاة والملغاة ومتوسط الطلب وإجمالي الخصومات.
- قائمة أفضل 10 منتجات حسب الكمية المباعة.
- التقارير محسوبة من قاعدة البيانات وتستبعد الطلبات الملغاة من الإيرادات.


## Release 0.8.1 — Suppliers and purchases

- Admin supplier directory: create and list suppliers; update and delete are available through the authenticated API. Suppliers with purchase history cannot be deleted.
- Record purchase invoices with supplier, product, quantity, unit cost, reference, and notes.
- Purchase creation is transactional: it records the invoice and item, increases product stock, and recalculates weighted-average cost.
- Purchase history is available in the admin panel. Purchase totals are procurement costs, not sales revenue.
- SQLite migrations add supplier, purchase, purchase-item, and product cost-price fields without replacing existing records.
- Automated smoke tests: 110 checks.
