-- =====================================================================
--  v14 — Cierre de caja: abrir con fondo, entradas y salidas de efectivo, contar y cerrar
--  Correr DESPUÉS de v13_credito.sql. Se puede correr más de una vez.
--
--  - caja_turnos: cada apertura y cierre de caja (el resumen queda congelado al cerrar)
--  - caja_movimientos: efectivo que entra o sale de la caja sin ser una venta
--    (pago a un proveedor, retiro para depositar, cambio que se trae…)
--  - resumen_caja(): lo que tendría que haber, calculado por la base con los pagos del turno
--  Solo puede haber una caja abierta a la vez.
-- =====================================================================

create table if not exists public.caja_turnos (
  id                  bigint generated always as identity primary key,
  estado              text not null default 'abierta' check (estado in ('abierta','cerrada')),
  abierta_at          timestamptz not null default now(),
  abierta_por         uuid default auth.uid(),
  fondo               numeric(12,2) not null default 0 check (fondo >= 0 and fondo <= 10000000),
  cerrada_at          timestamptz,
  cerrada_por         uuid,
  resumen             jsonb,                                   -- resumen_caja() al cerrar
  efectivo_esperado   numeric(12,2),
  efectivo_contado    numeric(12,2) check (efectivo_contado >= 0),
  diferencia          numeric(12,2),
  conteo              jsonb,                                   -- billetes y monedas contados
  nota                text check (char_length(nota) <= 500)
);
create unique index if not exists caja_una_abierta on public.caja_turnos ((true)) where estado = 'abierta';
create index if not exists caja_turnos_fecha on public.caja_turnos (abierta_at desc);

create table if not exists public.caja_movimientos (
  id          bigint generated always as identity primary key,
  turno_id    bigint not null references public.caja_turnos(id) on delete restrict,
  tipo        text not null check (tipo in ('entrada','salida')),
  monto       numeric(12,2) not null check (monto > 0 and monto <= 10000000),
  motivo      text not null check (char_length(motivo) between 3 and 200),
  hecho_por   uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists caja_movimientos_turno on public.caja_movimientos (turno_id, created_at);

alter table public.caja_turnos enable row level security;
alter table public.caja_movimientos enable row level security;
drop policy if exists "caja_turnos_admin" on public.caja_turnos;
drop policy if exists "caja_movimientos_admin" on public.caja_movimientos;
create policy "caja_turnos_admin" on public.caja_turnos for select to authenticated using (public.is_admin());
create policy "caja_movimientos_admin" on public.caja_movimientos for select to authenticated using (public.is_admin());
revoke all on public.caja_turnos, public.caja_movimientos from anon, authenticated;
grant select on public.caja_turnos, public.caja_movimientos to authenticated;   -- escribir: solo con las funciones

-- Lo que pasó en un turno: ventas, pagos por método, entradas/salidas y el efectivo que debería haber
create or replace function public.resumen_caja(p_turno bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t record; v_hasta timestamptz; v_pagos jsonb; v_ventas jsonb; v_mov jsonb;
  v_efectivo numeric; v_entradas numeric; v_salidas numeric;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  select * into t from public.caja_turnos where id = p_turno;
  if t.id is null then raise exception 'Ese turno de caja no existe.' using errcode = 'P0001'; end if;
  if t.estado = 'cerrada' and t.resumen is not null then return t.resumen; end if;   -- lo congelado no cambia
  v_hasta := coalesce(t.cerrada_at, now());

  -- pagos recibidos en el turno (fecha del pago), sin anulados
  select jsonb_build_object(
           'efectivo',            coalesce(sum(monto) filter (where metodo = 'efectivo'), 0),
           'sinpe',               coalesce(sum(monto) filter (where metodo = 'sinpe'), 0),
           'sinpe_sin_verificar', coalesce(sum(monto) filter (where metodo = 'sinpe' and not verificado), 0),
           'tarjeta',             coalesce(sum(monto) filter (where metodo = 'tarjeta'), 0),
           'transferencia',       coalesce(sum(monto) filter (where metodo = 'transferencia'), 0),
           'abonos_credito',      coalesce(sum(monto) filter (where abono_id is not null), 0),
           'cantidad',            count(*),
           'total',               coalesce(sum(monto), 0)),
         coalesce(sum(monto) filter (where metodo = 'efectivo'), 0)
    into v_pagos, v_efectivo
    from public.pagos
   where not anulado and fecha >= t.abierta_at and fecha < v_hasta;

  -- ventas hechas en el turno
  select jsonb_build_object(
           'cantidad',  count(*) filter (where estado <> 'anulada'),
           'total',     coalesce(sum(total) filter (where estado <> 'anulada'), 0),
           'a_credito', coalesce(sum(total) filter (where estado <> 'anulada' and credito), 0),
           'de_contado',coalesce(sum(total) filter (where estado <> 'anulada' and not credito), 0),
           'anuladas',  count(*) filter (where estado = 'anulada'),
           'web',       count(*) filter (where estado <> 'anulada' and origen = 'web'))
    into v_ventas
    from public.pedidos
   where created_at >= t.abierta_at and created_at < v_hasta;

  select coalesce(sum(monto) filter (where tipo = 'entrada'), 0), coalesce(sum(monto) filter (where tipo = 'salida'), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'motivo', motivo, 'fecha', created_at) order by created_at), '[]'::jsonb)
    into v_entradas, v_salidas, v_mov
    from public.caja_movimientos where turno_id = t.id;

  return jsonb_build_object(
    'turno', t.id, 'abierta_at', t.abierta_at, 'hasta', v_hasta, 'fondo', t.fondo,
    'ventas', v_ventas, 'pagos', v_pagos,
    'entradas', v_entradas, 'salidas', v_salidas, 'movimientos', v_mov,
    'efectivo_esperado', t.fondo + v_efectivo + v_entradas - v_salidas);
end $$;
revoke all on function public.resumen_caja(bigint) from public, anon;
grant execute on function public.resumen_caja(bigint) to authenticated;

create or replace function public.abrir_caja(p_fondo numeric)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if p_fondo is null or p_fondo < 0 or p_fondo > 10000000 then raise exception 'Revise el fondo de caja.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.caja_turnos where estado = 'abierta') then
    raise exception 'Ya hay una caja abierta. Ciérrela antes de abrir otra.' using errcode = 'P0001';
  end if;
  insert into public.caja_turnos (fondo) values (round(p_fondo, 2)) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Ya hay una caja abierta. Ciérrela antes de abrir otra.' using errcode = 'P0001';
end $$;
revoke all on function public.abrir_caja(numeric) from public, anon;
grant execute on function public.abrir_caja(numeric) to authenticated;

create or replace function public.mover_caja(p_tipo text, p_monto numeric, p_motivo text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_turno bigint; v_id bigint; v_motivo text := left(trim(coalesce(p_motivo, '')), 200);
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if p_tipo not in ('entrada','salida') then raise exception 'Tipo no válido.' using errcode = 'P0001'; end if;
  if p_monto is null or p_monto <= 0 or p_monto > 10000000 then raise exception 'Revise el monto.' using errcode = 'P0001'; end if;
  if char_length(v_motivo) < 3 then raise exception 'Escriba el motivo.' using errcode = 'P0001'; end if;
  select id into v_turno from public.caja_turnos where estado = 'abierta';
  if v_turno is null then raise exception 'Primero abra la caja.' using errcode = 'P0001'; end if;
  insert into public.caja_movimientos (turno_id, tipo, monto, motivo) values (v_turno, p_tipo, round(p_monto, 2), v_motivo)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.mover_caja(text, numeric, text) from public, anon;
grant execute on function public.mover_caja(text, numeric, text) to authenticated;

-- p_conteo = {"20000": 3, "10000": 5, ..., "5": 2}  (cantidad de billetes/monedas)
create or replace function public.cerrar_caja(p_turno bigint, p_contado numeric, p_conteo jsonb default null, p_nota text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t record; v_res jsonb; v_esperado numeric; v_ahora timestamptz := now();
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  select * into t from public.caja_turnos where id = p_turno for update;
  if t.id is null then raise exception 'Ese turno de caja no existe.' using errcode = 'P0001'; end if;
  if t.estado = 'cerrada' then raise exception 'Esa caja ya está cerrada.' using errcode = 'P0001'; end if;
  if p_contado is null or p_contado < 0 or p_contado > 100000000 then raise exception 'Revise el efectivo contado.' using errcode = 'P0001'; end if;
  if p_conteo is not null and jsonb_typeof(p_conteo) <> 'object' then raise exception 'Conteo no válido.' using errcode = 'P0001'; end if;

  update public.caja_turnos set cerrada_at = v_ahora where id = p_turno;   -- el resumen llega hasta este momento
  v_res := public.resumen_caja(p_turno);
  v_esperado := (v_res ->> 'efectivo_esperado')::numeric;
  update public.caja_turnos
     set estado = 'cerrada', cerrada_por = auth.uid(), resumen = v_res,
         efectivo_esperado = v_esperado, efectivo_contado = round(p_contado, 2),
         diferencia = round(p_contado, 2) - v_esperado, conteo = p_conteo,
         nota = nullif(left(trim(coalesce(p_nota, '')), 500), '')
   where id = p_turno;
  return v_res || jsonb_build_object('efectivo_contado', round(p_contado, 2), 'diferencia', round(p_contado, 2) - v_esperado,
                                     'cerrada_at', v_ahora);
end $$;
revoke all on function public.cerrar_caja(bigint, numeric, jsonb, text) from public, anon;
grant execute on function public.cerrar_caja(bigint, numeric, jsonb, text) to authenticated;
