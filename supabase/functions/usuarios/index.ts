// =====================================================================
//  Función de Supabase "usuarios" — el administrador maneja las cuentas
//  de los empleados desde el panel (Datos del negocio → Usuarios).
//
//  Acciones (POST JSON, solo administrador con autenticador):
//   { accion: "crear", usuario, nombre, clave, permisos: [...], pide_codigo }
//   { accion: "clave", user_id, clave }        → nueva contraseña de un empleado
//   { accion: "renombrar", user_id, usuario }  → cambia el usuario con que entra
//
//  Los empleados entran con "usuario"; por dentro su correo es
//  usuario@usuarios.lacampina.local (no recibe correos). Los nombres, permisos
//  y si está activo se cambian en la base (RPC), no aquí.
//
//  Se sube una sola vez: Supabase → Edge Functions → Deploy a new function →
//  Via Editor → nombre "usuarios" → pegar este archivo → Deploy.
//  No necesita secretos: Supabase ya le da SUPABASE_URL y las llaves.
//  (opcional) PANEL_ORIGENES = https://johancubillo.github.io  (igual que "facturar")
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const DOMINIO = Deno.env.get("DOMINIO_PERSONAL") || "usuarios.lacampina.local";
const ORIGENES = (Deno.env.get("PANEL_ORIGENES") || "https://johancubillo.github.io").split(",").map((s) => s.trim());
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const LLAVE_PUBLICA = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const LLAVE_SERVICIO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY")!;
const PERMISOS = ["ventas", "anular", "caja", "credito", "inventario", "productos", "precios", "reportes", "preguntas"];
const RE_USUARIO = /^[a-z0-9][a-z0-9._-]{2,29}$/;

const cabeceras = (origen: string | null) => ({
  "Access-Control-Allow-Origin": origen && ORIGENES.includes(origen) ? origen : ORIGENES[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
});

const limpiarUsuario = (u: unknown) => String(u ?? "").trim().toLowerCase();
function revisarClave(c: unknown): string | null {
  const s = String(c ?? "");
  if (s.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (s.length > 72) return "La contraseña es demasiado larga (máximo 72).";
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return "La contraseña debe tener letras y números.";
  return null;
}
const traducir = (m: string) =>
  /already (been )?registered|already exists|email_exists/i.test(m) ? "Ese usuario ya existe. Escoja otro."
  : /email.*invalid|invalid.*email/i.test(m) ? `Supabase no aceptó el correo interno (@${DOMINIO}). Ponga el secreto DOMINIO_PERSONAL con un dominio que usted controle.`
  : /password/i.test(m) ? "Supabase no aceptó la contraseña: use una más larga, con letras y números."
  : m;

Deno.serve(async (req) => {
  const h = cabeceras(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const resp = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: h });
  if (req.method !== "POST") return resp({ ok: false, error: "Use POST." }, 405);

  // ¿quién llama? Solo un administrador con el código del autenticador (is_admin() de la base)
  const auth = req.headers.get("Authorization") || "";
  const yo = createClient(URL_SB, LLAVE_PUBLICA, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: esAdmin } = await yo.rpc("is_admin");
  if (esAdmin !== true) return resp({ ok: false, error: "Solo el administrador (con el código del autenticador) maneja usuarios." }, 403);
  const sb = createClient(URL_SB, LLAVE_SERVICIO, { auth: { persistSession: false } });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return resp({ ok: false, error: "Solicitud no válida." }, 400); }

  // solo se tocan cuentas de empleados (los administradores cambian su contraseña ellos mismos)
  async function empleado(id: unknown) {
    const { data } = await sb.from("admins").select("user_id,rol,usuario").eq("user_id", String(id ?? "")).maybeSingle();
    return data && data.rol === "usuario" ? data : null;
  }

  try {
    // ---------- crear ----------
    if (b.accion === "crear") {
      const usuario = limpiarUsuario(b.usuario);
      if (!RE_USUARIO.test(usuario)) return resp({ ok: false, error: "El usuario va en minúscula, de 3 a 30 letras o números, sin espacios (por ejemplo: marvin)." });
      const nombre = String(b.nombre ?? "").trim().replace(/\s+/g, " ");
      if (nombre.length < 2 || nombre.length > 60) return resp({ ok: false, error: "Escriba el nombre (2 a 60 letras)." });
      const malaClave = revisarClave(b.clave);
      if (malaClave) return resp({ ok: false, error: malaClave });
      const permisos = Array.isArray(b.permisos) ? [...new Set(b.permisos.map(String))] : [];
      if (permisos.some((p) => !PERMISOS.includes(p))) return resp({ ok: false, error: "Permiso no válido." });

      const { data: nuevo, error } = await sb.auth.admin.createUser({
        email: `${usuario}@${DOMINIO}`, password: String(b.clave), email_confirm: true,
        user_metadata: { nombre, usuario },
      });
      if (error || !nuevo?.user) return resp({ ok: false, error: traducir(error?.message || "No se pudo crear la cuenta.") });

      // se registra con la sesión del administrador: así queda en la bitácora quién lo agregó
      const { error: eReg } = await yo.rpc("registrar_empleado", {
        p_user: nuevo.user.id, p_usuario: usuario, p_nombre: nombre, p_permisos: permisos, p_pide_codigo: b.pide_codigo === true,
      });
      if (eReg) {
        await sb.auth.admin.deleteUser(nuevo.user.id);      // no dejar una cuenta a medias
        return resp({ ok: false, error: traducir(eReg.message) });
      }
      return resp({ ok: true, user_id: nuevo.user.id, usuario });
    }

    // ---------- nueva contraseña ----------
    if (b.accion === "clave") {
      const e = await empleado(b.user_id);
      if (!e) return resp({ ok: false, error: "Solo se le cambia la contraseña a un empleado." });
      const malaClave = revisarClave(b.clave);
      if (malaClave) return resp({ ok: false, error: malaClave });
      const { error } = await sb.auth.admin.updateUserById(e.user_id, { password: String(b.clave) });
      if (error) return resp({ ok: false, error: traducir(error.message) });
      await yo.rpc("anotar_cuenta", { p_user: e.user_id });
      return resp({ ok: true });
    }

    // ---------- cambiar el usuario con que entra ----------
    if (b.accion === "renombrar") {
      const e = await empleado(b.user_id);
      if (!e) return resp({ ok: false, error: "Solo se le cambia el usuario a un empleado." });
      const usuario = limpiarUsuario(b.usuario);
      if (!RE_USUARIO.test(usuario)) return resp({ ok: false, error: "El usuario va en minúscula, de 3 a 30 letras o números, sin espacios." });
      const { data: cuenta } = await sb.auth.admin.getUserById(e.user_id);
      const correo = String(cuenta?.user?.email || "");
      if (!correo.endsWith("@" + DOMINIO)) return resp({ ok: false, error: "Esta persona entra con su correo; no tiene usuario que cambiar." });
      const { error } = await sb.auth.admin.updateUserById(e.user_id, { email: `${usuario}@${DOMINIO}`, email_confirm: true });
      if (error) return resp({ ok: false, error: traducir(error.message) });
      const { error: eAn } = await yo.rpc("anotar_cuenta", { p_user: e.user_id, p_usuario: usuario });
      if (eAn) return resp({ ok: false, error: traducir(eAn.message) });
      return resp({ ok: true, usuario });
    }

    return resp({ ok: false, error: "Acción no válida." }, 400);
  } catch (e) {
    console.error("usuarios:", e);
    return resp({ ok: false, error: "No se pudo completar: " + String((e as Error)?.message || e).slice(0, 300) });
  }
});
