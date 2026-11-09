-- Caderno da Fazenda: robô do Telegram
-- Rode depois de compartilhar-fazenda.sql. Cole no SQL Editor do projeto "fazenda" e clique em Run. Pode rodar mais de uma vez.
-- Cada sócio liga o próprio Telegram pelo app (código de 8 dígitos que vale 10 minutos).
-- O robô (função "telegram" do Supabase) usa a chave de serviço e grava na fazenda de quem mandou.

-- código temporário gerado no app para ligar o Telegram
create table if not exists public.telegram_codigos (
  codigo text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  fazenda_id uuid not null references public.fazendas(id) on delete cascade,
  expira timestamptz not null default now() + interval '10 minutes'
);

-- conversas do Telegram já ligadas a uma pessoa e uma fazenda
create table if not exists public.telegram_contas (
  chat_id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  fazenda_id uuid not null references public.fazendas(id) on delete cascade,
  nome_telegram text,
  created_at timestamptz not null default now()
);

-- mensagens já tratadas: o Telegram reenvia se o robô demora, e assim nada é lançado duas vezes
create table if not exists public.telegram_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

alter table public.telegram_codigos enable row level security;
alter table public.telegram_contas enable row level security;
alter table public.telegram_updates enable row level security;
revoke all on public.telegram_codigos, public.telegram_contas, public.telegram_updates from anon, authenticated;
-- no app, cada pessoa só vê e desliga o próprio Telegram
grant select, delete on public.telegram_contas to authenticated;
drop policy if exists "meu telegram" on public.telegram_contas;
create policy "meu telegram" on public.telegram_contas for all to authenticated using (user_id = auth.uid());

-- gera o código para ligar o Telegram (só para quem é membro da fazenda)
create or replace function public.telegram_codigo(p_fazenda uuid) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); c text;
begin
  if u is null then raise exception 'sem login'; end if;
  if not exists (select 1 from public.membros m where m.user_id = u and m.fazenda_id = p_fazenda) then
    raise exception 'não é membro desta fazenda';
  end if;
  delete from public.telegram_codigos t where t.user_id = u or t.expira < now();
  loop
    c := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.telegram_codigos t where t.codigo = c);
  end loop;
  insert into public.telegram_codigos (codigo, user_id, fazenda_id) values (c, u, p_fazenda);
  return c;
end $$;

revoke all on function public.telegram_codigo(uuid) from public, anon;
grant execute on function public.telegram_codigo(uuid) to authenticated;
