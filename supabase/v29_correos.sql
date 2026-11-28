-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v29 · FACTURAS POR CORREO AL CLIENTE
-- Corra este archivo DESPUÉS de v28_margen_precios.sql. Se puede correr
-- las veces que quiera. Después vuelva a publicar la función "facturar"
-- y ponga los secretos del correo (vea CORREO.md).
--
-- Cuando Hacienda acepta una factura o una nota de crédito con correo del
-- cliente, la función "facturar" le manda el PDF, el XML y la respuesta de
-- Hacienda (con Resend). Aquí queda anotado cada envío: a quién, si salió
-- o por qué no (por ejemplo, el límite de correos del mes del plan).
-- =====================================================================

do $$
begin
  if to_regclass('public.fe_documentos') is null then
    raise exception 'Primero corra v10_facturacion.sql.';
  end if;
end $$;

create table if not exists public.fe_correos (
  id           bigserial primary key,
  documento_id bigint not null references public.fe_documentos(id) on delete cascade,
  para         text,
  estado       text not null check (estado in ('enviado', 'error', 'sin_correo')),
  motivo       text,             -- limite_mes, limite_dia, muchos, llave, dominio, red, otro
  detalle      text,
  resend_id    text,
  usado_mes    integer,          -- lo que Resend dice que lleva usado del plan
  usado_dia    integer,
  creado_por   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists fe_correos_doc on public.fe_correos (documento_id, id desc);
create index if not exists fe_correos_fecha on public.fe_correos (created_at desc) where estado = 'enviado';

alter table public.fe_correos enable row level security;
drop policy if exists "fe_correos_ver" on public.fe_correos;
create policy "fe_correos_ver" on public.fe_correos for select to authenticated
  using (public.puede('ventas') or public.puede('reportes'));
revoke all on public.fe_correos from anon, authenticated;
grant select on public.fe_correos to authenticated;        -- escribir: solo la función "facturar"
