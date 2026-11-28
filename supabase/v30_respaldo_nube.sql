-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v30 · RESPALDO AUTOMÁTICO EN GOOGLE DRIVE
-- Corra este archivo DESPUÉS de v29_correos.sql (o de v28 si todavía no
-- usa los correos). Se puede correr las veces que quiera.
--
-- Cada noche GitHub (.github/workflows/respaldo.yml) saca una copia de la
-- base de datos y la sube a Google Drive. Al terminar anota aquí si salió
-- bien. El panel del administrador avisa si el respaldo falló o si hace
-- más de un día y medio que no se hace. Vea RESPALDO.md.
-- =====================================================================

create table if not exists public.respaldos_nube (
  id      bigserial primary key,
  fecha   timestamptz not null default now(),
  ok      boolean not null,
  archivo text,
  bytes   bigint,
  detalle text
);
create index if not exists respaldos_nube_fecha on public.respaldos_nube (id desc);

alter table public.respaldos_nube enable row level security;
drop policy if exists "respaldos_nube_ver" on public.respaldos_nube;
create policy "respaldos_nube_ver" on public.respaldos_nube for select to authenticated using (public.es_administrador());
revoke all on public.respaldos_nube from anon, authenticated;
grant select on public.respaldos_nube to authenticated;   -- lo escribe solo el respaldo de GitHub

-- no se guardan más de 400 anotaciones (más de un año)
create or replace function public._respaldos_nube_limpiar() returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.respaldos_nube where id < (select min(id) from (select id from public.respaldos_nube order by id desc limit 400) x);
  return null;
end $$;
drop trigger if exists trg_respaldos_nube_limpiar on public.respaldos_nube;
create trigger trg_respaldos_nube_limpiar after insert on public.respaldos_nube
  for each statement execute function public._respaldos_nube_limpiar();
