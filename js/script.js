const FIREBASE_URL = "https://conteo-feria-84505-default-rtdb.europe-west1.firebasedatabase.app/";
const FIREBASE_NODE = "aforo";
const SYNC_MS = 3000;

const DB_PATH = "data/db.json";
const STORAGE_KEY = "aforoDB_v2_feria";

const DEFAULT_DB = {
    personasDentro: 0,
    totalEntradas: 0,
    totalSalidas: 0,
    maximoHistorico: 0,
    ultimaActualizacion: new Date().toISOString(),
    movimientos: [],
    dias: {}
};

let db = structuredClone(DEFAULT_DB);
let modoCompartido = FIREBASE_URL.trim() !== "";
let sincronizando = false;
let timerSync = null;

const counter = document.getElementById("peopleCounter");
const entryButton = document.getElementById("entryButton");
const exitButton = document.getElementById("exitButton");
const statisticsButton = document.getElementById("statisticsButton");
const dbStatus = document.getElementById("dbStatus");
const shiftBadge = document.getElementById("shiftBadge");

const statsModal = document.getElementById("statsModal");
const closeModal = document.getElementById("closeModal");
const exportButton = document.getElementById("exportButton");
const importButton = document.getElementById("importButton");
const importFile = document.getElementById("importFile");

function turnoDe(fecha) {
    const h = new Date(fecha).getHours();
    if (h >= 1 && h < 12) return "matutino";
    if (h >= 12 && h < 13) return "descanso";
    return "vespertino";
}

function turnoActual() {
    return turnoDe(new Date());
}

function nombreTurno(t) {
    if (t === "matutino") return "Matutino 1:00–11:59";
    if (t === "descanso") return "Descanso 12:00–12:59";
    return "Vespertino 13:00–00:00";
}

function actualizarTurno() {
    if (!shiftBadge) return;
    const t = turnoActual();
    shiftBadge.textContent = "Turno actual: " + nombreTurno(t);
    shiftBadge.classList.remove("matutino", "descanso", "vespertino");
    shiftBadge.classList.add(t);
}

function diasEvento() {
    const nombres = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    const salida = [];
    for (let i = -1; i <= 1; i++) {
        const f = new Date();
        f.setHours(0, 0, 0, 0);
        f.setDate(f.getDate() + i);
        let titulo = nombres[f.getDay()];
        titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
        if (i === -1) titulo = "Ayer";
        if (i === 0) titulo = "Hoy";
        if (i === 1) titulo = "Mañana";
        titulo += " · " + f.getDate() + " " + meses[f.getMonth()];
        salida.push({ fecha: f, titulo: titulo, esHoy: i === 0 });
    }
    return salida;
}

function resumenDia(dia) {
    const g = db.dias && db.dias[claveDia(dia)];
    if (g) {
        return {
            matutino: { entradas: (g.matutino && g.matutino.entradas) || 0, salidas: (g.matutino && g.matutino.salidas) || 0 },
            vespertino: { entradas: (g.vespertino && g.vespertino.entradas) || 0, salidas: (g.vespertino && g.vespertino.salidas) || 0 }
        };
    }
    const marca = dia.toDateString();
    const r = { matutino: { entradas: 0, salidas: 0 }, vespertino: { entradas: 0, salidas: 0 } };
    db.movimientos.forEach(function (m) {
        if (new Date(m.fecha).toDateString() !== marca) return;
        const t = m.turno || turnoDe(m.fecha);
        if (t !== "matutino" && t !== "vespertino") return;
        if (m.tipo === "entrada") r[t].entradas++;
        if (m.tipo === "salida") r[t].salidas++;
    });
    return r;
}

function esDBValida(d) {
    return (
        d &&
        typeof d === "object" &&
        Number.isInteger(d.personasDentro) && d.personasDentro >= 0 &&
        Number.isInteger(d.totalEntradas) && d.totalEntradas >= 0 &&
        Number.isInteger(d.totalSalidas) && d.totalSalidas >= 0 &&
        Number.isInteger(d.maximoHistorico) && d.maximoHistorico >= 0 &&
        Array.isArray(d.movimientos)
    );
}

function desdeFirebase(json) {
    if (!json || typeof json !== "object") return null;
    const copia = Object.assign({}, json);
    if (copia.movimientos && !Array.isArray(copia.movimientos)) {
        copia.movimientos = Object.values(copia.movimientos);
    }
    if (!Array.isArray(copia.movimientos)) copia.movimientos = [];
    if (!copia.dias || typeof copia.dias !== "object" || Array.isArray(copia.dias)) copia.dias = {};
    ["personasDentro", "totalEntradas", "totalSalidas", "maximoHistorico"].forEach(function (k) {
        copia[k] = Number.isInteger(copia[k]) ? copia[k] : (DEFAULT_DB[k] || 0);
    });
    delete copia.aforoMaximo;
    return copia;
}

function normalizarDB(d) {
    const base = structuredClone(DEFAULT_DB);
    const mezclada = Object.assign(base, d);
    delete mezclada.aforoMaximo;
    if (!mezclada.dias || typeof mezclada.dias !== "object" || Array.isArray(mezclada.dias)) mezclada.dias = {};
    if (!Array.isArray(mezclada.movimientos)) mezclada.movimientos = [];
    if (mezclada.movimientos.length > 500) {
        mezclada.movimientos = mezclada.movimientos.slice(-500);
    }
    return mezclada;
}

function setStatus(mensaje, tipo) {
    if (!dbStatus) return;
    dbStatus.textContent = mensaje;
    dbStatus.classList.remove("ok", "warn", "error");
    if (tipo) dbStatus.classList.add(tipo);
}

function fbBase() {
    return FIREBASE_URL.replace(/\/$/, "") + "/" + FIREBASE_NODE;
}

async function fbGet() {
    const r = await fetch(fbBase() + ".json", { cache: "no-store" });
    if (!r.ok) throw new Error("Firebase GET " + r.status);
    return await r.json();
}

async function fbPatch(obj) {
    const r = await fetch(fbBase() + ".json", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obj)
    });
    if (!r.ok) throw new Error("Firebase PATCH " + r.status);
    return await r.json();
}

async function fbPut(obj) {
    const r = await fetch(fbBase() + ".json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obj)
    });
    if (!r.ok) throw new Error("Firebase PUT " + r.status);
    return await r.json();
}

async function fbPostMovimiento(mov) {
    const r = await fetch(fbBase() + "/movimientos.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mov)
    });
    if (!r.ok) throw new Error("Firebase POST " + r.status);
    return await r.json();
}

function claveDia(fecha) {
    const f = new Date(fecha);
    const m = String(f.getMonth() + 1).padStart(2, "0");
    const d = String(f.getDate()).padStart(2, "0");
    return f.getFullYear() + "-" + m + "-" + d;
}

function diasVacios() {
    return { matutino: { entradas: 0, salidas: 0 }, vespertino: { entradas: 0, salidas: 0 }, descanso: { entradas: 0, salidas: 0 } };
}

function bumpDiaLocal(t, campo) {
    const k = claveDia(new Date());
    if (!db.dias || typeof db.dias !== "object") db.dias = {};
    if (!db.dias[k]) db.dias[k] = diasVacios();
    db.dias[k][t][campo]++;
}

async function fbSumarDia(k, t, campo) {
    const cuerpo = {};
    cuerpo[campo] = { ".sv": { increment: 1 } };
    const r = await fetch(fbBase() + "/dias/" + k + "/" + t + ".json", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo)
    });
    if (!r.ok) throw new Error("Firebase PATCH dias " + r.status);
    return await r.json();
}

async function migrarDias(lista) {
    const dias = {};
    lista.forEach(function (m) {
        const k = claveDia(m.fecha);
        const t = m.turno || turnoDe(m.fecha);
        if (t !== "matutino" && t !== "vespertino" && t !== "descanso") return;
        if (!dias[k]) dias[k] = diasVacios();
        if (m.tipo === "entrada") dias[k][t].entradas++;
        if (m.tipo === "salida") dias[k][t].salidas++;
    });
    const r = await fetch(fbBase() + "/dias.json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dias)
    });
    if (!r.ok) throw new Error("Firebase PUT dias " + r.status);
    return dias;
}

async function cargarDB() {
    if (modoCompartido) {
        await refrescarCompartido(true);
        iniciarSincronizacion();
        return;
    }
    try {
        const guardada = localStorage.getItem(STORAGE_KEY);
        if (guardada) {
            const parsed = JSON.parse(guardada);
            if (esDBValida(parsed)) {
                db = normalizarDB(parsed);
                setStatus("Modo local: base de datos cargada.", "ok");
                actualizarContador(false);
                return;
            }
        }
    } catch (e) {
        console.warn("localStorage ilegible:", e);
    }
    try {
        const resp = await fetch(DB_PATH, { cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const json = await resp.json();
        if (!esDBValida(json)) throw new Error("Estructura inválida en db.json");
        db = normalizarDB(json);
        guardarLocal(true);
        setStatus("Modo local: cargada desde data/db.json.", "ok");
    } catch (e) {
        console.warn("No se pudo leer " + DB_PATH + ":", e);
        db = structuredClone(DEFAULT_DB);
        guardarLocal(true);
        setStatus("Modo local: valores iniciales.", "warn");
    }
    actualizarContador(false);
}

async function refrescarCompartido(esInicio) {
    try {
        const raw = await fbGet();
        if (raw === null) {
            await fbPut(Object.assign({}, DEFAULT_DB, { ultimaActualizacion: new Date().toISOString() }));
            db = structuredClone(DEFAULT_DB);
        } else {
            const conv = desdeFirebase(raw);
            if (!esDBValida(conv)) throw new Error("Datos remotos inválidos");
            if (!raw.dias && raw.movimientos) {
                try {
                    const full = Array.isArray(raw.movimientos) ? raw.movimientos : Object.values(raw.movimientos);
                    conv.dias = await migrarDias(full);
                } catch (e) {}
            }
            db = normalizarDB(conv);
        }
        guardarLocal(true);
        actualizarContador(esInicio ? false : true);
        if (!sincronizando) setStatus("● Compartido: conectado, sincronizado.", "ok");
    } catch (e) {
        console.warn("Fallo sync Firebase:", e);
        try {
            const guardada = localStorage.getItem(STORAGE_KEY);
            if (guardada) {
                const parsed = JSON.parse(guardada);
                if (esDBValida(parsed)) db = normalizarDB(parsed);
            }
        } catch (e2) {}
        actualizarContador(false);
        setStatus("● Compartido: sin conexión, mostrando última copia.", "error");
    }
}

function iniciarSincronizacion() {
    if (timerSync) clearInterval(timerSync);
    timerSync = setInterval(function () {
        if (!sincronizando && !document.hidden) refrescarCompartido(false);
    }, SYNC_MS);
}

function guardarLocal(silencioso) {
    db.ultimaActualizacion = db.ultimaActualizacion || new Date().toISOString();
    if (db.personasDentro > db.maximoHistorico) db.maximoHistorico = db.personasDentro;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        if (!silencioso && !modoCompartido) setStatus("Guardado en base de datos local ✓", "ok");
    } catch (e) {}
}

function actualizarContador(animar) {
    if (animar === undefined) animar = true;
    counter.textContent = db.personasDentro;
    if (animar) {
        counter.classList.remove("change");
        void counter.offsetWidth;
        counter.classList.add("change");
    }
    actualizarTurno();
    entryButton.disabled = sincronizando;
    exitButton.disabled = sincronizando;
    entryButton.classList.remove("disabled");
    entryButton.title = "Registrar entrada";
}

function bloquearBotones(bloquear) {
    sincronizando = bloquear;
    actualizarContador(false);
}

async function registrarEntrada() {
    if (modoCompartido) {
        bloquearBotones(true);
        setStatus("● Compartido: enviando entrada...", "warn");
        try {
            await fbPatch({
                personasDentro: { ".sv": { increment: 1 } },
                totalEntradas: { ".sv": { increment: 1 } },
                ultimaActualizacion: new Date().toISOString()
            });
            await fbSumarDia(claveDia(new Date()), turnoActual(), "entradas");
            await refrescarCompartido(false);
            if (db.personasDentro > db.maximoHistorico) {
                await fbPatch({ maximoHistorico: db.personasDentro });
                db.maximoHistorico = db.personasDentro;
            }
            await fbPostMovimiento({
                tipo: "entrada",
                fecha: new Date().toISOString(),
                totalDentro: db.personasDentro,
                turno: turnoActual()
            });
            setStatus("● Compartido: conectado, sincronizado.", "ok");
        } catch (e) {
            alert("Sin conexión con la base compartida. Inténtalo de nuevo.");
            setStatus("● Compartido: sin conexión.", "error");
        }
        bloquearBotones(false);
        await refrescarCompartido(false);
        return;
    }
    db.personasDentro++;
    db.totalEntradas++;
    db.movimientos.push({ tipo: "entrada", fecha: new Date().toISOString(), totalDentro: db.personasDentro, turno: turnoActual() });
    bumpDiaLocal(turnoActual(), "entradas");
    db.ultimaActualizacion = new Date().toISOString();
    guardarLocal();
    actualizarContador();
}

async function registrarSalida() {
    if (modoCompartido) {
        if (db.personasDentro <= 0) {
            alert("No hay personas dentro para registrar una salida.");
            return;
        }
        bloquearBotones(true);
        setStatus("● Compartido: enviando salida...", "warn");
        try {
            await fbPatch({
                personasDentro: { ".sv": { increment: -1 } },
                totalSalidas: { ".sv": { increment: 1 } },
                ultimaActualizacion: new Date().toISOString()
            });
            await fbSumarDia(claveDia(new Date()), turnoActual(), "salidas");
            await refrescarCompartido(false);
            if (db.personasDentro < 0) {
                await fbPatch({ personasDentro: 0 });
                db.personasDentro = 0;
            }
            await fbPostMovimiento({
                tipo: "salida",
                fecha: new Date().toISOString(),
                totalDentro: db.personasDentro,
                turno: turnoActual()
            });
            setStatus("● Compartido: conectado, sincronizado.", "ok");
        } catch (e) {
            alert("Sin conexión con la base compartida. Inténtalo de nuevo.");
            setStatus("● Compartido: sin conexión.", "error");
        }
        bloquearBotones(false);
        await refrescarCompartido(false);
        return;
    }
    if (db.personasDentro <= 0) {
        alert("No hay personas dentro para registrar una salida.");
        return;
    }
    db.personasDentro--;
    db.totalSalidas++;
    db.movimientos.push({ tipo: "salida", fecha: new Date().toISOString(), totalDentro: db.personasDentro, turno: turnoActual() });
    bumpDiaLocal(turnoActual(), "salidas");
    db.ultimaActualizacion = new Date().toISOString();
    guardarLocal();
    actualizarContador();
}

function movimientosDeHoy() {
    const g = db.dias && db.dias[claveDia(new Date())];
    if (g) {
        let n = 0;
        ["matutino", "vespertino", "descanso"].forEach(function (t) {
            if (g[t]) n += (g[t].entradas || 0) + (g[t].salidas || 0);
        });
        return n;
    }
    const hoy = new Date().toDateString();
    return db.movimientos.filter(function (m) {
        return new Date(m.fecha).toDateString() === hoy;
    }).length;
}

function formatearFecha(iso) {
    try {
        return new Date(iso).toLocaleString("es-ES", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        });
    } catch (e) {
        return iso || "—";
    }
}

function etiquetaTurno(m) {
    const t = m.turno || turnoDe(m.fecha);
    if (t === "matutino") return "MAT";
    if (t === "descanso") return "DES";
    return "VES";
}

function rellenarEstadisticas() {
    document.getElementById("statDentro").textContent = db.personasDentro;
    document.getElementById("statEntradas").textContent = db.totalEntradas;
    document.getElementById("statSalidas").textContent = db.totalSalidas;
    document.getElementById("statMaximo").textContent = db.maximoHistorico;
    document.getElementById("statHoy").textContent = movimientosDeHoy();
    document.getElementById("statFecha").textContent = formatearFecha(db.ultimaActualizacion);
    const grid = document.getElementById("daysGrid");
    grid.innerHTML = "";
    diasEvento().forEach(function (dia) {
        const c = resumenDia(dia.fecha);
        const card = document.createElement("div");
        card.className = "day-card";
        if (dia.esHoy) card.classList.add("today");
        card.innerHTML =
            "<span class='day-title'>" + dia.titulo + "</span>" +
            "<span class='day-row'>Mañana: <b>" + c.matutino.entradas + "</b> ent · <b>" + c.matutino.salidas + "</b> sal</span>" +
            "<span class='day-row'>Tarde: <b>" + c.vespertino.entradas + "</b> ent · <b>" + c.vespertino.salidas + "</b> sal</span>";
        grid.appendChild(card);
    });
    const lista = document.getElementById("historyList");
    lista.innerHTML = "";
    const ultimos = db.movimientos.slice(-10).reverse();
    if (ultimos.length === 0) {
        const li = document.createElement("li");
        li.className = "history-empty";
        li.textContent = "Sin movimientos registrados todavía.";
        lista.appendChild(li);
        return;
    }
    ultimos.forEach(function (m) {
        const li = document.createElement("li");
        li.className = "history-item " + (m.tipo === "entrada" ? "in" : "out");
        const icono = m.tipo === "entrada" ? "↑ ENTRADA" : "↓ SALIDA";
        li.innerHTML =
            "<span class='history-type'>" + icono + "</span>" +
            "<span class='history-shift'>" + etiquetaTurno(m) + "</span>" +
            "<span class='history-date'>" + formatearFecha(m.fecha) + "</span>" +
            "<span class='history-total'>" + m.totalDentro + " dentro</span>";
        lista.appendChild(li);
    });
}

function abrirModal() {
    rellenarEstadisticas();
    statsModal.classList.add("open");
    statsModal.setAttribute("aria-hidden", "false");
}

function cerrarModal() {
    statsModal.classList.remove("open");
    statsModal.setAttribute("aria-hidden", "true");
}

function exportarJSON() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "db.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function importarJSON(archivo) {
    const lector = new FileReader();
    lector.onload = async function () {
        try {
            const parsed = JSON.parse(lector.result);
            if (!esDBValida(parsed)) throw new Error("estructura inválida");
            if (modoCompartido) {
                if (!confirm("Esto SOBREESCRIBIRÁ el contador compartido para TODOS. ¿Continuar?")) return;
                await fbPut(normalizarDB(parsed));
                await refrescarCompartido(false);
            } else {
                db = normalizarDB(parsed);
                db.ultimaActualizacion = new Date().toISOString();
                guardarLocal();
                actualizarContador();
            }
            rellenarEstadisticas();
            setStatus(modoCompartido ? "● Compartido: importado para todos." : "Base de datos importada.", "ok");
        } catch (e) {
            alert("El archivo seleccionado no es un db.json válido.");
        }
    };
    lector.readAsText(archivo);
}

entryButton.addEventListener("click", registrarEntrada);
exitButton.addEventListener("click", registrarSalida);
statisticsButton.addEventListener("click", abrirModal);
closeModal.addEventListener("click", cerrarModal);
statsModal.addEventListener("click", function (e) {
    if (e.target === statsModal) cerrarModal();
});
document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") cerrarModal();
    if (!statsModal.classList.contains("open") && !sincronizando) {
        if (e.key === "+" || e.key === "ArrowUp") registrarEntrada();
        if (e.key === "-" || e.key === "ArrowDown") registrarSalida();
    }
});
exportButton.addEventListener("click", exportarJSON);
importButton.addEventListener("click", function () { importFile.click(); });
importFile.addEventListener("change", function () {
    if (importFile.files.length > 0) importarJSON(importFile.files[0]);
    importFile.value = "";
});

setInterval(actualizarTurno, 60000);

try { localStorage.removeItem("aforoDB_v1"); } catch (e) {}
cargarDB();
