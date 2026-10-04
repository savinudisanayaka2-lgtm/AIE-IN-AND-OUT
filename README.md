# Class Attendance System

Full-stack attendance app using:

- Frontend: HTML/CSS/JavaScript
- Backend: Node.js + Express
- Database: PostgreSQL
- Teacher authentication: PIN + signed HTTP-only cookie
- NZ date/time: `Pacific/Auckland`
- Export: CSV and Excel (`.xlsx`)

## 1. Install

Install Node.js and PostgreSQL, then:

```bash
npm install
```

Create a PostgreSQL database named `attendance`.

Copy `.env.example` to `.env` and set:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/attendance
JWT_SECRET=put-a-long-random-secret-here
TEACHER_PIN_HASH=SHA256_HASH_OF_YOUR_PIN
PORT=3000
```

Generate a PIN hash:

```bash
node -e "import('crypto').then(c=>console.log(c.createHash('sha256').update('1234').digest('hex')))"
```

Replace `1234` with your real PIN.

## 2. Start

```bash
npm start
```

Open:

http://localhost:3000

Teacher dashboard:

http://localhost:3000/teacher.html

## 3. Student attendance flow

Each student has one attendance session per New Zealand calendar day:

1. Student selects their name.
2. The button starts as **I'M HERE**.
3. Pressing **I'M HERE** records the server timestamp as the student's arrival time.
4. The button changes to **I'M LEAVING**.
5. Pressing **I'M LEAVING** records the server timestamp as the student's leaving time.
6. The button becomes **ATTENDANCE COMPLETE** and is disabled.
7. Reloading the page does not reset the status. The server/database remembers it.
8. A completed attendance session cannot be pressed again that day.

The server uses a PostgreSQL transaction and an advisory lock per student to prevent rapid/concurrent presses from creating duplicate sessions.

## 4. Teacher flow

The dashboard provides:

- student search
- date filtering
- arrival time
- leaving time
- current status (`In class` or `Complete`)
- CSV export
- Excel export
- student management
- teacher-only reset of attendance records

## 5. Database upgrade

The application automatically upgrades the original `attendance_events` table by adding:

- `attendance_date`
- `arrived_at`
- `left_at`

Existing old event records are treated as arrival records so an existing database does not immediately break.

## Important production note

The shared student name selector identifies which student is recording the event, but does not prove their identity. For real school use, add school login/SSO or unique student accounts.

For production deployment, use HTTPS and a managed PostgreSQL database. Never commit `.env` to GitHub.
"# AIE-IN-AND-OUT" 
"# AIE-IN-AND-OUT" 
