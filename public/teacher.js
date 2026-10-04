const loginCard = document.getElementById("loginCard");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const body = document.getElementById("attendanceBody");
const search = document.getElementById("search");
const date = document.getElementById("date");
const actionMessage = document.getElementById("actionMessage");

function nzDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function nzDate(value) {
  if (!value) return "—";

  // PostgreSQL DATE values arrive as YYYY-MM-DD. Formatting them manually
  // avoids accidental browser timezone shifts.
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

async function checkLogin() {
  const response = await fetch("/api/teacher/me");
  if (response.ok) showDashboard();
}

function showDashboard() {
  loginCard.hidden = true;
  dashboard.hidden = false;
  loadAttendance();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginMessage.textContent = "";

  const response = await fetch("/api/teacher/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: document.getElementById("pin").value })
  });

  const data = await response.json();

  if (!response.ok) {
    loginMessage.textContent = data.error || "Login failed.";
    loginMessage.style.color = "#ff7777";
    return;
  }

  showDashboard();
});

async function loadAttendance() {
  const params = new URLSearchParams();

  if (search.value.trim()) params.set("q", search.value.trim());
  if (date.value) params.set("date", date.value);

  const response = await fetch("/api/teacher/attendance?" + params.toString());

  if (!response.ok) {
    if (response.status === 401) location.reload();
    return;
  }

  const rows = await response.json();
  body.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = row.name;

    const dateCell = document.createElement("td");
    dateCell.textContent = nzDate(row.attendance_date);

    const arrived = document.createElement("td");
    arrived.textContent = nzDateTime(row.arrived_at);

    const left = document.createElement("td");
    left.textContent = nzDateTime(row.left_at);

    const status = document.createElement("td");
    status.textContent = row.left_at ? "Complete" : "In class";
    status.className = row.left_at ? "status-complete" : "status-in-class";

    tr.append(name, dateCell, arrived, left, status);
    body.appendChild(tr);
  }

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">No attendance records found.</td></tr>';
  }
}

let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadAttendance, 250);
});

date.addEventListener("change", loadAttendance);

document.getElementById("clearFilters").addEventListener("click", () => {
  search.value = "";
  date.value = "";
  loadAttendance();
});

document.getElementById("csvBtn").addEventListener("click", () => {
  location.href = "/api/teacher/export.csv";
});

document.getElementById("excelBtn").addEventListener("click", () => {
  location.href = "/api/teacher/export.xlsx";
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/teacher/logout", { method: "POST" });
  location.reload();
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const confirmed = confirm(
    "Are you sure? This will permanently delete ALL attendance records."
  );

  if (!confirmed) return;

  const response = await fetch("/api/teacher/attendance", { method: "DELETE" });
  const data = await response.json();

  actionMessage.textContent = data.ok
    ? "All attendance records have been reset."
    : (data.error || "Reset failed.");

  loadAttendance();
});

document.getElementById("addStudentForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const input = document.getElementById("newStudent");

  const response = await fetch("/api/teacher/students", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.value })
  });

  const data = await response.json();

  actionMessage.textContent = response.ok
    ? `${data.name} added.`
    : (data.error || "Could not add student.");

  if (response.ok) input.value = "";
});

checkLogin();
