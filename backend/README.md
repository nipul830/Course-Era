# Course Era Backend

Express + Firebase Admin API for Course Era.

Firebase Admin is used on the trusted backend to verify Firebase ID tokens and access Firestore/Storage. Keep service-account credentials only on the backend, never in the frontend or GitHub. citeturn0search0turn0search1

## Implemented

- Firebase ID-token authentication
- Admin authorization using Firebase custom claim `admin=true` or `ADMIN_EMAILS`
- Course CRUD
- Public published-course listing
- Payment submission with UTR/reference ID
- Duplicate transaction/reference protection
- Payment screenshot upload to Firebase Storage
- User payment history
- Admin payment queue
- Approve/reject payments
- Automatic course entitlement after approval
- Protected course-access endpoint
- Security headers with Helmet
- API rate limiting
- Input validation for course prices and payment amounts
- Health/config endpoints

## Environment

Set these variables on the server:

```
PORT=3000
FRONTEND_ORIGIN=https://nipul830.github.io
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
ADMIN_EMAILS=your-admin-email@example.com
```

For production, keep the Firebase service-account JSON only on the backend/server. Never put it in frontend code or GitHub.

Firebase's Node Admin SDK currently requires a supported Node runtime; this project targets Node 22+. citeturn0search0

## Run

```
cd backend
npm install
npm start
```

Health check:

```
GET /health
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

## Firestore data model

```
courses/{courseId}
payments/{paymentId}
users/{uid}/courses/{courseId}
```

After an admin approves a payment, the backend creates:

`users/{uid}/courses/{courseId}`

That entitlement is what the protected course-access endpoint checks.

## Important

The GitHub Pages frontend still has some demo/localStorage flows. The next implementation step is to connect the existing login/session, courses, payment, My Courses, and admin pages to these API endpoints using the Firebase user's ID token.

Do not place the Firebase Admin service-account JSON in the frontend.