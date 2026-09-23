# Course Era Backend

Express + Firebase Admin API for Course Era.

## Implemented
- Firebase ID-token authentication
- Admin authorization using Firebase custom claim `admin=true` or `ADMIN_EMAILS`
- Course CRUD
- Public published-course listing
- Payment submission with UTR/reference ID
- Payment screenshot upload to Firebase Storage
- User payment history
- Admin payment queue
- Approve/reject payments
- Automatic course entitlement after approval
- Protected course-access endpoint
- Health/config endpoints

## Environment

Set these variables on the server:

```
PORT=3000
FRONTEND_ORIGIN=https://nipul830.github.io
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
ADMIN_EMAILS=your-admin-email@example.com
```

For production, keep the Firebase service-account JSON only on the backend/server. Never put it in frontend code or GitHub.

## Run

```
cd backend
npm install
npm start
```

The frontend must send the Firebase ID token as:

`Authorization: Bearer <Firebase ID token>`

## Main API

- `GET /health`
- `GET /api/config`
- `GET /api/courses`
- `POST /api/courses` (admin)
- `PUT /api/courses/:id` (admin)
- `DELETE /api/courses/:id` (admin)
- `POST /api/payments` (login required, multipart form with optional `screenshot`)
- `GET /api/payments/my`
- `GET /api/admin/payments` (admin)
- `PATCH /api/admin/payments/:id` body: `{"status":"approved"}` or `{"status":"rejected"}`
- `GET /api/my-courses`
- `GET /api/courses/:id/access`

## Important

The GitHub Pages frontend is still using its demo/localStorage authentication and payment flow. The next frontend integration step is to replace those demo calls with Firebase Auth and these API endpoints.
