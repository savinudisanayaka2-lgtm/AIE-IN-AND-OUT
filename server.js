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

dotenv.config();

const { Pool } = pg;
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const TEACHER_PIN_HASH = process.env.TEACHER_PIN_HASH;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET || !TEACHER_PIN_HASH || !DATABASE_URL) {
  console.error("Missing DATABASE_URL, JWT_SECRET, or TEACHER_PIN_HASH in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
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

    CREATE TABLE IF NOT EXISTS attendance_events (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_student_time
      ON attendance_events(student_id, recorded_at DESC);
  `);

  // Upgrade the original event-based table to daily arrival/departure sessions.
  await pool.query(`
    ALTER TABLE attendance_events
      ADD COLUMN IF NOT EXISTS attendance_date DATE,
      ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ;
  `);

  // Existing records from the original version are treated as arrival records.
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_attendance_student_date
      ON attendance_events(student_id, attendance_date);
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

app.get("/api/students", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name FROM students WHERE active = TRUE ORDER BY name"
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Could not load students." });
  }
});

// Returns the student's attendance state for the current New Zealand day.
app.get("/api/attendance/status", async (req, res) => {
  const studentId = Number(req.query.studentId);

  if (!Number.isInteger(studentId)) {
    return res.status(400).json({ error: "Invalid student." });
  }

  try {
    const result = await pool.query(`
      SELECT id, arrived_at, left_at
      FROM attendance_events
      WHERE student_id = $1
        AND attendance_date = (NOW() AT TIME ZONE 'Pacific/Auckland')::date
      ORDER BY id DESC
      LIMIT 1
    `, [studentId]);

    if (!result.rowCount) {
      return res.json({
        status: "not_started",
        arrivedAt: null,
        leftAt: null
      });
    }

    const row = result.rows[0];

    if (row.left_at) {
      return res.json({
        status: "completed",
        id: row.id,
        arrivedAt: row.arrived_at,
        leftAt: row.left_at
      });
    }

    return res.json({
      status: "arrived",
      id: row.id,
      arrivedAt: row.arrived_at,
      leftAt: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load attendance status." });
  }
});

app.post("/api/attendance", studentLimiter, async (req, res) => {
  const studentId = Number(req.body.studentId);

  if (!Number.isInteger(studentId)) {
    return res.status(400).json({ error: "Invalid student." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Prevent two quick/concurrent presses for the same student creating
    // or completing the same day's attendance session twice.
    await client.query("SELECT pg_advisory_xact_lock($1)", [studentId]);

    const student = await client.query(
      "SELECT id, name FROM students WHERE id = $1 AND active = TRUE",
      [studentId]
    );

    if (!student.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Student not found." });
    }

    const current = await client.query(`
      SELECT id, arrived_at, left_at
      FROM attendance_events
      WHERE student_id = $1
        AND attendance_date = (NOW() AT TIME ZONE 'Pacific/Auckland')::date
      ORDER BY id DESC
      LIMIT 1
    `, [studentId]);

    if (!current.rowCount) {
      const event = await client.query(`
        INSERT INTO attendance_events (
          student_id,
          attendance_date,
          arrived_at,
          recorded_at
        )
        VALUES (
          $1,
          (NOW() AT TIME ZONE 'Pacific/Auckland')::date,
          NOW(),
          NOW()
        )
        RETURNING id, arrived_at, left_at
      `, [studentId]);

      await client.query("COMMIT");

      return res.status(201).json({
        action: "arrived",
        id: event.rows[0].id,
        student: student.rows[0].name,
        arrivedAt: event.rows[0].arrived_at,
        leftAt: null,
        status: "arrived"
      });
    }

    const row = current.rows[0];

    if (row.left_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Attendance is already complete for today.",
        status: "completed",
        arrivedAt: row.arrived_at,
        leftAt: row.left_at
      });
    }

    const event = await client.query(`
      UPDATE attendance_events
      SET left_at = NOW()
      WHERE id = $1
      RETURNING id, arrived_at, left_at
    `, [row.id]);

    await client.query("COMMIT");

    return res.status(200).json({
      action: "left",
      id: event.rows[0].id,
      student: student.rows[0].name,
      arrivedAt: event.rows[0].arrived_at,
      leftAt: event.rows[0].left_at,
      status: "completed"
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
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

    const sql = `
      SELECT
        ae.id,
        s.id AS student_id,
        s.name,
        ae.attendance_date,
        ae.arrived_at,
        ae.left_at
      FROM attendance_events ae
      JOIN students s ON s.id = ae.student_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ae.attendance_date DESC, ae.arrived_at DESC
      LIMIT 10000
    `;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load attendance." });
  }
});

app.post("/api/teacher/students", teacherAuth, async (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name || name.length > 100) {
    return res.status(400).json({ error: "Enter a valid student name." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO students (name) VALUES ($1) RETURNING id, name",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch {
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
    SELECT
      s.name AS "Student",
      ae.attendance_date AS "Date",
      ae.arrived_at AS "Arrived UTC",
      ae.arrived_at AT TIME ZONE 'Pacific/Auckland' AS "Arrived NZ",
      ae.left_at AS "Left UTC",
      ae.left_at AT TIME ZONE 'Pacific/Auckland' AS "Left NZ"
    FROM attendance_events ae
    JOIN students s ON s.id = ae.student_id
    ORDER BY ae.attendance_date ASC, ae.arrived_at ASC
  `);
  return result.rows;
}

app.get("/api/teacher/export.csv", teacherAuth, async (req, res) => {
  const rows = await getExportRows();

  const headers = ["Student", "Date", "Arrived UTC", "Arrived NZ", "Left UTC", "Left NZ"];
  const csv = [
    headers.join(","),
    ...rows.map(row => headers.map(h => {
      const value = row[h] ?? "";
      return `"${String(value).replaceAll('"', '""')}"`;
    }).join(","))
  ].join("\n");

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

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="attendance.xlsx"');
  res.send(buffer);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Attendance system running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database startup failed:", err);
    process.exit(1);
  });
