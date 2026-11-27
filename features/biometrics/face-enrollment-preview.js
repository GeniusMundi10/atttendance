// PURPOSE: Run the fictional enrollment journey locally without accessing a camera or an attendance service.
"use strict";
const byId = id => document.getElementById(id);
const storageKey = "elt.preview.asha.face-registration.v1";
const fiveMinutes = 5 * 60 * 1000;
let memoryRecord = {registered:false, revision:0};
let transientStorage = false;
let issued = null;
let claim = null;
let screen = "home";
let progressTimer;

function account() {
  try {
    if (!transientStorage) {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved && typeof saved.registered === "boolean" && Number.isSafeInteger(saved.revision)) memoryRecord = saved;
    }
  } catch { transientStorage = true; }
  return memoryRecord;
}
function saveRegistration(registered) {
  memoryRecord = {registered, revision:account().revision + 1};
  try { localStorage.setItem(storageKey, JSON.stringify(memoryRecord)); }
  catch { transientStorage = true; }
}
function announce(message) { byId("notice").textContent = message; }
function clearSession() {
  clearInterval(progressTimer);
  issued = null;
  claim = null;
}
function currentCode() {
  const record = account();
  return issued && !record.registered && issued.revision === record.revision && issued.until > Date.now();
}
function drawAccount() {
  const registered = account().registered;
  const card = byId("account-card");
  const issue = byId("issue");
  issue.hidden = registered || !!claim;
  card.classList.toggle("ready", registered);
  if (registered) {
    card.innerHTML = '<strong class="ok">✓ Registered</strong><p>Your face is registered. Only HR can reopen registration for your account.</p>';
  } else if (claim) {
    card.innerHTML = '<strong>Continue at the kiosk</strong><p>Your code was accepted. Follow the guide on the kiosk screen.</p>';
  } else if (currentCode()) {
    card.innerHTML = '<small>Your six-digit code</small><div class="code"></div><small class="expiry"></small>';
    const digits = card.querySelector(".code");
    digits.textContent = issued.value.slice(0,3) + " " + issued.value.slice(3);
    digits.setAttribute("aria-label", issued.value.split("").join(" "));
    card.querySelector(".expiry").textContent = "Valid until " + new Date(issued.until).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) + " at Lake Road.";
    issue.textContent = "Get a new code";
  } else {
    card.innerHTML = issued
      ? '<strong>Code expired</strong><p>Get a fresh code when you’re ready at the kiosk.</p>'
      : '<strong>Ready to register</strong><p>Get a six-digit code, then take it to the kiosk at your site.</p>';
    issue.textContent = issued ? "Get a new code" : "Register my face";
  }
  byId("hr-status").textContent = registered ? "Registered" : "Available";
  byId("hr-note").textContent = registered ? "A reset makes face registration available again for this employee." : "This employee can register their face in Attendance.";
  byId("reset").disabled = !registered;
}
byId("issue").onclick = () => {
  if (account().registered || claim) { drawAccount(); return; }
  const value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6,"0");
  issued = {value, revision:account().revision, until:Date.now()+fiveMinutes};
  drawAccount();
};

function kiosk(title, content, focus = true) {
  byId("kiosk").innerHTML = '<h2 id="kiosk-title" tabindex="-1"></h2>' + content;
  byId("kiosk-title").textContent = title;
  if (focus) byId("kiosk-title").focus({preventScroll:true});
}
const cancelButton = '<button type="button" class="text-button" id="cancel">Cancel</button>';
function home(focus = true) {
  screen = "home";
  clearInterval(progressTimer);
  claim = null;
  kiosk("Welcome to the kiosk", '<div class="scene" aria-hidden="true"><div class="scanner"></div></div><p>For your first face check-in, start with the code from your employee app.</p><button id="setup" class="primary">Set up biometric</button>', focus);
  byId("setup").onclick = enterCode;
  drawAccount();
}
function enterCode() {
  screen = "entry";
  kiosk("Enter your code", '<form class="entry" novalidate><label for="digits">Six-digit registration code</label><input class="field" id="digits" type="text" inputmode="numeric" pattern="[0-9]{6}" autocomplete="off" spellcheck="false" placeholder="000 000" aria-describedby="entry-help error"><p id="entry-help">Type, paste, or use the keypad below.</p><p id="error" role="alert" class="err" hidden></p><div class="pad" role="group" aria-label="Numeric keypad"></div><div class="actions"><button type="submit" class="primary">Continue</button>' + cancelButton + '</div></form>',false);
  const input = byId("digits");
  const pad = document.querySelector(".pad");
  function invalid(message) {
    byId("error").textContent = message;
    byId("error").hidden = false;
    input.setAttribute("aria-invalid","true");
    input.focus();
  }
  function clearError() {
    byId("error").hidden = true;
    input.removeAttribute("aria-invalid");
  }
  input.oninput = () => {
    const before = input.value;
    const offset = before.slice(0,input.selectionStart).replace(/\D/g,"").length;
    input.value = before.replace(/\D/g,"").slice(0,6);
    input.setSelectionRange(Math.min(offset,6),Math.min(offset,6));
    clearError();
  };
  for (const key of ["1","2","3","4","5","6","7","8","9","Clear","0","Delete"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key;
    if (key.length > 1) button.className = "edit";
    button.onclick = () => {
      let start = input.selectionStart, end = input.selectionEnd;
      if (key === "Clear") input.value = "";
      else if (key === "Delete") input.setRangeText("",start === end ? Math.max(0,start-1) : start,end,"end");
      else if (input.value.length - (end-start) < 6) input.setRangeText(key,start,end,"end");
      clearError();
      input.focus();
    };
    pad.append(button);
  }
  input.form.onsubmit = event => {
    event.preventDefault();
    if (input.value.length !== 6) return invalid("Enter all six digits from your employee app.");
    if (!currentCode() || input.value !== issued.value) return invalid("This code didn’t work. Check your app for the current code.");
    claim = {revision:issued.revision, until:Date.now()+fiveMinutes};
    issued = null;
    consent();
  };
  byId("cancel").onclick = () => home();
  input.focus();
}
function consent() {
  screen = "consent";
  drawAccount();
  kiosk("Register your face", '<p><strong>Asha Rao · Lake Road office</strong></p><p>The kiosk uses your face to recognize you at check-in. In this preview you can try the camera guide with simulated samples.</p><div class="actions"><button id="start" class="primary">Agree and try capture</button>' + cancelButton + '</div>');
  byId("start").onclick = capture;
  byId("cancel").onclick = () => home();
}
function claimIsLive() {
  const record = account();
  return claim && claim.revision === record.revision && !record.registered && claim.until > Date.now();
}
function capture() {
  if (!claimIsLive()) { clearSession(); home(); announce("Registration session ended."); return; }
  screen = "capture";
  kiosk("Face the camera", '<div class="scene" aria-hidden="true"><div class="scanner"></div></div><p id="samples" role="status">Hold still · 0 of 3 samples</p>' + cancelButton);
  byId("cancel").onclick = () => home();
  let samples = 0;
  progressTimer = setInterval(() => {
    if (!claimIsLive()) { clearSession(); home(); return; }
    samples += 1;
    byId("samples").textContent = samples + " of 3 samples captured";
    if (samples === 3) {
      saveRegistration(true);
      clearSession();
      screen = "done";
      drawAccount();
      kiosk("Face registered", '<p>Asha is ready for face attendance at Lake Road.</p><div class="actions"><button class="primary" id="check-in">Check in</button><button class="outline" id="finish">Finish</button></div>');
      byId("check-in").onclick = () => {
        kiosk("Check in", '<p>The live kiosk starts a fresh attendance capture here. This preview has finished your registration.</p><button class="primary" id="finish">Finish</button>');
        byId("finish").onclick = () => home();
      };
      byId("finish").onclick = () => home();
    }
  },650);
}
function viewHR(active) {
  if (claim || screen === "entry" || screen === "done") home(false);
  byId("employee-view").hidden = active;
  byId("hr-view").hidden = !active;
  byId("hr-tab").setAttribute("aria-pressed",String(active));
  byId("employee-tab").setAttribute("aria-pressed",String(!active));
  byId("page-title").textContent = active ? "Registration management" : "Face registration";
  byId("intro").textContent = active ? "Manage face registration for an employee." : "Get a code in your employee app. Enter it at the kiosk to register your face.";
  drawAccount();
}
byId("hr-tab").onclick = () => viewHR(true);
byId("employee-tab").onclick = () => viewHR(false);
const confirmation = byId("confirm-reset");
byId("reset").onclick = () => {
  if (account().registered) { confirmation.returnValue = ""; confirmation.showModal(); }
};
confirmation.addEventListener("close", () => {
  if (confirmation.returnValue !== "reset" || !account().registered) return;
  saveRegistration(false);
  clearSession();
  home(false);
  announce("HR reset complete. Asha can register again.");
});
window.addEventListener("storage", event => {
  if (event.key === storageKey) { clearSession(); home(false); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && ["entry","consent","capture","done"].includes(screen)) home(false);
});
setInterval(() => {
  if (issued && issued.until <= Date.now() && !issued.expiryShown) {
    issued.expiryShown = true;
    drawAccount();
  }
  if (claim && claim.until <= Date.now()) { clearSession(); home(false); announce("Session expired. Get a new code."); }
},1000);
home(false);
