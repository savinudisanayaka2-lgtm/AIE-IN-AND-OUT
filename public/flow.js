async function getStudent() {
  const response = await fetch("/api/student/me");
  if (!response.ok) {
    location.href = "/student-login.html";
    throw new Error("Student login required.");
  }
  return response.json();
}

function option(title, subtitle, handler) {
  const button = document.createElement("button");
  button.className = "option";
  button.type = "button";
  button.innerHTML = `<span><strong></strong><small></small></span><span class="arrow">→</span>`;
  button.querySelector("strong").textContent = title;
  button.querySelector("small").textContent = subtitle || "";
  button.addEventListener("click", handler);
  return button;
}

async function branchPage() {
  const data = await getStudent();
  document.getElementById("studentName").textContent = `Signed in as ${data.student.name}`;
  const list = document.getElementById("branches");
  list.innerHTML = "";

  if (!data.branches.length) {
    list.innerHTML = '<div class="loading">No branches are registered to your account. Please contact a teacher.</div>';
    return;
  }

  data.branches.forEach(branch => {
    list.appendChild(option(branch.name, branch.type === "replacement" ? "Replacement branch" : "Main branch", () => {
      sessionStorage.setItem("aieBranchId", branch.id);
      sessionStorage.setItem("aieBranchName", branch.name);
      location.href = "/subjects.html";
    }));
  });
}

async function subjectPage() {
  const branchId = sessionStorage.getItem("aieBranchId");
  const branchName = sessionStorage.getItem("aieBranchName");
  if (!branchId || !branchName) return location.href = "/branch.html";

  document.getElementById("branchName").textContent = `Branch: ${branchName}`;
  const response = await fetch("/api/student/subjects");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load subjects.");

  const list = document.getElementById("subjects");
  list.innerHTML = "";

  if (!data.subjects.length) {
    list.innerHTML = '<div class="loading">No subjects are registered to your account. Please contact a teacher.</div>';
    return;
  }

  data.subjects.forEach(subject => {
    list.appendChild(option(subject.name, "", () => {
      sessionStorage.setItem("aieSubjectId", subject.id);
      sessionStorage.setItem("aieSubjectName", subject.name);
      location.href = "/right-now.html";
    }));
  });
}

async function rightNowPage() {
  const branch = sessionStorage.getItem("aieBranchName");
  const subject = sessionStorage.getItem("aieSubjectName");
  if (!branch || !subject) return location.href = "/branch.html";
  document.getElementById("branch").textContent = branch;
  document.getElementById("subject").textContent = subject;
}

(async () => {
  try {
    if (document.getElementById("branches")) await branchPage();
    if (document.getElementById("subjects")) await subjectPage();
    if (document.getElementById("branch")) await rightNowPage();
  } catch (error) {
    const message = document.getElementById("message");
    if (message) message.textContent = error.message;
  }
})();
