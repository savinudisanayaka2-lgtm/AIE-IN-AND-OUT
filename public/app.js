const button = document.getElementById("attendanceBtn");
const message = document.getElementById("message");
const myEvents = document.getElementById("myEvents");
const liveClock = document.getElementById("liveClock");
let currentStatus = "not_started";

function nzDateTime(value = new Date()) {
  return new Intl.DateTimeFormat("en-NZ", { timeZone:"Pacific/Auckland", dateStyle:"medium", timeStyle:"medium" }).format(new Date(value));
}
function updateClock(){ if(liveClock) liveClock.textContent=nzDateTime(); }
setInterval(updateClock,1000); updateClock();

function resetMyEvents(){ if(myEvents) myEvents.innerHTML=""; }
function showEventTimes(status){
  resetMyEvents();
  if(status.arrivedAt){const x=document.createElement("div");x.className="event";x.textContent=`Arrived: ${nzDateTime(status.arrivedAt)}`;myEvents.appendChild(x)}
  if(status.leftAt){const x=document.createElement("div");x.className="event";x.textContent=`Left: ${nzDateTime(status.leftAt)}`;myEvents.appendChild(x)}
}
function applyStatus(status){
  currentStatus=status.status;showEventTimes(status);
  if(currentStatus==="not_started"){button.disabled=false;button.textContent="I'M HERE";button.className="attendance-btn";message.textContent="";return}
  if(currentStatus==="arrived"){button.disabled=false;button.textContent="I'M LEAVING";button.className="attendance-btn leaving";message.textContent=`You arrived at ${nzDateTime(status.arrivedAt)}. Press I'M LEAVING when you leave.`;message.className="message success";return}
  button.disabled=true;button.textContent="ATTENDANCE COMPLETE";button.className="attendance-btn complete";message.textContent=`Attendance complete. You arrived at ${nzDateTime(status.arrivedAt)} and left at ${nzDateTime(status.leftAt)}.`;message.className="message success";
}

async function load(){
  const me=await fetch("/api/student/me");
  if(!me.ok){location.href="/student-login.html";return}
  const data=await me.json();
  const branchId=sessionStorage.getItem("aieBranchId");
  const subjectId=sessionStorage.getItem("aieSubjectId");
  const branchName=sessionStorage.getItem("aieBranchName");
  const subjectName=sessionStorage.getItem("aieSubjectName");
  if(!branchId||!subjectId){location.href="/branch.html";return}
  document.getElementById("welcome").textContent=`${data.student.name}'s attendance`;
  document.getElementById("context").textContent=`${branchName} • ${subjectName}`;
  const response=await fetch(`/api/attendance/status?branchId=${encodeURIComponent(branchId)}&subjectId=${encodeURIComponent(subjectId)}`);
  const status=await response.json();
  if(!response.ok) throw new Error(status.error||"Could not check attendance.");
  applyStatus(status);
}
button.addEventListener("click",async()=>{
  button.disabled=true;button.textContent="RECORDING...";
  try{
    const response=await fetch("/api/attendance",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      branchId:Number(sessionStorage.getItem("aieBranchId")),
      subjectId:Number(sessionStorage.getItem("aieSubjectId"))
    })});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||"Could not record attendance.");
    applyStatus(data);
  }catch(error){
    message.textContent=error.message;message.className="message error";
    if(currentStatus==="arrived"){button.disabled=false;button.textContent="I'M LEAVING"}else if(currentStatus!=="completed"){button.disabled=false;button.textContent="I'M HERE"}
  }
});
load().catch(error=>{message.textContent=error.message;message.className="message error"});