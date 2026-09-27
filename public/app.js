const select = document.getElementById("studentSelect");
const button = document.getElementById("attendanceBtn");
const message = document.getElementById("message");
const myEvents = document.getElementById("myEvents");
const liveClock = document.getElementById("liveClock");

let currentStatus = "not_started";

function nzDateTime(value = new Date()) {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function updateClock() {
  liveClock.textContent = nzDateTime();
}

setInterval(updateClock, 1000);
updateClock();

function resetMyEvents() {
  myEvents.innerHTML = "";
}

function showEventTimes(status) {
  resetMyEvents();

  if (status.arrivedAt) {
    const arrival = document.createElement("div");
    arrival.className = "event";
    arrival.textContent = `Arrived: ${nzDateTime(status.arrivedAt)}`;
    myEvents.appendChild(arrival);
  }

  if (status.leftAt) {
    const leaving = document.createElement("div");
    leaving.className = "event";
    leaving.textContent = `Left: ${nzDateTime(status.leftAt)}`;
    myEvents.appendChild(leaving);
  }
}

function applyStatus(status) {
  currentStatus = status.status;
  showEventTimes(status);

  if (currentStatus === "not_started") {
    button.disabled = !select.value;
    button.textContent = "I'M HERE";
    button.className = "attendance-btn";
    message.textContent = "";
    return;
  }

  if (currentStatus === "arrived") {
    button.disabled = false;
    button.textContent = "I'M LEAVING";
    button.className = "attendance-btn leaving";
    message.textContent = `You arrived at ${nzDateTime(status.arrivedAt)}. Press I'M LEAVING when you leave.`;
    message.className = "message success";
    return;
  }

  button.disabled = true;
  button.textContent = "ATTENDANCE COMPLETE";
  button.className = "attendance-btn complete";
  message.textContent = `Attendance complete. You arrived at ${nzDateTime(status.arrivedAt)} and left at ${nzDateTime(status.leftAt)}.`;
  message.className = "message success";
}

async function loadStatus(studentId) {
  if (!studentId) {
    applyStatus({ status: "not_started", arrivedAt: null, leftAt: null });
    return;
  }

  button.disabled = true;
  button.textContent = "CHECKING...";

  try {
    const response = await fetch(`/api/attendance/status?studentId=${encodeURIComponent(studentId)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not check attendance.");
    }

    applyStatus(data);
  } catch (error) {
    currentStatus = "not_started";
    button.disabled = true;
    button.textContent = "TRY AGAIN";
    message.textContent = error.message;
    message.className = "message error";
  }
}

async function loadStudents() {
  const response = await fetch("/api/students");
  const students = await response.json();

  if (!response.ok) {
    throw new Error(students.error || "Could not load students.");
  }

  select.innerHTML = '<option value="">Choose your name...</option>';

  for (const student of students) {
    const option = document.createElement("option");
    option.value = student.id;
    option.textContent = student.name;
    select.appendChild(option);
  }
}

select.addEventListener("change", () => {
  message.textContent = "";
  resetMyEvents();
  loadStatus(select.value);
});

button.addEventListener("click", async () => {
  if (!select.value || currentStatus === "completed") return;

  button.disabled = true;
  button.textContent = "RECORDING...";

  try {
    const response = await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: Number(select.value) })
    });

    const data = await response.json();

    if (!response.ok) {
      if (data.status === "completed") {
        applyStatus({
          status: "completed",
          arrivedAt: data.arrivedAt,
          leftAt: data.leftAt
        });
      }
      throw new Error(data.error || "Could not record attendance.");
    }

    if (data.action === "arrived") {
      message.textContent = `Arrival recorded at ${nzDateTime(data.arrivedAt)}. Press I'M LEAVING when you leave.`;
      message.className = "message success";
    } else {
      message.textContent = `Departure recorded at ${nzDateTime(data.leftAt)}. Attendance is now complete for today.`;
      message.className = "message success";
    }

    applyStatus({
      status: data.status,
      arrivedAt: data.arrivedAt,
      leftAt: data.leftAt
    });
  } catch (error) {
    if (currentStatus !== "completed") {
      message.textContent = error.message;
      message.className = "message error";
      if (currentStatus === "arrived") {
        button.disabled = false;
        button.textContent = "I'M LEAVING";
      } else {
        button.disabled = false;
        button.textContent = "I'M HERE";
      }
    }
  }
});

loadStudents().catch((error) => {
  select.innerHTML = '<option value="">Could not load students</option>';
  message.textContent = error.message;
  message.className = "message error";
});
