import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import dotenv from "dotenv";
import pg from "pg";
import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";
import { verifyToken } from "@clerk/backend";

dotenv.config();

const { Pool } = pg;
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const TEACHER_PIN_HASH = process.env.TEACHER_PIN_HASH;
const DATABASE_URL = process.env.DATABASE_URL;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;

if (!JWT_SECRET || !TEACHER_PIN_HASH || !DATABASE_URL) {
  console.error("Missing DATABASE_URL, JWT_SECRET, or TEACHER_PIN_HASH in .env");
  process.exit(1);
}

if (!CLERK_SECRET_KEY || !CLERK_PUBLISHABLE_KEY) {
  console.warn("Clerk is not configured. Student login will not work until CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are added.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const studentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute." }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS student_branches (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      branch_type TEXT NOT NULL DEFAULT 'main'
        CHECK (branch_type IN ('main', 'replacement')),
      PRIMARY KEY (student_id, branch_id)
    );

    CREATE TABLE IF NOT EXISTS student_subjects (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      PRIMARY KEY (student_id, subject_id)
    );

    CREATE TABLE IF NOT EXISTS attendance_events (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE students
      ADD COLUMN IF NOT EXISTS clerk_user_id TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT;

    ALTER TABLE attendance_events
      ADD COLUMN IF NOT EXISTS attendance_date DATE,
      ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id),
      ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_clerk_user
      ON students(clerk_user_id)
      WHERE clerk_user_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_attendance_student_date
      ON attendance_events(student_id, attendance_date);

    CREATE INDEX IF NOT EXISTS idx_attendance_student_branch_subject_date
      ON attendance_events(student_id, branch_id, subject_id, attendance_date);
  `);

  // Existing Release 1 records are retained as legacy attendance.
  await pool.query(`
    UPDATE attendance_events
    SET
      attendance_date = COALESCE(
        attendance_date,
        (recorded_at AT TIME ZONE 'Pacific/Auckland')::date
      ),
      arrived_at = COALESCE(arrived_at, recorded_at)
    WHERE attendance_date IS NULL OR arrived_at IS NULL;
  `);

  // Seed only the branch names that are known from the current project brief.
  await pool.query(`
    INSERT INTO branches (name) VALUES
      ('Meadowbank'), ('Flatbush'), ('Northshore')
    ON CONFLICT (name) DO NOTHING;
  `);

  const count = await pool.query("SELECT COUNT(*)::int AS count FROM students");
  if (count.rows[0].count === 0) {
    await pool.query(
      `INSERT INTO students (name) VALUES
       ('Student 1'), ('Student 2'), ('Student 3'), ('Student 4'), ('Student 5')`
    );
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function teacherAuth(req, res, next) {
  const token = req.cookies.teacher_token;
  if (!token) return res.status(401).json({ error: "Teacher login required." });

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Teacher login required." });
  }
}

async function getClerkUserId(req) {
  if (!CLERK_SECRET_KEY) return null;

  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const token = bearer || req.cookies.student_token;
  if (!token) return null;

  try {
    const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    return payload.sub || null;
  } catch {
    return null;
  }
}

async function studentAuth(req, res, next) {
  const clerkUserId = await getClerkUserId(req);
  if (!clerkUserId) {
    return res.status(401).json({ error: "Student login required." });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email
       FROM students
       WHERE clerk_user_id = $1 AND active = TRUE`,
      [clerkUserId]
    );

    if (!result.rowCount) {
      return res.status(403).json({
        error: "Your student account has not been registered by a teacher yet."
      });
    }

    req.student = result.rows[0];
    req.clerkUserId = clerkUserId;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not verify student account." });
  }
}

app.get("/api/config", (req, res) => {
  res.json({
    clerkPublishableKey: CLERK_PUBLISHABLE_KEY || null
  });
});

// Clerk frontend calls this once after successful login.
// The server verifies the Clerk token before creating its own short-lived
// httpOnly cookie for the student flow.
app.post("/api/student/session", async (req, res) => {
  const token = String(req.body.token || "");
  if (!token || !CLERK_SECRET_KEY) {
    return res.status(401).json({ error: "Student authentication is not configured." });
  }

  try {
    const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    const clerkUserId = payload.sub;

    const student = await pool.query(
      `SELECT id, name, email
       FROM students
       WHERE clerk_user_id = $1 AND active = TRUE`,
      [clerkUserId]
    );

    if (!student.rowCount) {
      return res.status(403).json({
        error: "Your student account has not been registered by a teacher yet."
      });
    }

    res.cookie("student_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    });

    res.json({ ok: true, student: student.rows[0] });
  } catch {
    res.status(401).json({ error: "Invalid student session." });
  }
});

app.post("/api/student/logout", (req, res) => {
  res.clearCookie("student_token");
  res.json({ ok: true });
});

app.get("/api/student/me", studentAuth, async (req, res) => {
  const branches = await pool.query(`
    SELECT b.id, b.name, sb.branch_type AS type
    FROM student_branches sb
    JOIN branches b ON b.id = sb.branch_id
    WHERE sb.student_id = $1 AND b.active = TRUE
    ORDER BY CASE WHEN sb.branch_type = 'main' THEN 0 ELSE 1 END, b.name
  `, [req.student.id]);

  res.json({
    student: req.student,
    branches: branches.rows
  });
});

app.get("/api/student/subjects", studentAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, s.name
    FROM student_subjects ss
    JOIN subjects s ON s.id = ss.subject_id
    WHERE ss.student_id = $1 AND s.active = TRUE
    ORDER BY s.name
  `, [req.student.id]);

  res.json({ subjects: result.rows });
});

app.get("/api/students", teacherAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, clerk_user_id
       FROM students WHERE active = TRUE ORDER BY name`
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Could not load students." });
  }
});

async function verifyStudentSelections(studentId, branchId, subjectId) {
  const result = await pool.query(`
    SELECT
      b.id AS branch_id,
      b.name AS branch_name,
      s.id AS subject_id,
      s.name AS subject_name
    FROM student_branches sb
    JOIN branches b ON b.id = sb.branch_id AND b.active = TRUE
    CROSS JOIN student_subjects ss
    JOIN subjects s ON s.id = ss.subject_id AND s.active = TRUE
    WHERE sb.student_id = $1
      AND ss.student_id = $1
      AND b.id = $2
      AND s.id = $3
  `, [studentId, branchId, subjectId]);

  return result.rowCount ? result.rows[0] : null;
}

app.get("/api/attendance/status", studentAuth, async (req, res) => {
  const branchId = Number(req.query.branchId);
  const subjectId = Number(req.query.subjectId);

  if (!Number.isInteger(branchId) || !Number.isInteger(subjectId)) {
    return res.status(400).json({ error: "Invalid branch or subject." });
  }

  const allowed = await verifyStudentSelections(req.student.id, branchId, subjectId);
  if (!allowed) return res.status(403).json({ error: "That branch or subject is not assigned to you." });

  try {
    const result = await pool.query(`
      SELECT id, arrived_at, left_at
      FROM attendance_events
      WHERE student_id = $1
        AND branch_id = $2
        AND subject_id = $3
        AND attendance_date = (NOW() AT TIME ZONE 'Pacific/Auckland')::date
      ORDER BY id DESC
      LIMIT 1
    `, [req.student.id, branchId, subjectId]);

    if (!result.rowCount) {
      return res.json({ status: "not_started", arrivedAt: null, leftAt: null });
    }

    const row = result.rows[0];
    if (row.left_at) {
      return res.json({ status: "completed", id: row.id, arrivedAt: row.arrived_at, leftAt: row.left_at });
    }

    res.json({ status: "arrived", id: row.id, arrivedAt: row.arrived_at, leftAt: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load attendance status." });
  }
});

app.post("/api/attendance", studentLimiter, studentAuth, async (req, res) => {
  const branchId = Number(req.body.branchId);
  const subjectId = Number(req.body.subjectId);

  if (!Number.isInteger(branchId) || !Number.isInteger(subjectId)) {
    return res.status(400).json({ error: "Invalid branch or subject." });
  }

  const allowed = await verifyStudentSelections(req.student.id, branchId, subjectId);
  if (!allowed) return res.status(403).json({ error: "That branch or subject is not assigned to you." });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [req.student.id * 100000 + branchId * 100 + subjectId]);

    const current = await client.query(`
      SELECT id, arrived_at, left_at
      FROM attendance_events
      WHERE student_id = $1
        AND branch_id = $2
        AND subject_id = $3
        AND attendance_date = (NOW() AT TIME ZONE 'Pacific/Auckland')::date
      ORDER BY id DESC
      LIMIT 1
    `, [req.student.id, branchId, subjectId]);

    if (!current.rowCount) {
      const event = await client.query(`
        INSERT INTO attendance_events
          (student_id, branch_id, subject_id, attendance_date, arrived_at, recorded_at)
        VALUES
          ($1, $2, $3, (NOW() AT TIME ZONE 'Pacific/Auckland')::date, NOW(), NOW())
        RETURNING id, arrived_at, left_at
      `, [req.student.id, branchId, subjectId]);

      await client.query("COMMIT");
      return res.status(201).json({
        action: "arrived",
        id: event.rows[0].id,
        student: req.student.name,
        branch: allowed.branch_name,
        subject: allowed.subject_name,
        arrivedAt: event.rows[0].arrived_at,
        leftAt: null,
        status: "arrived"
      });
    }

    const row = current.rows[0];

    if (row.left_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Attendance is already complete for this subject today.",
        status: "completed",
        arrivedAt: row.arrived_at,
        leftAt: row.left_at
      });
    }

    const event = await client.query(`
      UPDATE attendance_events SET left_at = NOW()
      WHERE id = $1
      RETURNING id, arrived_at, left_at
    `, [row.id]);

    await client.query("COMMIT");
    res.json({
      action: "left",
      id: event.rows[0].id,
      student: req.student.name,
      branch: allowed.branch_name,
      subject: allowed.subject_name,
      arrivedAt: event.rows[0].arrived_at,
      leftAt: event.rows[0].left_at,
      status: "completed"
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(err);
    res.status(500).json({ error: "Could not record attendance." });
  } finally {
    client.release();
  }
});

app.post("/api/teacher/login", loginLimiter, (req, res) => {
  const pin = String(req.body.pin || "");
  const supplied = sha256(pin);
  const a = Buffer.from(supplied, "hex");
  const b = Buffer.from(TEACHER_PIN_HASH, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  const token = jwt.sign({ role: "teacher" }, JWT_SECRET, { expiresIn: "8h" });
  res.cookie("teacher_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post("/api/teacher/logout", (req, res) => {
  res.clearCookie("teacher_token");
  res.json({ ok: true });
});

app.get("/api/teacher/me", teacherAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.get("/api/teacher/attendance", teacherAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const date = String(req.query.date || "").trim();
    const params = [];
    const where = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`s.name ILIKE $${params.length}`);
    }
    if (date) {
      params.push(date);
      where.push(`ae.attendance_date = $${params.length}::date`);
    }

    const result = await pool.query(`
      SELECT ae.id, s.id AS student_id, s.name,
        b.name AS branch, sub.name AS subject,
        ae.attendance_date, ae.arrived_at, ae.left_at
      FROM attendance_events ae
      JOIN students s ON s.id = ae.student_id
      LEFT JOIN branches b ON b.id = ae.branch_id
      LEFT JOIN subjects sub ON sub.id = ae.subject_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ae.attendance_date DESC, ae.arrived_at DESC
      LIMIT 10000
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load attendance." });
  }
});

app.post("/api/teacher/students", teacherAuth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const clerkUserId = String(req.body.clerkUserId || "").trim() || null;

  if (!name || name.length > 100) return res.status(400).json({ error: "Enter a valid student name." });

  try {
    const result = await pool.query(
      `INSERT INTO students (name, email, clerk_user_id)
       VALUES ($1, NULLIF($2,''), $3)
       RETURNING id, name, email, clerk_user_id`,
      [name, email, clerkUserId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That Clerk user is already linked." });
    res.status(500).json({ error: "Could not add student." });
  }
});

app.delete("/api/teacher/students/:id", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid student." });
  try {
    await pool.query("UPDATE students SET active = FALSE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not remove student." });
  }
});

app.delete("/api/teacher/attendance", teacherAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM attendance_events");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not reset attendance." });
  }
});

async function getExportRows() {
  const result = await pool.query(`
    SELECT s.name AS "Student",
      b.name AS "Branch",
      sub.name AS "Subject",
      ae.attendance_date AS "Date",
      ae.arrived_at AS "Arrived UTC",
      ae.arrived_at AT TIME ZONE 'Pacific/Auckland' AS "Arrived NZ",
      ae.left_at AS "Left UTC",
      ae.left_at AT TIME ZONE 'Pacific/Auckland' AS "Left NZ"
    FROM attendance_events ae
    JOIN students s ON s.id = ae.student_id
    LEFT JOIN branches b ON b.id = ae.branch_id
    LEFT JOIN subjects sub ON sub.id = ae.subject_id
    ORDER BY ae.attendance_date ASC, ae.arrived_at ASC
  `);
  return result.rows;
}

app.get("/api/teacher/export.csv", teacherAuth, async (req, res) => {
  const rows = await getExportRows();
  const headers = ["Student","Branch","Subject","Date","Arrived UTC","Arrived NZ","Left UTC","Left NZ"];
  const csv = [headers.join(","), ...rows.map(row => headers.map(h => `"${String(row[h] ?? "").replaceAll('"','""')}"`).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="attendance.csv"');
  res.send("\ufeff" + csv);
});

app.get("/api/teacher/export.xlsx", teacherAuth, async (req, res) => {
  const rows = await getExportRows();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="attendance.xlsx"');
  res.send(buffer);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`AIE In & Out running at http://localhost:${PORT}`));
}).catch(err => {
  console.error("Database startup failed:", err);
  process.exit(1);
});