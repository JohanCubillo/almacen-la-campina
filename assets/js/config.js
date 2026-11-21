// =====================================================
//  CONFIGURACIÓN — cambiá solo estos valores
//  Supabase > Project Settings > API (Project URL + anon public)
//  ⚠️ NUNCA pongas aquí la service_role key.
// =====================================================
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU-ANON-KEY",

  // Valores por defecto (se usan si Supabase no está configurado o no responde)
  NEGOCIO: "Almacén La Campiña",
  WHATSAPP: "50687365733",
  TELEFONO: "4711-8869",
  TELEFONO2: "8799-4646",
  DIRECCION: "150 m noreste del cruce de Perdiz, Barrio San Marcos, Cariari de Pococí, Limón",
  HORARIO: "Consulte el horario por WhatsApp",
  FACEBOOK: "https://www.facebook.com/p/Almacen-Campina-100092324825394/",
  MAPA_QUERY: "Almacen La Campiña, 86JX+MGM, Cariari, Pococí, Costa Rica",
  BUCKET: "productos",
  ZONA_HORARIA: "America/Costa_Rica"
});

window.db = (function () {
  const c = window.APP_CONFIG;
  if (!window.supabase || c.SUPABASE_URL.includes("TU-PROYECTO") || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.SUPABASE_URL)) return null;
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
})();

// ---------- utilidades compartidas ----------
window.U = {
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  },
  // Solo deja pasar enlaces http(s); cualquier otra cosa (javascript:, data:) se descarta
  safeUrl(u, fallback = "#") {
    try {
      const url = new URL(String(u), location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : fallback;
    } catch { return fallback; }
  },
  soloDigitos(s) { return String(s ?? "").replace(/\D/g, ""); },
  colones(n) {
    if (n === null || n === undefined || n === "") return null;
    return "₡" + Number(n).toLocaleString("es-CR", { maximumFractionDigits: 2 });
  },
  DIAS: ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"],
  // horario_semana: {"1":["07:00","17:00"], "0":null, ...}
  parseHorario(txt) {
    try {
      const h = JSON.parse(txt || "null");
      if (!h || typeof h !== "object") return null;
      const ok = /^([01]\d|2[0-3]):[0-5]\d$/;
      const out = {};
      for (let d = 0; d < 7; d++) {
        const v = h[d];
        out[d] = Array.isArray(v) && ok.test(v[0]) && ok.test(v[1]) ? [v[0], v[1]] : null;
      }
      return Object.values(out).some(Boolean) ? out : null;
    } catch { return null; }
  },
  hora12(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const p = h >= 12 ? "p. m." : "a. m.";
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${p}`;
  },
  ahoraCR() {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: window.APP_CONFIG.ZONA_HORARIA, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const parts = Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const dia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    return { dia, min: Number(parts.hour) * 60 + Number(parts.minute) };
  }
};
