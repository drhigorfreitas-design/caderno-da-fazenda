-- Caderno da Fazenda: acesso do peão só ao cocho, pelo robô do Telegram
-- Rode depois de telegram-robo.sql. Pode rodar mais de uma vez.
-- Um sócio gera no app um código "só cocho" com o nome do peão; o peão manda o código ao robô.
-- A conta do peão fica em telegram_contas com papel = 'cocho' (user_id = sócio que gerou o código).
-- O robô só lança fornecimento no cocho para ele, e ele não recebe resumos, relatórios, backup nem avisos.

alter table public.telegram_contas add column if not exists papel text not null default 'socio';
alter table public.telegram_contas add column if not exists nome_pessoa text;
alter table public.telegram_codigos add column if not exists papel text not null default 'socio';
alter table public.telegram_codigos add column if not exists nome_pessoa text;

-- no app, qualquer sócio da fazenda vê e desliga os peões (o próprio Telegram continua só de quem é)
drop policy if exists "peoes" on public.telegram_contas;
create policy "peoes" on public.telegram_contas for all to authenticated
  using (papel = 'cocho' and fazenda_id in (select public.minhas_fazendas()));

-- gera o código do peão (só para quem é membro da fazenda)
create or replace function public.telegram_codigo_peao(p_fazenda uuid, p_nome text) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); c text; nm text := left(trim(coalesce(p_nome, '')), 40);
begin
  if u is null then raise exception 'sem login'; end if;
  if nm = '' then raise exception 'informe o nome do peão'; end if;
  if not exists (select 1 from public.membros m where m.user_id = u and m.fazenda_id = p_fazenda) then
    raise exception 'não é membro desta fazenda';
  end if;
  delete from public.telegram_codigos t where t.expira < now() or (t.user_id = u and t.papel = 'cocho');
  loop
    c := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.telegram_codigos t where t.codigo = c);
  end loop;
  insert into public.telegram_codigos (codigo, user_id, fazenda_id, papel, nome_pessoa) values (c, u, p_fazenda, 'cocho', nm);
  return c;
end $$;

revoke all on function public.telegram_codigo_peao(uuid, text) from public, anon;
grant execute on function public.telegram_codigo_peao(uuid, text) to authenticated;

-- o código do sócio não apaga mais o código de peão que ele acabou de gerar
create or replace function public.telegram_codigo(p_fazenda uuid) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); c text;
begin
  if u is null then raise exception 'sem login'; end if;
  if not exists (select 1 from public.membros m where m.user_id = u and m.fazenda_id = p_fazenda) then
    raise exception 'não é membro desta fazenda';
  end if;
  delete from public.telegram_codigos t where t.expira < now() or (t.user_id = u and t.papel = 'socio');
  loop
    c := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.telegram_codigos t where t.codigo = c);
  end loop;
  insert into public.telegram_codigos (codigo, user_id, fazenda_id) values (c, u, p_fazenda);
  return c;
end $$;
