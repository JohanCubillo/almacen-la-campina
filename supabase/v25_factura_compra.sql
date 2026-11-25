-- =====================================================================
--  v25 — Factura electrónica de compra (08)
--  Requiere v10 y v21. Se puede correr más de una vez.
--
--  La hace el almacén (comprador) cuando le compra a alguien que no factura:
--  en el XML el proveedor va como Emisor y el almacén como Receptor, pero la
--  clave lleva la cédula del almacén y la firma el almacén.
--  No es de una venta: pedido_id queda vacío y se guarda la entrada de mercadería (si se hizo).
-- =====================================================================

select public._quitar_checks('fe_documentos', 'tipo');
alter table public.fe_documentos add constraint fe_documentos_tipo_check check (tipo in ('01','03','04','08'));
alter table public.fe_documentos alter column pedido_id drop not null;
alter table public.fe_documentos drop constraint if exists fe_documentos_venta_o_compra;
alter table public.fe_documentos add constraint fe_documentos_venta_o_compra check (tipo = '08' or pedido_id is not null);
alter table public.fe_documentos add column if not exists entrada_id bigint references public.entradas(id) on delete set null;

select public._quitar_checks('fe_consecutivos', 'tipo');
alter table public.fe_consecutivos add constraint fe_consecutivos_tipo_check check (tipo in ('01','03','04','05','06','07','08'));

create or replace view public.v_fe_documentos with (security_invoker = true) as
select id, pedido_id, tipo, ambiente, clave, consecutivo, fecha_emision, receptor, total, impuesto,
       estado, detalle, referencia_id, anulado, intentos, created_at, updated_at, situacion, parcial, entrada_id
  from public.fe_documentos;
revoke all on public.v_fe_documentos from anon, authenticated;
grant select on public.v_fe_documentos to authenticated;

-- quien tiene "compras" también ve las facturas de compra
drop policy if exists "fe_documentos_compras_leer" on public.fe_documentos;
create policy "fe_documentos_compras_leer" on public.fe_documentos for select to authenticated
  using (tipo = '08' and public.puede('compras'));
