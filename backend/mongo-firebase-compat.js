import crypto from "node:crypto";
import { getMongoDb } from "./mongodb.js";

const INTERNAL_PATH = "__collectionPath";
const INTERNAL_ID = "__docId";
const DELETE = Symbol("delete-field");
const SERVER_TIMESTAMP = Symbol("server-timestamp");

function now() { return new Date(); }
function cleanEmail(value) { return String(value || "").trim().toLowerCase(); }
function uid() { return "m_" + crypto.randomBytes(12).toString("hex"); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return salt.toString("hex") + ":" + hash.toString("hex");
}
function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored || "").split(":");
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function authSecret() {
  return crypto.createHash("sha256")
    .update(String(process.env.AUTH_SESSION_SECRET || process.env.MONGO_URI || "course-era-mongo-auth") + "|auth-v1")
    .digest();
}
function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value) { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")); }

export function createAuthToken(user) {
  const payload = {
    uid: String(user.uid),
    email: cleanEmail(user.email),
    name: String(user.displayName || user.name || ""),
    photoURL: String(user.photoURL || ""),
    admin: Boolean(user.admin),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    rv: Number(user.tokenVersion || 0)
  };
  const body = encode(payload);
  const sig = crypto.createHmac("sha256", authSecret()).update(body).digest("base64url");
  return "MA1." + body + "." + sig;
}

function verifyTokenShape(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "MA1") throw new Error("Invalid authentication token");
  const expected = crypto.createHmac("sha256", authSecret()).update(parts[1]).digest("base64url");
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid authentication token");
  const payload = decode(parts[1]);
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Authentication token expired");
  return payload;
}

function publicUser(doc) {
  if (!doc) return null;
  return {
    uid: String(doc._id),
    email: cleanEmail(doc.email),
    displayName: String(doc.displayName || doc.name || ""),
    name: String(doc.name || doc.displayName || ""),
    photoURL: String(doc.photoURL || ""),
    disabled: Boolean(doc.disabled),
    admin: Boolean(doc.admin),
    tokenVersion: Number(doc.tokenVersion || 0)
  };
}

async function authCollection() { return (await getMongoDb()).collection("auth_users"); }

async function findAuthByEmail(email) {
  return (await authCollection()).findOne({ email: cleanEmail(email) });
}

function userObject(doc) {
  const user = publicUser(doc);
  return {
    ...user,
    getIdToken: async () => createAuthToken(user),
    updateProfile: async patch => {
      const col = await authCollection();
      const update = {};
      if (patch?.displayName !== undefined) update.displayName = String(patch.displayName || "").slice(0, 120);
      if (patch?.photoURL !== undefined) update.photoURL = String(patch.photoURL || "").slice(0, 900000);
      if (Object.keys(update).length) {
        update.updatedAt = now();
        await col.updateOne({ _id: user.uid }, { $set: update });
      }
      Object.assign(user, update);
      return user;
    }
  };
}

const authApi = {
  async createUser({ email, password, displayName = "", photoURL = "", admin = false } = {}) {
    const normalized = cleanEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(normalized)) { const e = new Error("Invalid email address"); e.code = "auth/invalid-email"; throw e; }
    if (String(password || "").length < 6) { const e = new Error("Password must be at least 6 characters"); e.code = "auth/weak-password"; throw e; }
    const col = await authCollection();
    const existing = await col.findOne({ email: normalized });
    if (existing) { const e = new Error("Email already registered"); e.code = "auth/email-already-in-use"; throw e; }
    const doc = {
      _id: uid(), email: normalized, passwordHash: hashPassword(password),
      displayName: String(displayName || "").slice(0, 120), photoURL: String(photoURL || ""),
      disabled: false, admin: Boolean(admin), tokenVersion: 0, createdAt: now(), updatedAt: now()
    };
    await col.insertOne(doc);
    return userObject(doc);
  },

  async signInWithEmailAndPassword(email, password) {
    const doc = await findAuthByEmail(email);
    if (!doc || !verifyPassword(password, doc.passwordHash)) { const e = new Error("Email or password is incorrect."); e.code = "auth/invalid-credential"; throw e; }
    if (doc.disabled) { const e = new Error("This account is disabled."); e.code = "auth/user-disabled"; throw e; }
    return userObject(doc);
  },

  async verifyIdToken(token) {
    const payload = verifyTokenShape(token);
    const col = await authCollection();
    const doc = await col.findOne({ _id: String(payload.uid) });
    if (!doc || doc.disabled || Number(doc.tokenVersion || 0) !== Number(payload.rv || 0)) throw new Error("Invalid or revoked authentication token");
    return { ...publicUser(doc), uid: String(doc._id) };
  },

  async getUser(uidValue) {
    const doc = await (await authCollection()).findOne({ _id: String(uidValue) });
    if (!doc) { const e = new Error("User not found"); e.code = "auth/user-not-found"; throw e; }
    return userObject(doc);
  },

  async getUserByEmail(email) {
    const doc = await findAuthByEmail(email);
    if (!doc) { const e = new Error("User not found"); e.code = "auth/user-not-found"; throw e; }
    return userObject(doc);
  },

  async updateUser(uidValue, patch = {}) {
    const col = await authCollection();
    const update = { updatedAt: now() };
    if (patch.email !== undefined) update.email = cleanEmail(patch.email);
    if (patch.password !== undefined) update.passwordHash = hashPassword(patch.password);
    if (patch.displayName !== undefined) update.displayName = String(patch.displayName || "").slice(0, 120);
    if (patch.photoURL !== undefined) update.photoURL = String(patch.photoURL || "").slice(0, 900000);
    if (patch.disabled !== undefined) update.disabled = Boolean(patch.disabled);
    await col.updateOne({ _id: String(uidValue) }, { $set: update });
    const doc = await col.findOne({ _id: String(uidValue) });
    if (!doc) { const e = new Error("User not found"); e.code = "auth/user-not-found"; throw e; }
    return userObject(doc);
  },

  async listUsers(maxResults = 1000, pageToken) {
    const col = await authCollection();
    const docs = await col.find({}).sort({ createdAt: 1 }).limit(Number(maxResults) || 1000).toArray();
    return { users: docs.map(userObject), pageToken: undefined };
  },

  async revokeRefreshTokens(uidValue) {
    await (await authCollection()).updateOne({ _id: String(uidValue) }, { $inc: { tokenVersion: 1 }, $set: { updatedAt: now() } });
  }
};

class DocSnapshot {
  constructor(id, data) { this.id = String(id); this._data = data; this.exists = Boolean(data); }
  data() { return this._data ? { ...this._data } : undefined; }
}

function applySentinels(value, existing) {
  if (value === SERVER_TIMESTAMP) return now();
  if (value === DELETE) return DELETE;
  if (value && value.__increment !== undefined) return Number(existing || 0) + Number(value.__increment || 0);
  if (Array.isArray(value)) return value.map((v, i) => applySentinels(v, existing?.[i]));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const next = applySentinels(v, existing?.[k]);
      if (next !== DELETE) out[k] = next;
    }
    return out;
  }
  return value;
}

function toStored(data, path, id, existing = {}) {
  const out = { ...existing };
  for (const [key, value] of Object.entries(data || {})) {
    const next = applySentinels(value, existing?.[key]);
    if (next === DELETE) delete out[key];
    else out[key] = next;
  }
  out[INTERNAL_PATH] = path;
  out[INTERNAL_ID] = String(id);
  out._id = path + "::" + String(id);
  return out;
}

function fromStored(doc) {
  if (!doc) return null;
  const out = { ...doc };
  delete out._id; delete out[INTERNAL_PATH]; delete out[INTERNAL_ID];
  return out;
}

class DocumentReference {
  constructor(path, id) { this.path = path; this.id = String(id); }
  collection(name) { return new CollectionReference(this.path + "/" + this.id + "/" + String(name)); }
  async get() {
    const db = await getMongoDb();
    const doc = await db.collection("firestore_docs").findOne({ [INTERNAL_PATH]: this.path, [INTERNAL_ID]: this.id });
    return new DocSnapshot(this.id, fromStored(doc));
  }
  async set(data, options = {}) {
    const db = await getMongoDb();
    const filter = { [INTERNAL_PATH]: this.path, [INTERNAL_ID]: this.id };
    const existing = await db.collection("firestore_docs").findOne(filter);
    const next = options?.merge ? toStored(data, this.path, this.id, fromStored(existing) || {}) : toStored(data, this.path, this.id, {});
    await db.collection("firestore_docs").replaceOne(filter, next, { upsert: true });
  }
  async update(data) {
    const snap = await this.get();
    if (!snap.exists) throw new Error("Document does not exist");
    await this.set(data, { merge: true });
  }
  async delete() {
    const db = await getMongoDb();
    await db.collection("firestore_docs").deleteOne({ [INTERNAL_PATH]: this.path, [INTERNAL_ID]: this.id });
  }
}

class Query {
  constructor(path, filters = [], ordering = null, max = null) { this.path = path; this.filters = filters; this.ordering = ordering; this.max = max; }
  where(field, op, value) { return new Query(this.path, [...this.filters, { field, op, value }], this.ordering, this.max); }
  orderBy(field, direction = "asc") { return new Query(this.path, this.filters, { field, direction }, this.max); }
  limit(n) { return new Query(this.path, this.filters, this.ordering, Number(n)); }
  async get() {
    const db = await getMongoDb();
    const mongoFilter = { [INTERNAL_PATH]: this.path };
    for (const f of this.filters) {
      if (f.op === "==") mongoFilter[f.field] = f.value;
      else if (f.op === "!=") mongoFilter[f.field] = { $ne: f.value };
      else if (f.op === ">") mongoFilter[f.field] = { $gt: f.value };
      else if (f.op === ">=") mongoFilter[f.field] = { $gte: f.value };
      else if (f.op === "<") mongoFilter[f.field] = { $lt: f.value };
      else if (f.op === "<=") mongoFilter[f.field] = { $lte: f.value };
      else if (f.op === "array-contains") mongoFilter[f.field] = f.value;
      else if (f.op === "in") mongoFilter[f.field] = { $in: Array.isArray(f.value) ? f.value : [] };
    }
    let cursor = db.collection("firestore_docs").find(mongoFilter);
    if (this.ordering) cursor = cursor.sort({ [this.ordering.field]: this.ordering.direction === "desc" ? -1 : 1 });
    if (this.max !== null) cursor = cursor.limit(this.max);
    const docs = await cursor.toArray();
    const snapshots = docs.map(d => new DocSnapshot(d[INTERNAL_ID], fromStored(d)));
    return { docs: snapshots, empty: snapshots.length === 0, size: snapshots.length };
  }
}

class CollectionReference extends Query {
  constructor(path) { super(path); this.path = String(path); }
  doc(id = crypto.randomUUID()) { return new DocumentReference(this.path, id); }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
}

class FirestoreAdapter {
  collection(name) { return new CollectionReference(String(name)); }
  async runTransaction(callback) {
    const ops = [];
    const tx = {
      get: ref => ref.get(),
      set: async (ref, data, options) => { ops.push(() => ref.set(data, options)); },
      update: async (ref, data) => { ops.push(() => ref.update(data)); },
      delete: async ref => { ops.push(() => ref.delete()); }
    };
    const result = await callback(tx);
    for (const op of ops) await op();
    return result;
  }
}

const firestoreApi = {
  FieldValue: {
    serverTimestamp: () => SERVER_TIMESTAMP,
    delete: () => DELETE,
    increment: value => ({ __increment: Number(value || 0) })
  }
};

const admin = {
  apps: [],
  initializeApp() { if (!this.apps.length) this.apps.push({ name: "[DEFAULT]" }); return this.apps[0]; },
  firestore() { return new FirestoreAdapter(); },
  auth() { return authApi; },
  storage() { throw new Error("MongoDB storage is used; Firebase Storage is disabled"); }
};
admin.firestore.FieldValue = firestoreApi.FieldValue;
admin.credential = { applicationDefault: () => ({}) };

export default admin;
