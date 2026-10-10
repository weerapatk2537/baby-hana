import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, writeBatch, addDoc, updateDoc, deleteDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

/*
 * Data model (see firestore.rules):
 *   slots/{id}   public  — date, start, end, count, giftIds, giftText, owner (no visitor name)
 *   visits/{id}  private — name of the visitor for slots/{id}; admin reads all, the owner reads their own
 * Visitors get a silent anonymous Firebase uid; "owner" is that uid, so each browser can edit its own bookings.
 *   gifts/{id}   public  — name, note, status ("have" | "need"); admin writes
 */

const DAYS = ["2026-10-13", "2026-10-14", "2026-10-15"];
const START_MIN = 9 * 60, END_MIN = 20 * 60, STEP = 30;
const SLOTS = (END_MIN - START_MIN) / STEP;
const TH_DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const TH_DOW_FULL = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

const $ = (id) => document.getElementById(id);
const fmt = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const dateObj = (d) => new Date(d + "T00:00:00");
const dayLabel = (d) => { const o = dateObj(d); return `${TH_DOW_FULL[o.getDay()]} ${o.getDate()} ต.ค. 2026`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  slots: [], gifts: [], names: {}, isAdmin: false,
  sel: { date: DAYS[0], start: 10 * 60, end: 11 * 60 },
  uid: null,        // this browser's anonymous (or admin) Firebase uid
  editing: null,    // slot id being edited, or null when registering a new visit
};
const isMine = (v) => !!state.uid && v.owner === state.uid;
const canEdit = (v) => state.isAdmin || isMine(v);

/* ---------- HANA ticker: two identical halves so the loop is seamless ---------- */
$("tickerTrack").innerHTML = Array(2 * 14).fill('<span>HANA<i>🌼</i></span>').join("");

/* ---------- Hero twinkles: a sparse scatter of four-point diamonds ---------- */
(() => {
  const colors = ["var(--pink)", "var(--purple)", "var(--sky)", "var(--accent)"];
  const n = window.innerWidth < 520 ? 6 : 10;
  const placed = [];
  let html = "";
  for (let i = 0, tries = 0; i < n && tries < 200; tries++) {
    const x = 3 + Math.random() * 94, y = 6 + Math.random() * 86;
    if (placed.some(([px, py]) => Math.hypot(px - x, (py - y) * .4) < 14)) continue;
    placed.push([x, y]);
    const size = 9 + Math.random() * 9;
    html += `<span class="tw" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;--s:${size.toFixed(1)}px;--c:${colors[i % colors.length]};--d:${(2 + Math.random() * 2).toFixed(2)}s;--delay:-${(Math.random() * 4).toFixed(2)}s"></span>`;
    i++;
  }
  $("twinkles").innerHTML = html;
})();

/* ---------- Tabs ---------- */
// One page with two sections; the menu jumps to a section and highlights the one in view
function markTab(v) { document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", String(t.dataset.view === v))); }
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  markTab(t.dataset.view);
  $("view-" + t.dataset.view).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}));
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) markTab(en.target.id.replace("view-", "")); });
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["register", "gifts"].forEach((v) => io.observe($("view-" + v)));
}
if (location.hash === "#gifts") requestAnimationFrame(() => $("view-gifts").scrollIntoView());

/* ---------- Calendar ---------- */
const cal = $("cal");
(function buildCalendar() {
  let html = `<div class="cal-head"></div>`;
  DAYS.forEach((d) => {
    const o = dateObj(d);
    html += `<div class="cal-head" data-head="${d}"><div class="dow">${TH_DOW[o.getDay()]}</div><div class="num">${o.getDate()}</div></div>`;
  });
  html += `<div class="times">`;
  for (let i = 0; i < SLOTS; i += 2) html += `<div>${fmt(START_MIN + i * STEP)}</div>`;
  html += `</div>`;
  DAYS.forEach((d) => {
    html += `<div class="day" data-day="${d}">`;
    for (let i = 0; i < SLOTS; i++) html += `<div class="slot" data-i="${i}"></div>`;
    html += `</div>`;
  });
  cal.innerHTML = html;
})();

let drag = null;
const slotIndex = (dayEl, clientY) => {
  const r = dayEl.getBoundingClientRect();
  return Math.max(0, Math.min(SLOTS - 1, Math.floor((clientY - r.top) / r.height * SLOTS)));
};
cal.addEventListener("pointerdown", (e) => {
  const booked = e.target.closest(".evt[data-id]");
  if (booked) {
    const v = state.slots.find((s) => s.id === booked.dataset.id);
    if (state.isAdmin) { openBooking(booked.dataset.id); return; }
    if (v && isMine(v)) { startEdit(v.id); return; }
  }
  const dayEl = e.target.closest(".day");
  if (!dayEl) return;
  const i = slotIndex(dayEl, e.clientY);
  const start = START_MIN + i * STEP;
  if (e.pointerType === "mouse") {
    e.preventDefault();
    drag = { day: dayEl.dataset.day, i0: i };
    setSel(drag.day, start, start + STEP);
  } else {
    // Touch: tap selects a 1-hour visit starting at this slot
    setSel(dayEl.dataset.day, start, Math.min(END_MIN, start + 60));
  }
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const i = slotIndex(cal.querySelector(`.day[data-day="${drag.day}"]`), e.clientY);
  const a = Math.min(drag.i0, i), b = Math.max(drag.i0, i);
  setSel(drag.day, START_MIN + a * STEP, START_MIN + (b + 1) * STEP);
});
window.addEventListener("pointerup", () => {
  if (drag && state.sel.end - state.sel.start === STEP) setSel(drag.day, state.sel.start, Math.min(END_MIN, state.sel.start + 60));
  drag = null;
});

function setSel(date, start, end) {
  state.sel = { date, start, end };
  renderSelection();
}

function layoutLanes(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const lanesEnd = [], out = [];
  let group = [], groupEnd = -1;
  const flush = () => { const n = Math.max(1, ...group.map((g) => g.lane + 1)); group.forEach((g) => (g.lanes = n)); group = []; lanesEnd.length = 0; };
  for (const v of sorted) {
    if (v.start >= groupEnd && group.length) flush();
    let lane = lanesEnd.findIndex((e) => e <= v.start);
    if (lane === -1) { lane = lanesEnd.length; lanesEnd.push(v.end); } else lanesEnd[lane] = v.end;
    const item = { v, lane };
    group.push(item); out.push(item);
    groupEnd = Math.max(groupEnd, v.end);
  }
  if (group.length) flush();
  return out;
}

function renderCalendarEvents() {
  cal.querySelectorAll(".evt:not(.draft)").forEach((n) => n.remove());
  DAYS.forEach((d) => {
    const dayEl = cal.querySelector(`.day[data-day="${d}"]`);
    layoutLanes(state.slots.filter((v) => v.date === d)).forEach(({ v, lane, lanes }) => {
      const el = document.createElement("div");
      el.className = "evt" + (isMine(v) ? " mine" : "") + (v.id === state.editing ? " editing" : "");
      el.dataset.id = v.id;
      el.style.top = `calc(${(v.start - START_MIN) / STEP * 100 / SLOTS}% + 1px)`;
      el.style.height = `calc(${(v.end - v.start) / STEP * 100 / SLOTS}% - 2px)`;
      el.style.left = `calc(${lane / lanes * 100}% + 2px)`;
      el.style.width = `calc(${100 / lanes}% - 4px)`;
      const label = state.isAdmin ? esc(state.names[v.id] || "(ไม่มีชื่อ)") : isMine(v) ? "ของคุณ · แก้ไข" : "Busy";
      el.innerHTML = `<b>${label}</b>${fmt(v.start)}–${fmt(v.end)}${state.isAdmin ? ` · ${v.count} คน` : ""}`;
      dayEl.appendChild(el);
    });
  });
}

function renderSelection() {
  const { date, start, end } = state.sel;
  cal.querySelectorAll(".evt.draft").forEach((n) => n.remove());
  const el = document.createElement("div");
  el.className = "evt draft";
  el.style.top = `calc(${(start - START_MIN) / STEP * 100 / SLOTS}% + 1px)`;
  el.style.height = `calc(${(end - start) / STEP * 100 / SLOTS}% - 2px)`;
  el.style.left = "2px"; el.style.right = "2px";
  el.innerHTML = `<b>${fmt(start)} – ${fmt(end)}</b>${esc($("f-name").value) || "ที่คุณเลือก"}`;
  cal.querySelector(`.day[data-day="${date}"]`).appendChild(el);
  cal.querySelectorAll(".cal-head[data-head]").forEach((h) => h.classList.toggle("sel", h.dataset.head === date));
  document.querySelectorAll(".datepill").forEach((p) => p.setAttribute("aria-pressed", String(p.dataset.date === date)));
  $("f-start").value = String(start);
  fillEndOptions();
  $("f-end").value = String(end);
  const hrs = (end - start) / 60;
  $("summary").innerHTML = `วัน<b>${dayLabel(date)}</b> เวลา <b>${fmt(start)} – ${fmt(end)} น.</b> (${hrs % 1 ? hrs.toFixed(1) : hrs} ชม.)`;
}

/* ---------- Form controls ---------- */
$("datePills").innerHTML = DAYS.map((d) => {
  const o = dateObj(d);
  return `<button type="button" class="datepill" data-date="${d}" aria-pressed="false">${TH_DOW[o.getDay()]} ${o.getDate()} ต.ค.</button>`;
}).join("");
$("datePills").addEventListener("click", (e) => {
  const p = e.target.closest(".datepill");
  if (p) setSel(p.dataset.date, state.sel.start, state.sel.end);
});
const startSel = $("f-start");
for (let m = START_MIN; m < END_MIN; m += STEP) startSel.add(new Option(fmt(m) + " น.", String(m)));
function fillEndOptions() {
  const endSel = $("f-end");
  endSel.innerHTML = "";
  for (let m = state.sel.start + STEP; m <= END_MIN; m += STEP) endSel.add(new Option("ถึง " + fmt(m) + " น.", String(m)));
}
startSel.addEventListener("change", () => {
  const s = +startSel.value;
  setSel(state.sel.date, s, Math.min(END_MIN, s + (state.sel.end - state.sel.start)));
});
$("f-end").addEventListener("change", (e) => setSel(state.sel.date, state.sel.start, +e.target.value));
const countEl = $("f-count");
const clampCount = () => { countEl.value = String(Math.max(1, Math.min(20, parseInt(countEl.value, 10) || 1))); };
$("cMinus").onclick = () => { countEl.value = String((+countEl.value || 1) - 1); clampCount(); };
$("cPlus").onclick = () => { countEl.value = String((+countEl.value || 0) + 1); clampCount(); };
countEl.addEventListener("blur", clampCount);
$("f-name").addEventListener("input", renderSelection);

/* ---------- Gift picker ---------- */
const reservedSet = (exceptId) => new Set(state.slots.filter((v) => v.id !== exceptId).flatMap((v) => v.giftIds || []));
const picked = [];
function renderGiftPick() {
  const res = reservedSet(state.editing);
  const need = state.gifts.filter((g) => g.status === "need");
  // Drop picks that someone else just bought or the admin removed
  for (let i = picked.length - 1; i >= 0; i--) {
    if (res.has(picked[i]) || !need.some((g) => g.id === picked[i])) picked.splice(i, 1);
  }
  const open = need.filter((g) => !res.has(g.id) && !picked.includes(g.id));
  const sel = $("f-giftsel");
  sel.innerHTML = `<option value="">${open.length ? "เลือกของที่ยังขาด…" : need.length ? "ของที่ขาดมีคนซื้อครบแล้ว" : "ยังไม่มีรายการของที่ขาด"}</option>` +
    open.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.note ? " · " + esc(g.note) : ""}</option>`).join("");
  sel.disabled = !open.length;
  const byId = Object.fromEntries(need.map((g) => [g.id, g]));
  $("giftPicked").innerHTML = picked.map((id) =>
    `<span class="pick-chip">🎁 ${esc(byId[id].name)}<button type="button" data-unpick="${esc(id)}" aria-label="เอาออก">×</button></span>`).join("");
}
$("f-giftsel").addEventListener("change", (e) => {
  if (e.target.value) { picked.push(e.target.value); renderGiftPick(); }
});
$("giftPicked").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unpick]");
  if (b) { picked.splice(picked.indexOf(b.dataset.unpick), 1); renderGiftPick(); }
});

/* ---------- Gifts page ---------- */
function renderGifts() {
  const res = reservedSet();
  const need = state.gifts.filter((g) => g.status === "need" && !res.has(g.id));
  const have = state.gifts.filter((g) => g.status === "have");
  const giftById = Object.fromEntries(state.gifts.map((g) => [g.id, g]));
  const bought = [];
  state.slots.forEach((v) => {
    (v.giftIds || []).forEach((id) => { if (giftById[id]) bought.push({ name: giftById[id].name, slot: v }); });
    if (v.giftText) bought.push({ name: v.giftText, slot: v });
  });
  $("sNeed").textContent = need.length;
  $("sHave").textContent = have.length;
  $("sBought").textContent = bought.length;

  const acts = (g) => !state.isAdmin ? "" : `<span class="acts">
    ${g.status === "need" ? `<button class="iconbtn" title="ย้ายไปมีแล้ว" data-move="${esc(g.id)}" data-to="have">✓</button>` : `<button class="iconbtn" title="ย้ายกลับเป็นยังขาด" data-move="${esc(g.id)}" data-to="need">↺</button>`}
    <button class="iconbtn" data-del-gift="${esc(g.id)}">ลบ</button></span>`;
  const item = (g, done) => `<li class="gitem ${done ? "done" : ""}"><span class="box">${done ? "✓" : ""}</span>
    <span class="txt">${esc(g.name)}${g.note ? `<small>${esc(g.note)}</small>` : ""}</span>${acts(g)}</li>`;

  $("listNeed").innerHTML = need.length ? need.map((g) => item(g, false)).join("")
    : `<li class="empty">${state.gifts.length ? "ครบแล้ว ไม่มีของที่ยังขาด" : "ยังไม่มีรายการ คุณแม่จะเพิ่มเร็ว ๆ นี้"}</li>`;
  $("listHave").innerHTML = have.length ? have.map((g) => item(g, true)).join("") : `<li class="empty">ยังไม่มีรายการ</li>`;
  $("listBought").innerHTML = bought.length ? bought.map(({ name, slot }) => {
    const o = dateObj(slot.date);
    const by = state.isAdmin ? `จาก ${esc(state.names[slot.id] || "-")} · ` : "";
    return `<li class="gitem done"><span class="box">✓</span><span class="txt">${esc(name)}<small>${by}${TH_DOW[o.getDay()]} ${o.getDate()} ต.ค.</small></span></li>`;
  }).join("") : `<li class="empty">ยังไม่มีของเยี่ยมจากผู้ลงทะเบียน</li>`;
}

function renderMyBookings() {
  const mine = state.slots.filter(isMine).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const box = $("myBookings");
  box.hidden = !mine.length;
  if (!mine.length) return;
  const giftName = Object.fromEntries(state.gifts.map((g) => [g.id, g.name]));
  box.innerHTML = `<h3>การจองของคุณ (${mine.length})</h3>` + mine.map((v) => {
    const gifts = [...(v.giftIds || []).map((g) => giftName[g]).filter(Boolean), v.giftText].filter(Boolean).join(", ");
    return `<div class="mybook-item ${v.id === state.editing ? "editing" : ""}">
      <span class="when"><b>${dayLabel(v.date)}</b> ${fmt(v.start)}–${fmt(v.end)} น. · ${v.count} คน
        <small>${gifts ? "🎁 " + esc(gifts) : "ไม่ได้ระบุของเยี่ยม"}</small></span>
      <button class="btn ghost sm" type="button" data-edit="${esc(v.id)}">${v.id === state.editing ? "กำลังแก้ไข" : "แก้ไข"}</button>
    </div>`;
  }).join("");
}
$("myBookings").addEventListener("click", (e) => {
  const b = e.target.closest("[data-edit]");
  if (b) startEdit(b.dataset.edit);
});

function renderAll() {
  renderCalendarEvents(); renderGiftPick(); renderGifts(); renderMyBookings();
  // The booking being edited was cancelled elsewhere (another tab, or the admin)
  if (state.editing && !state.slots.some((v) => v.id === state.editing)) exitEdit();
  if (state.isAdmin) {
    const people = state.slots.reduce((s, v) => s + (v.count || 0), 0);
    $("adminStats").textContent = `ลงทะเบียน ${state.slots.length} รายการ · ${people} คน · กดที่ช่องในปฏิทินเพื่อดูรายละเอียด`;
  }
}

/* ---------- Messages ---------- */
const formMsg = $("formMsg");
function say(text, kind) { formMsg.textContent = text; formMsg.className = "msg " + kind; formMsg.hidden = false; }
function showNotice(t) { $("dbNotice").textContent = t; $("dbNotice").hidden = !t; }

/* ---------- Edit an existing booking (owner only) ---------- */
let fb = null; // { db } once Firebase has started
async function startEdit(id) {
  const v = state.slots.find((s) => s.id === id);
  if (!v || !canEdit(v) || !fb) return;
  state.editing = id;
  setSel(v.date, v.start, v.end);
  countEl.value = String(v.count || 1);
  picked.length = 0; picked.push(...(v.giftIds || []));
  $("f-gift").value = v.giftText || "";
  $("f-name").value = state.names[id] || "";
  $("formTitle").textContent = isMine(v) ? "แก้ไขการลงทะเบียน" : "แก้ไขการลงทะเบียน (Admin)";
  $("editBadge").hidden = false;
  $("editActs").hidden = false;
  $("submitBtn").textContent = "บันทึกการแก้ไข";
  $("cancelBookingBtn").textContent = "ยกเลิกการจองนี้"; $("cancelBookingBtn").dataset.confirm = "";
  formMsg.hidden = true;
  renderAll();
  $("formCard").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  try {
    const snap = await getDoc(doc(fb.db, "visits", id));
    if (state.editing === id && snap.exists()) { $("f-name").value = snap.data().name || ""; renderSelection(); }
  } catch (err) { /* name stays empty; the visitor can retype it */ }
}
function exitEdit() {
  state.editing = null;
  $("formTitle").textContent = "กรอกข้อมูลผู้เยี่ยม";
  $("editBadge").hidden = true;
  $("editActs").hidden = true;
  $("submitBtn").textContent = "ลงทะเบียน";
  $("f-name").value = ""; $("f-gift").value = ""; picked.length = 0; countEl.value = "1";
  renderAll(); renderSelection();
}
$("cancelEditBtn").addEventListener("click", () => { exitEdit(); formMsg.hidden = true; });

renderSelection();
renderGiftPick();
renderGifts();

/* ---------- Firebase ---------- */
if (!firebaseConfig || String(firebaseConfig.apiKey || "").startsWith("PASTE_")) {
  showNotice("ยังไม่ได้ตั้งค่า Firebase: ใส่ค่าใน firebase-config.js ตามขั้นตอนใน README");
  $("submitBtn").disabled = true;
} else {
  start();
}

function start() {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const onErr = () => showNotice("โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรชหน้า");

  onSnapshot(collection(db, "slots"), (snap) => {
    state.slots = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((v) => DAYS.includes(v.date) && typeof v.start === "number");
    renderAll();
  }, onErr);
  onSnapshot(collection(db, "gifts"), (snap) => {
    state.gifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    renderAll();
  }, onErr);

  fb = { db };

  /* Every visitor gets a silent anonymous uid (no login screen) so they can edit their own bookings.
     Admin: signed in with Google AND allowed by firestore.rules to read every visitor name. */
  let stopNames = null;
  let authReady;
  const authReadyP = new Promise((r) => (authReady = r));
  onAuthStateChanged(auth, (user) => {
    if (stopNames) { stopNames(); stopNames = null; }
    setAdmin(false);
    if (!user) { signInAnonymously(auth).catch(() => showNotice("เชื่อมต่อไม่สำเร็จ กรุณารีเฟรชหน้า")); return; }
    state.uid = user.uid;
    authReady();
    renderAll();
    if (user.isAnonymous) return;
    stopNames = onSnapshot(collection(db, "visits"), (snap) => {
      state.names = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().name]));
      if (!state.isAdmin) { setAdmin(true, user.email); showNotice(""); }
      renderAll();
    }, () => {
      showNotice(`บัญชี ${user.email} ไม่ได้เป็น Admin ของเว็บนี้`);
      signOut(auth);
    });
  });
  function setAdmin(on, email) {
    state.isAdmin = on;
    if (!on) state.names = {};
    document.body.classList.toggle("is-admin", on);
    $("adminBar").hidden = !on;
    $("adminPanel").hidden = !on;
    $("loginBtn").hidden = on;
    $("adminWho").textContent = email || "";
    renderAll();
  }
  $("loginBtn").addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (err) { if (err.code !== "auth/popup-closed-by-user") showNotice("เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง"); }
  });
  $("logoutBtn").addEventListener("click", () => signOut(auth));

  /* Booking details (admin) */
  const dlg = $("evtDialog");
  let openId = null;
  window.openBooking = (id) => {
    const v = state.slots.find((s) => s.id === id);
    if (!v) return;
    openId = id;
    const giftName = Object.fromEntries(state.gifts.map((g) => [g.id, g.name]));
    const gifts = [...(v.giftIds || []).map((g) => giftName[g]).filter(Boolean), v.giftText].filter(Boolean);
    $("dName").textContent = state.names[id] || "(ไม่มีชื่อ)";
    $("dWhen").textContent = `${dayLabel(v.date)} · ${fmt(v.start)}–${fmt(v.end)} น. · ${v.count} คน`;
    $("dGifts").textContent = gifts.length ? "🎁 " + gifts.join(", ") : "ไม่ได้ระบุของเยี่ยม";
    $("dDelete").textContent = "ลบรายการนี้"; $("dDelete").dataset.confirm = "";
    dlg.showModal();
  };
  $("dEdit").addEventListener("click", () => { const id = openId; dlg.close(); startEdit(id); });
  $("dDelete").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "กดอีกครั้งเพื่อยืนยัน"; return; }
    b.disabled = true;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "slots", openId));
      batch.delete(doc(db, "visits", openId));
      await batch.commit();
      dlg.close();
    } catch (err) { b.textContent = "ลบไม่สำเร็จ"; }
    finally { b.disabled = false; }
  });

  /* Gift admin */
  document.querySelector(".gifts").addEventListener("click", async (e) => {
    if (!state.isAdmin) return;
    const mv = e.target.closest("[data-move]");
    const del = e.target.closest("[data-del-gift]");
    try {
      if (mv) { mv.disabled = true; await updateDoc(doc(db, "gifts", mv.dataset.move), { status: mv.dataset.to }); }
      if (del) {
        if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = "ยืนยัน?"; setTimeout(() => { del.dataset.confirm = ""; del.textContent = "ลบ"; }, 3000); return; }
        del.disabled = true; await deleteDoc(doc(db, "gifts", del.dataset.delGift));
      }
    } catch (err) { showNotice("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"); }
  });
  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("a-name").value.trim();
    if (!name) return;
    try {
      await addDoc(collection(db, "gifts"), { name, note: $("a-note").value.trim(), status: $("a-status").value, createdAt: Date.now() });
      $("a-name").value = ""; $("a-note").value = ""; $("a-name").focus();
    } catch (err) { showNotice("เพิ่มรายการไม่สำเร็จ"); }
  });

  /* Cancel own booking (edit mode) */
  $("cancelBookingBtn").addEventListener("click", async (e) => {
    const b = e.currentTarget, id = state.editing;
    if (!id) return;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "กดอีกครั้งเพื่อยืนยันการยกเลิก"; return; }
    b.disabled = true;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "slots", id));
      batch.delete(doc(db, "visits", id));
      await batch.commit();
      exitEdit();
      say("ยกเลิกการจองแล้ว", "ok");
    } catch (err) { b.textContent = "ยกเลิกไม่สำเร็จ ลองใหม่"; b.dataset.confirm = ""; }
    finally { b.disabled = false; }
  });

  /* Registration: public slot + private name, written together; edit updates both */
  $("regForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("f-name").value.trim();
    clampCount();
    if (!name) { say("กรุณากรอกชื่อผู้เยี่ยม", "err"); $("f-name").focus(); return; }
    $("submitBtn").disabled = true;
    try {
      await authReadyP;
      const fields = {
        date: state.sel.date, start: state.sel.start, end: state.sel.end, count: +countEl.value,
        giftIds: [...picked], giftText: $("f-gift").value.trim(),
      };
      const batch = writeBatch(db);
      if (state.editing) {
        const id = state.editing;
        batch.update(doc(db, "slots", id), { ...fields, updatedAt: serverTimestamp() });
        batch.update(doc(db, "visits", id), { name, updatedAt: serverTimestamp() });
        await batch.commit();
        exitEdit();
        say(`บันทึกการแก้ไขแล้ว! แล้วพบกัน${dayLabel(fields.date)} เวลา ${fmt(fields.start)} น. 💕`, "ok");
      } else {
        const ref = doc(collection(db, "slots"));
        batch.set(ref, { ...fields, owner: state.uid, createdAt: serverTimestamp() });
        batch.set(doc(db, "visits", ref.id), { name, owner: state.uid, createdAt: serverTimestamp() });
        await batch.commit();
        say(`ลงทะเบียนแล้ว! แล้วพบกัน${dayLabel(fields.date)} เวลา ${fmt(fields.start)} น. 💕 แก้ไขได้ที่ "การจองของคุณ" ด้านบน`, "ok");
        $("f-gift").value = ""; picked.length = 0;
        renderAll();
      }
    } catch (err) {
      say(state.editing ? "บันทึกการแก้ไขไม่สำเร็จ ลองใหม่อีกครั้ง" : "ลงทะเบียนไม่สำเร็จ ลองใหม่อีกครั้ง", "err");
    } finally { $("submitBtn").disabled = false; }
  });
}
