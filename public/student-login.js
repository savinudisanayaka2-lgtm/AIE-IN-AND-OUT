let clerk;

async function establishSession() {
  if (!clerk.user || !clerk.session) return false;
  const token = await clerk.session.getToken();
  const response = await fetch("/api/student/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const data = await response.json();
  if (!response.ok) {
    document.getElementById("message").textContent = data.error || "Your student account is not registered.";
    return false;
  }
  location.href = "/branch.html";
  return true;
}

async function start() {
  const configResponse = await fetch("/api/config");
  const config = await configResponse.json();

  if (!config.clerkPublishableKey) {
    document.getElementById("message").textContent =
      "Clerk is not configured yet. Add CLERK_PUBLISHABLE_KEY to your .env file.";
    return;
  }

  const script = document.getElementById("clerk-js");
  script.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";

  script.onload = async () => {
    clerk = window.Clerk;
    await clerk.load({ publishableKey: config.clerkPublishableKey });

    if (clerk.user) {
      await establishSession();
      return;
    }

    clerk.mountSignIn(document.getElementById("clerk"), {
      routing: "hash"
    });

    clerk.addListener(({ user }) => {
      if (user) establishSession().catch(error => {
        document.getElementById("message").textContent = error.message;
      });
    });
  };
}

start().catch(error => {
  document.getElementById("message").textContent =
    error.message || "Could not start student login.";
});
