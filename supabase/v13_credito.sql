-- =====================================================================
--  v13 — Crédito a clientes: ventas a crédito, abonos y saldos
--  Correr DESPUÉS de schema.sql y v4_mejoras.sql. Se puede correr más de una vez.
--
--  - clientes: los que tienen cuenta de crédito (límite y plazo)
--  - pedidos.credito / cliente_id / vence: una venta a crédito y cuándo vence
--  - abonos: pagos del cliente a su cuenta; se reparten solos en sus ventas más viejas
--    (cada parte queda como un pago normal de esa venta, así el saldo se calcula igual que siempre)
--  - v_clientes_credito: saldo, vencido y disponible de cada cliente
-- =====================================================================

-- montos para los mensajes: 1250000.5 → "1 250 000,50"
create or replace function public._colones(n numeric)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(replace(replace(to_char(round(n, 2), 'FM999,999,999,990.00'), ',', ' '), '.', ','), ',00$', '');
$$;

-- ---------- clientes ----------
create table if not exists public.clientes (
  id              bigint generated always as identity primary key,
  nombre          text not null check (char_length(nombre) between 2 and 100),
  tipo_id         text check (tipo_id in ('fisica','juridica','dimex','nite')),
  identificacion  text check (identificacion ~ '^[0-9]{9,12}$'),
  telefono        text check (telefono ~ '^[0-9 +()-]{8,20}$'),
  correo          text check (char_length(correo) <= 120 and correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  limite          numeric(12,2) check (limite >= 0),          -- vacío = sin límite
  plazo_dias      int not null default 30 check (plazo_dias between 1 and 365),
  activo          boolean not null default true,
  nota            text check (char_length(nota) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint cliente_id_completa check ((tipo_id is null) = (identificacion is null))
);
create unique index if not exists clientes_identificacion_unica on public.clientes (tipo_id, identificacion) where identificacion is not null;
create index if not exists clientes_nombre on public.clientes (lower(nombre));

drop trigger if exists trg_clientes_updated on public.clientes;
create trigger trg_clientes_updated before update on public.clientes
  for each row execute function public.tocar_updated_at();
drop trigger if exists trg_clientes_auditoria on public.clientes;
create trigger trg_clientes_auditoria after insert or update or delete on public.clientes
  for each row execute function public.registrar_auditoria();

alter table public.clientes enable row level security;
drop policy if exists "clientes_admin" on public.clientes;
create policy "clientes_admin" on public.clientes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.clientes from anon, authenticated;
grant select on public.clientes to authenticated;
grant insert (nombre, tipo_id, identificacion, telefono, correo, limite, plazo_dias, activo, nota) on public.clientes to authenticated;
grant update (nombre, tipo_id, identificacion, telefono, correo, limite, plazo_dias, activo, nota) on public.clientes to authenticated;

-- ---------- ventas a crédito ----------
alter table public.pedidos add column if not exists cliente_id bigint references public.clientes(id) on delete restrict;
alter table public.pedidos add column if not exists credito boolean not null default false;
alter table public.pedidos add column if not exists vence date;
alter table public.pedidos drop constraint if exists pedido_credito_completo;
alter table public.pedidos add constraint pedido_credito_completo check (not credito or (cliente_id is not null and vence is not null));
create index if not exists pedidos_cliente_credito on public.pedidos (cliente_id, vence) where credito;
-- se ponen o quitan con poner_credito() (revisa límite y plazo); no directo

-- Pone una venta a crédito de un cliente (o la vuelve de contado con p_cliente null)
create or replace function public.poner_credito(p_pedido bigint, p_cliente bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c record; p record; v_saldo numeric; v_vence date;
  hoy date := (now() at time zone 'America/Costa_Rica')::date;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  select id, estado, credito, cliente_id, total, pagado_registrado, created_at into p from public.pedidos where id = p_pedido for update;
  if p.id is null then raise exception 'Esa venta no existe.' using errcode = 'P0001'; end if;
  if p.estado = 'anulada' then raise exception 'La venta está anulada.' using errcode = 'P0001'; end if;

  if p_cliente is null then                                    -- volver a contado
    if exists (select 1 from public.pagos where pedido_id = p_pedido and abono_id is not null and not anulado) then
      raise exception 'Esta venta ya recibió abonos de crédito: anule esos abonos primero.' using errcode = 'P0001';
    end if;
    update public.pedidos set credito = false, cliente_id = null, vence = null where id = p_pedido;
    return jsonb_build_object('credito', false);
  end if;

  select * into c from public.clientes where id = p_cliente;
  if c.id is null then raise exception 'Ese cliente no existe.' using errcode = 'P0001'; end if;
  if not c.activo then raise exception 'El crédito de % está desactivado.', c.nombre using errcode = 'P0001'; end if;
  -- saldo de sus otras ventas a crédito + esta venta
  select coalesce(sum(greatest(total - pagado_registrado, 0)), 0) into v_saldo
    from public.pedidos where cliente_id = c.id and credito and estado <> 'anulada' and id <> p_pedido;
  if c.limite is not null and v_saldo + greatest(p.total - p.pagado_registrado, 0) > c.limite then
    raise exception 'Pasa el límite de crédito de %: ya debe ₡%, esta venta es de ₡% y el límite es ₡%.',
      c.nombre, public._colones(v_saldo), public._colones(greatest(p.total - p.pagado_registrado, 0)), public._colones(c.limite) using errcode = 'P0001';
  end if;
  v_vence := (coalesce((p.created_at at time zone 'America/Costa_Rica')::date, hoy)) + c.plazo_dias;
  update public.pedidos set credito = true, cliente_id = c.id, vence = v_vence where id = p_pedido;
  return jsonb_build_object('credito', true, 'cliente_id', c.id, 'vence', v_vence, 'saldo_anterior', v_saldo);
end $$;
revoke all on function public.poner_credito(bigint, bigint) from public, anon;
grant execute on function public.poner_credito(bigint, bigint) to authenticated;

-- ---------- abonos ----------
create table if not exists public.abonos (
  id                bigint generated always as identity primary key,
  cliente_id        bigint not null references public.clientes(id) on delete restrict,
  fecha             timestamptz not null default now(),
  monto             numeric(12,2) not null check (monto > 0 and monto <= 50000000),
  metodo            text not null check (metodo in ('sinpe','efectivo','tarjeta','transferencia')),
  referencia        text check (referencia ~ '^[0-9A-Za-z-]{4,40}$'),
  nota              text check (char_length(nota) <= 300),
  anulado           boolean not null default false,
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  hecho_por         uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  constraint abono_con_referencia check (metodo not in ('sinpe','transferencia') or referencia is not null)
);
create index if not exists abonos_cliente on public.abonos (cliente_id, fecha desc);
create unique index if not exists abonos_referencia_unica on public.abonos (metodo, upper(referencia)) where referencia is not null and not anulado;

alter table public.abonos enable row level security;
drop policy if exists "abonos_admin" on public.abonos;
create policy "abonos_admin" on public.abonos for select to authenticated using (public.is_admin());
revoke all on public.abonos from anon, authenticated;
grant select on public.abonos to authenticated;        -- escribir: registrar_abono / anular_abono

-- cada parte de un abono es un pago de una venta (sin repetir el número de comprobante)
alter table public.pagos add column if not exists abono_id bigint references public.abonos(id) on delete restrict;
create index if not exists pagos_abono on public.pagos (abono_id) where abono_id is not null;
alter table public.pagos drop constraint if exists sinpe_con_referencia;
alter table public.pagos add constraint sinpe_con_referencia
  check (metodo not in ('sinpe','transferencia') or referencia is not null or abono_id is not null);

-- p = {"cliente_id", "monto", "metodo", "referencia", "fecha", "nota", "verificado": true}
create or replace function public.registrar_abono(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cli bigint := nullif(p ->> 'cliente_id', '')::bigint;
  v_metodo text := coalesce(nullif(p ->> 'metodo', ''), 'efectivo');
  v_ref text := nullif(upper(regexp_replace(coalesce(p ->> 'referencia', ''), '\s', '', 'g')), '');
  v_nota text := nullif(left(trim(coalesce(p ->> 'nota', '')), 300), '');
  v_ver boolean := coalesce((p ->> 'verificado')::boolean, false);
  v_monto numeric; v_fecha timestamptz; v_saldo numeric; v_id bigint; v_resta numeric; v_parte numeric;
  r record; v_apl jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if not exists (select 1 from public.clientes where id = v_cli) then raise exception 'Ese cliente no existe.' using errcode = 'P0001'; end if;
  if v_metodo not in ('sinpe','efectivo','tarjeta','transferencia') then raise exception 'Método no válido.' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'monto', '') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' or (p ->> 'monto')::numeric <= 0 then
    raise exception 'Revise el monto del abono.' using errcode = 'P0001';
  end if;
  v_monto := (p ->> 'monto')::numeric;
  begin v_fecha := coalesce(nullif(p ->> 'fecha', '')::timestamptz, now());
  exception when others then raise exception 'Revise la fecha.' using errcode = 'P0001'; end;
  if v_fecha > now() + interval '10 minutes' then raise exception 'La fecha no puede ser futura.' using errcode = 'P0001'; end if;
  if v_metodo in ('sinpe','transferencia') and v_ref is null then
    raise exception 'Ponga el número de comprobante del %.', case v_metodo when 'sinpe' then 'SINPE' else 'depósito' end using errcode = 'P0001';
  end if;
  if v_ref is not null and v_ref !~ '^[0-9A-Z-]{4,40}$' then raise exception 'Revise el número de comprobante.' using errcode = 'P0001'; end if;
  if v_ref is not null and (
       exists (select 1 from public.pagos where metodo = v_metodo and upper(referencia) = v_ref and not anulado)
    or exists (select 1 from public.abonos where metodo = v_metodo and upper(referencia) = v_ref and not anulado)) then
    raise exception 'Ese número de comprobante ya está registrado.' using errcode = 'P0001';
  end if;

  perform 1 from public.pedidos where cliente_id = v_cli and credito and estado <> 'anulada' for update;
  select coalesce(sum(greatest(total - pagado_registrado, 0)), 0) into v_saldo
    from public.pedidos where cliente_id = v_cli and credito and estado <> 'anulada';
  if v_saldo <= 0 then raise exception 'Este cliente no debe nada.' using errcode = 'P0001'; end if;
  if v_monto > v_saldo then
    raise exception 'El abono (₡%) es mayor que lo que debe (₡%).', public._colones(v_monto), public._colones(v_saldo) using errcode = 'P0001';
  end if;

  insert into public.abonos (cliente_id, fecha, monto, metodo, referencia, nota)
  values (v_cli, v_fecha, v_monto, v_metodo, v_ref, v_nota) returning id into v_id;

  -- se paga primero lo que vence primero
  v_resta := v_monto;
  for r in select id, codigo, total - pagado_registrado as saldo from public.pedidos
            where cliente_id = v_cli and credito and estado <> 'anulada' and total - pagado_registrado > 0
            order by vence, created_at, id loop
    exit when v_resta <= 0;
    v_parte := least(v_resta, r.saldo);
    insert into public.pagos (pedido_id, metodo, monto, referencia, fecha, nota, verificado, abono_id)
    values (r.id, v_metodo, v_parte, null, v_fecha, 'Abono ' || v_id || coalesce(' · ' || v_ref, ''), v_ver, v_id);
    v_apl := v_apl || jsonb_build_object('pedido_id', r.id, 'codigo', r.codigo, 'monto', v_parte);
    v_resta := v_resta - v_parte;
  end loop;
  return jsonb_build_object('id', v_id, 'aplicado', v_apl, 'saldo_antes', v_saldo, 'saldo_despues', v_saldo - v_monto);
end $$;
revoke all on function public.registrar_abono(jsonb) from public, anon;
grant execute on function public.registrar_abono(jsonb) to authenticated;

create or replace function public.anular_abono(p_id bigint, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_anulado boolean; v_motivo text := left(trim(coalesce(p_motivo, '')), 300);
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if char_length(v_motivo) < 5 then raise exception 'Escriba el motivo (al menos 5 letras).' using errcode = 'P0001'; end if;
  select anulado into v_anulado from public.abonos where id = p_id for update;
  if v_anulado is null then raise exception 'Ese abono no existe.' using errcode = 'P0001'; end if;
  if v_anulado then raise exception 'Ese abono ya está anulado.' using errcode = 'P0001'; end if;
  update public.pagos set anulado = true, motivo_anulacion = v_motivo where abono_id = p_id and not anulado;
  update public.abonos set anulado = true, motivo_anulacion = v_motivo where id = p_id;
end $$;
revoke all on function public.anular_abono(bigint, text) from public, anon;
grant execute on function public.anular_abono(bigint, text) to authenticated;

-- marca como visto en el banco todas las partes de un abono
create or replace function public.verificar_abono(p_id bigint)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  update public.pagos set verificado = true where abono_id = p_id and not anulado and not verificado;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.verificar_abono(bigint) from public, anon;
grant execute on function public.verificar_abono(bigint) to authenticated;

-- ---------- saldos ----------
create or replace view public.v_clientes_credito with (security_invoker = true) as
select c.id, c.nombre, c.tipo_id, c.identificacion, c.telefono, c.correo, c.limite, c.plazo_dias, c.activo, c.nota,
       c.created_at, c.updated_at,
       coalesce(s.saldo, 0)    as saldo,
       coalesce(s.vencido, 0)  as vencido,
       coalesce(s.abiertas, 0) as abiertas,
       s.vence_primero,
       s.ultima_compra,
       case when c.limite is null then null else greatest(c.limite - coalesce(s.saldo, 0), 0) end as disponible
  from public.clientes c
  left join lateral (
    select sum(greatest(p.total - p.pagado_registrado, 0)) as saldo,
           sum(greatest(p.total - p.pagado_registrado, 0))
             filter (where p.vence < (now() at time zone 'America/Costa_Rica')::date) as vencido,
           count(*) filter (where p.total - p.pagado_registrado > 0) as abiertas,
           min(p.vence) filter (where p.total - p.pagado_registrado > 0) as vence_primero,
           max(p.created_at) as ultima_compra
      from public.pedidos p
     where p.cliente_id = c.id and p.credito and p.estado <> 'anulada'
  ) s on true;
revoke all on public.v_clientes_credito from anon, authenticated;
grant select on public.v_clientes_credito to authenticated;
