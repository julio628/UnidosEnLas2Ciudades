/* =========================================================
   La Mesa Solidaria — app.js
   Funciona sin servidor (localStorage). Para que TODOS vean
   los mismos totales, activa Supabase abajo (ver README).
   ========================================================= */

/* ----------------------------------------------------------
   1) CONFIGURACIÓN — edita esto libremente
   ---------------------------------------------------------- */

// Centros iniciales. Puedes agregar, quitar o renombrar.
// Cada centro: { municipio, nombre }
const CENTROS_INICIALES = [
  { municipio: "Guatire",  nombre: "Hospital General de Guatire" },
  { municipio: "Guatire",  nombre: "Edificio Residencial Guatire Plaza" },
  { municipio: "Guatire",  nombre: "Las Barrancas" },
  { municipio: "Guatire",  nombre: "Edificio La Hacienda" },
  { municipio: "Guarenas", nombre: "Terrazas de Vicente Emilio Sojo" },
  { municipio: "Guarenas", nombre: "Oropeza Castillo" },
];

// Base de datos COMPARTIDA (opcional). Si dejas estos valores vacíos,
// la página guarda todo solo en este dispositivo (modo demo).
// Para activarla: crea un proyecto gratis en supabase.com y sigue el README.
const SUPABASE_URL = "";   // ej: "https://xxxx.supabase.co"
// Llave PÚBLICA del cliente. En proyectos nuevos es la "publishable key"
// (sb_publishable_...). En proyectos viejos también sirve la "anon key".
// Nunca pongas aquí la secret/service_role key: este archivo viaja al navegador.
const SUPABASE_KEY = "";   // ej: "sb_publishable_..."

/* ----------------------------------------------------------
   2) ESTADO
   ---------------------------------------------------------- */
const LS_CENTERS = "mesa.centros.v1";
const LS_DONS = "mesa.donaciones.v1";

let centers = [];      // [{ id, municipio, nombre, custom }]
let donations = [];    // [{ id, centerId, tipo, cantidad, fecha, donante, contacto, nota, createdAt }]
let useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
let supa = null;

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

/* ----------------------------------------------------------
   3) ALMACENAMIENTO (local o Supabase)
   ---------------------------------------------------------- */
const LocalStore = {
  loadCenters() {
    const raw = localStorage.getItem(LS_CENTERS);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    return CENTROS_INICIALES.map((c) => ({ id: uid(), ...c, custom: false }));
  },
  saveCenters() { localStorage.setItem(LS_CENTERS, JSON.stringify(centers)); },
  loadDonations() {
    const raw = localStorage.getItem(LS_DONS);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    return [];
  },
  saveDonations() { localStorage.setItem(LS_DONS, JSON.stringify(donations)); },
};

async function initSupabase() {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  supa = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Centros: si la tabla está vacía, sembramos los iniciales.
  let { data: cRows, error: cErr } = await supa.from("centros").select("*").order("municipio");
  if (cErr) throw cErr;
  if (!cRows || cRows.length === 0) {
    const seed = CENTROS_INICIALES.map((c) => ({ municipio: c.municipio, nombre: c.nombre, custom: false }));
    const { data: ins, error } = await supa.from("centros").insert(seed).select("*");
    if (error) throw error;
    cRows = ins;
  }
  centers = cRows.map((r) => ({ id: r.id, municipio: r.municipio, nombre: r.nombre, custom: r.custom }));

  const { data: dRows, error: dErr } = await supa.from("donaciones").select("*").order("created_at", { ascending: false });
  if (dErr) throw dErr;
  donations = (dRows || []).map(fromRow);

  subscribeRealtime();
}

// Actualización en vivo: cuando alguien registra o borra algo, todos los
// navegadores abiertos vuelven a leer las tablas y se refrescan solos.
let realtimeTimer;
function subscribeRealtime() {
  if (!supa) return;
  supa
    .channel("mesa-cambios")
    .on("postgres_changes", { event: "*", schema: "public", table: "donaciones" }, refreshFromDb)
    .on("postgres_changes", { event: "*", schema: "public", table: "centros" }, refreshFromDb)
    .subscribe();
}
async function refreshFromDb() {
  clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(async () => {
    try {
      const [{ data: c }, { data: d }] = await Promise.all([
        supa.from("centros").select("*").order("municipio"),
        supa.from("donaciones").select("*").order("created_at", { ascending: false }),
      ]);
      if (c) centers = c.map((r) => ({ id: r.id, municipio: r.municipio, nombre: r.nombre, custom: r.custom }));
      if (d) donations = d.map(fromRow);
      renderAll();
    } catch (e) { console.error("Refresh realtime falló:", e); }
  }, 250);
}

const fromRow = (r) => ({
  id: r.id, centerId: r.center_id, tipo: r.tipo, cantidad: r.cantidad,
  fecha: r.fecha, donante: r.donante, contacto: r.contacto || "",
  nota: r.nota || "", createdAt: r.created_at,
});
const toRow = (d) => ({
  id: d.id, center_id: d.centerId, tipo: d.tipo, cantidad: d.cantidad,
  fecha: d.fecha, donante: d.donante, contacto: d.contacto, nota: d.nota,
});

/* ----------------------------------------------------------
   4) ACCIONES DE DATOS
   ---------------------------------------------------------- */
async function addDonation(d) {
  donations.unshift(d);
  if (useSupabase) {
    const { error } = await supa.from("donaciones").insert(toRow(d));
    if (error) { donations.shift(); throw error; }
  } else {
    LocalStore.saveDonations();
  }
}

async function removeDonation(id) {
  if (useSupabase) {
    const { error } = await supa.from("donaciones").delete().eq("id", id);
    if (error) throw error;
    donations = donations.filter((x) => x.id !== id);
  } else {
    donations = donations.filter((x) => x.id !== id);
    LocalStore.saveDonations();
  }
}

async function addCenter(municipio, nombre) {
  const exists = centers.some(
    (c) => c.municipio.toLowerCase() === municipio.toLowerCase() &&
           c.nombre.toLowerCase() === nombre.toLowerCase()
  );
  if (exists) return null;
  const c = { id: uid(), municipio, nombre, custom: true };
  centers.push(c);
  if (useSupabase) {
    const { data, error } = await supa.from("centros")
      .insert({ municipio, nombre, custom: true }).select("*").single();
    if (error) { centers.pop(); throw error; }
    c.id = data.id;
  } else {
    LocalStore.saveCenters();
  }
  return c;
}

async function removeCenter(id) {
  const hasDons = donations.some((d) => d.centerId === id);
  if (hasDons) { toast("No puedes quitar un centro con aportes registrados."); return; }
  try {
    if (useSupabase) {
      const { error } = await supa.from("centros").delete().eq("id", id);
      if (error) throw error;
    }
    centers = centers.filter((c) => c.id !== id);
    if (!useSupabase) LocalStore.saveCenters();
    renderAll();
  } catch (e) {
    console.error(e);
    toast("No se pudo quitar el centro (revisa permisos en Supabase).");
  }
}

/* ----------------------------------------------------------
   5) CÁLCULOS
   ---------------------------------------------------------- */
function totalsFor(centerId) {
  let lunch = 0, dinner = 0;
  for (const d of donations) {
    if (d.centerId !== centerId) continue;
    if (d.tipo === "almuerzo") lunch += d.cantidad;
    else dinner += d.cantidad;
  }
  return { lunch, dinner, total: lunch + dinner };
}

function grandTotals() {
  let lunch = 0, dinner = 0;
  for (const d of donations) {
    if (d.tipo === "almuerzo") lunch += d.cantidad;
    else dinner += d.cantidad;
  }
  return { lunch, dinner, total: lunch + dinner, donors: donations.length };
}

/* ----------------------------------------------------------
   6) RENDER
   ---------------------------------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function renderHero() {
  const g = grandTotals();
  animateNumber($("[data-total-meals]"), g.total);
  $("[data-total-lunch]").textContent = g.lunch;
  $("[data-total-dinner]").textContent = g.dinner;
  $("[data-total-donors]").textContent = g.donors;

  const note = $("#storage-note");
  if (useSupabase) {
    note.hidden = false;
    note.innerHTML = "🟢 Base compartida activa: todos ven los mismos totales en tiempo real.";
  } else {
    note.hidden = false;
    note.innerHTML = "ℹ️ Modo local: los aportes se guardan solo en este dispositivo. Activa la base compartida para coordinar a varias personas (ver README).";
  }
}

function renderBoard() {
  const root = $("#municipios");
  root.innerHTML = "";
  const tpl = $("#center-card-tpl");

  const byMuni = {};
  for (const c of centers) (byMuni[c.municipio] ||= []).push(c);

  const order = Object.keys(byMuni).sort();
  for (const muni of order) {
    const section = document.createElement("section");
    section.className = "municipio";

    const head = document.createElement("div");
    head.className = "municipio-head";
    const muniTotal = byMuni[muni].reduce((s, c) => s + totalsFor(c.id).total, 0);
    head.innerHTML = `<h2>${escapeHtml(muni)}</h2>
      <span class="count">${byMuni[muni].length} centros · ${muniTotal} raciones</span>`;
    section.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "center-grid";

    for (const c of byMuni[muni]) {
      const card = tpl.content.cloneNode(true);
      const t = totalsFor(c.id);
      $(".cc-name", card).textContent = c.nombre;
      $(".cc-num", card).textContent = t.total;
      $(".cc-lunch", card).textContent = t.lunch;
      $(".cc-dinner", card).textContent = t.dinner;

      const denom = Math.max(t.total, 1);
      $(".cc-bar-lunch", card).style.width = (t.lunch / denom) * 100 + "%";
      $(".cc-bar-dinner", card).style.width = (t.dinner / denom) * 100 + "%";

      const article = $(".center-card", card);
      if (t.total === 0) article.classList.add("is-empty");

      $(".cc-donate", card).addEventListener("click", () => openForm(c.id));

      const rm = $(".cc-remove", card);
      if (c.custom) {
        rm.hidden = false;
        rm.addEventListener("click", () => {
          if (confirm(`¿Quitar el centro "${c.nombre}"?`)) removeCenter(c.id);
        });
      }
      grid.appendChild(card);
    }
    section.appendChild(grid);
    root.appendChild(section);
  }
}

function renderLedger() {
  const filterSel = $("#ledger-filter");
  const current = filterSel.value || "all";
  filterSel.innerHTML =
    `<option value="all">Todos los centros</option>` +
    centers
      .slice()
      .sort((a, b) => (a.municipio + a.nombre).localeCompare(b.municipio + b.nombre))
      .map((c) => `<option value="${c.id}">${escapeHtml(c.municipio)} — ${escapeHtml(c.nombre)}</option>`)
      .join("");
  filterSel.value = centers.some((c) => c.id === current) ? current : "all";

  const rows = donations.filter((d) => filterSel.value === "all" || d.centerId === filterSel.value);
  const body = $("#ledger-body");
  $("[data-export]").hidden = donations.length === 0;

  if (rows.length === 0) {
    body.innerHTML = `<div class="empty-state">
      <strong>Aún no hay aportes${filterSel.value !== "all" ? " para este centro" : ""}.</strong>
      Toca “Donar comidas” en cualquier centro para registrar el primero.
    </div>`;
    return;
  }

  const centerName = (id) => {
    const c = centers.find((x) => x.id === id);
    return c ? `${c.nombre}` : "—";
  };

  body.innerHTML = `<table class="ledger-table">
    <thead><tr>
      <th>Centro</th><th>Comida</th><th>Cant.</th><th>Fecha</th><th>Quién</th><th></th>
    </tr></thead>
    <tbody>
      ${rows.map((d) => `<tr>
        <td data-label="Centro">${escapeHtml(centerName(d.centerId))}</td>
        <td data-label="Comida"><span class="tag tag-${d.tipo === "almuerzo" ? "lunch" : "dinner"}">${d.tipo === "almuerzo" ? "Almuerzo" : "Cena"}</span></td>
        <td data-label="Cantidad" class="qty">${d.cantidad}</td>
        <td data-label="Fecha">${fmtDate(d.fecha)}</td>
        <td data-label="Quién">${escapeHtml(d.donante)}${d.contacto ? `<br><span class="muted">${escapeHtml(d.contacto)}</span>` : ""}${d.nota ? `<br><span class="muted">${escapeHtml(d.nota)}</span>` : ""}</td>
        <td data-label=""><button class="icon-btn row-del" data-del="${d.id}" aria-label="Eliminar aporte">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button></td>
      </tr>`).join("")}
    </tbody>
  </table>`;

  $$("[data-del]", body).forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este aporte?")) return;
      try {
        await removeDonation(btn.dataset.del);
        renderAll();
        toast("Aporte eliminado.");
      } catch (e) {
        console.error(e);
        toast("No se pudo eliminar (revisa permisos de borrado en Supabase).");
      }
    })
  );
}

function renderAll() {
  renderHero();
  renderBoard();
  renderLedger();
}

/* ----------------------------------------------------------
   7) FORMULARIO (panel lateral)
   ---------------------------------------------------------- */
const sheet = $("#donation-sheet");
const backdrop = $("#sheet-backdrop");
const form = $("#donation-form");
let lastFocused = null;

function fillCenterSelect() {
  const sel = $("#f-center");
  sel.innerHTML =
    `<option value="" selected disabled>— Elige un centro —</option>` +
    centers
      .slice()
      .sort((a, b) => (a.municipio + a.nombre).localeCompare(b.municipio + b.nombre))
      .map((c) => `<option value="${c.id}">${escapeHtml(c.municipio)} — ${escapeHtml(c.nombre)}</option>`)
      .join("");
}

function openForm(centerId) {
  lastFocused = document.activeElement;
  fillCenterSelect();
  const banner = $("#chosen-center");
  const field = $("#center-field");
  if (centerId) {
    $("#f-center").value = centerId;
    const c = centers.find((x) => x.id === centerId);
    $("#chosen-center-name").textContent = c ? `${c.municipio} — ${c.nombre}` : "";
    banner.hidden = false;
    field.hidden = true;
  } else {
    banner.hidden = true;
    field.hidden = false;
  }
  if (!$("#f-fecha").value) $("#f-fecha").value = todayISO();
  $("#form-error").hidden = true;
  backdrop.hidden = false;
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#f-cantidad").focus(), 60);
}

function closeForm() {
  sheet.hidden = true;
  backdrop.hidden = true;
  document.body.style.overflow = "";
  if (lastFocused) lastFocused.focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const cantidad = parseInt(fd.get("cantidad"), 10);
  const centerId = fd.get("center");
  const donante = (fd.get("donante") || "").toString().trim();

  const err = $("#form-error");
  if (!centerId) return showFormError("Elige un centro de acopio.");
  if (!Number.isFinite(cantidad) || cantidad < 1) return showFormError("Indica una cantidad de raciones válida (mínimo 1).");
  if (!donante) return showFormError("Escribe tu nombre o el de tu grupo.");
  if (!fd.get("fecha")) return showFormError("Selecciona la fecha de entrega.");

  const d = {
    id: uid(),
    centerId,
    tipo: fd.get("tipo"),
    cantidad,
    fecha: fd.get("fecha"),
    donante,
    contacto: (fd.get("contacto") || "").toString().trim(),
    nota: (fd.get("nota") || "").toString().trim(),
    createdAt: new Date().toISOString(),
  };

  const submitBtn = $(".btn-primary", form);
  submitBtn.disabled = true; submitBtn.textContent = "Guardando…";
  try {
    await addDonation(d);
    const c = centers.find((x) => x.id === centerId);
    closeForm();
    form.reset();
    renderAll();
    toast(`¡Gracias! ${d.cantidad} ${d.tipo === "almuerzo" ? "almuerzos" : "cenas"} para ${c ? c.nombre : "el centro"}.`);
  } catch (e2) {
    showFormError("No se pudo guardar. Revisa la conexión e inténtalo de nuevo.");
    console.error(e2);
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = "Confirmar comidas";
  }
});

function showFormError(msg) {
  const err = $("#form-error");
  err.textContent = msg; err.hidden = false;
}

/* ----------------------------------------------------------
   8) AGREGAR CENTRO
   ---------------------------------------------------------- */
$("[data-add-center]").addEventListener("click", async () => {
  const municipios = [...new Set(centers.map((c) => c.municipio))];
  const muni = (prompt(`Municipio o sector:\n(Existentes: ${municipios.join(", ")})`, municipios[0] || "") || "").trim();
  if (!muni) return;
  const nombre = (prompt("Nombre del centro de acopio:") || "").trim();
  if (!nombre) return;
  try {
    const c = await addCenter(muni, nombre);
    if (!c) { toast("Ese centro ya existe."); return; }
    renderAll();
    toast(`Centro agregado: ${nombre}.`);
  } catch (e) {
    toast("No se pudo agregar el centro.");
    console.error(e);
  }
});

/* ----------------------------------------------------------
   9) EXPORTAR CSV
   ---------------------------------------------------------- */
$("[data-export]").addEventListener("click", () => {
  const head = ["Municipio", "Centro", "Comida", "Cantidad", "Fecha de entrega", "Donante", "Contacto", "Nota", "Registrado"];
  const lines = [head];
  for (const d of donations) {
    const c = centers.find((x) => x.id === d.centerId) || {};
    lines.push([
      c.municipio || "", c.nombre || "",
      d.tipo === "almuerzo" ? "Almuerzo" : "Cena",
      d.cantidad, d.fecha, d.donante, d.contacto, d.nota,
      d.createdAt,
    ]);
  }
  const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `mesa-solidaria-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ----------------------------------------------------------
   10) UTILIDADES
   ---------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function animateNumber(el, to) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to; return; }
  const dur = 500, t0 = performance.now();
  const tick = (t) => {
    const p = Math.min((t - t0) / dur, 1);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 300);
  }, 3200);
}

/* ----------------------------------------------------------
   11) EVENTOS GLOBALES + INICIO
   ---------------------------------------------------------- */
$$("[data-open-form]").forEach((b) => b.addEventListener("click", () => openForm()));
$$("[data-close-form]").forEach((b) => b.addEventListener("click", closeForm));
$("#change-center").addEventListener("click", () => {
  $("#chosen-center").hidden = true;
  $("#center-field").hidden = false;
  $("#f-center").focus();
});
backdrop.addEventListener("click", closeForm);
$("#ledger-filter").addEventListener("change", renderLedger);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeForm(); });

async function init() {
  try {
    if (useSupabase) {
      await initSupabase();
    } else {
      centers = LocalStore.loadCenters();
      donations = LocalStore.loadDonations();
      LocalStore.saveCenters();
    }
  } catch (e) {
    console.error("Fallo al iniciar la base compartida, usando modo local:", e);
    useSupabase = false;
    centers = LocalStore.loadCenters();
    donations = LocalStore.loadDonations();
  }
  $("#f-fecha").value = todayISO();
  renderAll();
}

init();
