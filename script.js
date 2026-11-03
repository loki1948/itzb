let selectedRole = null;
let selectedRating = 0;
let currentPerson = 0;

const people = [
  { name: "Arun", skill: "Computer & Phone Help", rating: 4.8, distance: "0.8 km" },
  { name: "Priya", skill: "Math & Science Tutor", rating: 4.9, distance: "1.1 km" },
  { name: "Rahul", skill: "Home Repair", rating: 4.6, distance: "1.4 km" }
];

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function showRole() { showScreen("roles"); }
function enterGuest() { showScreen("guest"); }

function selectRole(role, element) {
  selectedRole = role;
  document.querySelectorAll(".role-card").forEach(c => c.classList.remove("selected"));
  element.classList.add("selected");
}

function login() {
  if (!selectedRole) {
    alert("Please choose how you want to use ItzB.");
    return;
  }
  showScreen("home");
  const messages = {
    need: "Find someone who can help you",
    helper: "Find people who need your skills",
    both: "Find help or help someone nearby"
  };
  document.getElementById("welcome").textContent = messages[selectedRole];
}

function toggleFilters() {
  document.getElementById("filters").classList.toggle("show");
}

function applyFilters() {
  const radius = document.getElementById("radius").value;
  const date = document.getElementById("date").value || "Any date";
  const time = document.getElementById("time").value || "Any time";
  const type = document.getElementById("helpType").value;
  document.getElementById("swipeMessage").textContent =
    `Filters: ${radius} • ${type} • ${date} • ${time}`;
}

function searchTasks() {
  const search = document.getElementById("search").value.toLowerCase().trim();
  if (!search) return;
  const person = people.find(p =>
    `${p.name} ${p.skill}`.toLowerCase().includes(search)
  );
  if (person) updateCard(person);
}

function updateCard(person) {
  document.getElementById("personName").textContent = person.name;
  document.getElementById("personSkill").textContent = person.skill;
  document.getElementById("personRating").textContent = person.rating;
  document.getElementById("personDistance").textContent = person.distance;
}

function swipeLeft() {
  const card = document.getElementById("card");
  card.style.transform = "translateX(-500px) rotate(-20deg)";
  card.style.opacity = "0";
  setTimeout(() => {
    nextPerson();
    card.style.transform = "translateX(0)";
    card.style.opacity = "1";
  }, 400);
}

function swipeRight() {
  const card = document.getElementById("card");
  card.style.transform = "translateX(500px) rotate(20deg)";
  card.style.opacity = "0";
  setTimeout(() => {
    card.style.transform = "translateX(0)";
    card.style.opacity = "1";
    document.getElementById("swipeMessage").textContent = "✅ Help request sent!";
    showScreen("chat");
  }, 400);
}

function nextPerson() {
  currentPerson = (currentPerson + 1) % people.length;
  updateCard(people[currentPerson]);
}

function viewWork() {
  alert("Previous work photos would appear here in the full version.");
}

function sendMessage() {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();
  if (!text) return;
  const message = document.createElement("div");
  message.className = "message sent";
  message.textContent = text;
  document.getElementById("messages").appendChild(message);
  input.value = "";
}

function completeTask() {
  showScreen("ratingScreen");
}

function setRating(number) {
  selectedRating = number;
  document.getElementById("selectedRating").textContent =
    `You selected ${number} / 5 stars`;
}

function submitRating() {
  if (!selectedRating) {
    alert("Please select a rating.");
    return;
  }
  alert(`Thank you! You gave ${selectedRating}/5 stars.`);
  showScreen("profile");
  document.getElementById("completedTasks").textContent = "25";
}
