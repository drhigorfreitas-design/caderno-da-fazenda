-- Caderno da Fazenda: compartilhar a fazenda com os sócios
-- Cole tudo no SQL Editor do projeto "fazenda" e clique em Run. Pode rodar mais de uma vez.
-- O que muda: os registros passam a pertencer a uma FAZENDA (e não a uma pessoa).
-- Quem é membro da fazenda vê, lança, edita e apaga tudo dela. "owner" vira só "quem lançou".
-- Os dados que já existem vão para a fazenda de quem os lançou; nada é apagado.

create table if not exists public.fazendas (
  id uuid primary key default gen_random_uuid(),
  nome text,
  criada_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.membros (
  fazenda_id uuid not null references public.fazendas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  nome text,
  via_convite boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (fazenda_id, user_id)
);

-- convite por e-mail: quando a pessoa entra com esse e-mail (já confirmado), vira membro
create table if not exists public.convites (
  fazenda_id uuid not null references public.fazendas(id) on delete cascade,
  email text not null check (email = lower(email)),
  criado_por uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (fazenda_id, email)
);

-- fazendas de quem está logado (security definer para não cair em laço nas regras de membros)
create or replace function public.minhas_fazendas() returns setof uuid
language sql stable security definer set search_path = public as $$
  select fazenda_id from public.membros where user_id = auth.uid()
$$;

do $$
declare
  tabs text[] := array['config','fechamentos','movimentos','desembolsos','estacoes','engorda','insumos','estoque_movs','formulacoes','adaptacoes'];
  t text; o uuid; f uuid;
begin
  foreach t in array tabs loop
    execute format('alter table public.%I add column if not exists fazenda_id uuid references public.fazendas(id) on delete cascade', t);
  end loop;

  -- cada pessoa que já tem registros ganha a sua fazenda (ou usa a que já tem)
  for o in execute (select string_agg(format('select owner from public.%I where fazenda_id is null and owner is not null', x), ' union ') from unnest(tabs) x) loop
    select m.fazenda_id into f from public.membros m where m.user_id = o order by m.created_at limit 1;
    if f is null then
      insert into public.fazendas (nome, criada_por)
        values (coalesce((select c.dados->>'nome' from public.config c where c.owner = o limit 1), 'Fazenda'), o) returning id into f;
      insert into public.membros (fazenda_id, user_id, email, nome)
        values (f, o, (select lower(u.email) from auth.users u where u.id = o), (select c.dados->>'usuario' from public.config c where c.owner = o limit 1));
    end if;
    foreach t in array tabs loop
      execute format('update public.%I set fazenda_id = $1 where owner = $2 and fazenda_id is null', t) using f, o;
    end loop;
  end loop;

  foreach t in array tabs loop
    -- chave passa a ser (fazenda, id); config tem uma linha por fazenda
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_pkey');
    execute format('alter table public.%I alter column fazenda_id set not null', t);
    if t = 'config' then
      execute 'alter table public.config add primary key (fazenda_id)';
    else
      execute format('alter table public.%I add primary key (fazenda_id, id)', t);
    end if;
    -- apagar a conta de um sócio não apaga o que ele lançou
    execute format('alter table public.%I alter column owner drop not null', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_owner_fkey');
    execute format('alter table public.%I add constraint %I foreign key (owner) references auth.users(id) on delete set null', t, t || '_owner_fkey');
    -- segurança: só membros da fazenda leem e gravam
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dono" on public.%I', t);
    execute format('drop policy if exists "fazenda" on public.%I', t);
    execute format('create policy "fazenda" on public.%I for all to authenticated using (fazenda_id in (select public.minhas_fazendas())) with check (fazenda_id in (select public.minhas_fazendas()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

create index if not exists movimentos_faz_data_idx on public.movimentos (fazenda_id, data);
create index if not exists desembolsos_faz_data_idx on public.desembolsos (fazenda_id, data);
create index if not exists estoque_movs_faz_data_idx on public.estoque_movs (fazenda_id, data);

-- regras das tabelas novas
alter table public.fazendas enable row level security;
alter table public.membros enable row level security;
alter table public.convites enable row level security;
drop policy if exists "ver" on public.fazendas;
drop policy if exists "renomear" on public.fazendas;
create policy "ver" on public.fazendas for select to authenticated using (id in (select public.minhas_fazendas()));
create policy "renomear" on public.fazendas for update to authenticated using (id in (select public.minhas_fazendas())) with check (id in (select public.minhas_fazendas()));
drop policy if exists "ver" on public.membros;
drop policy if exists "meu nome" on public.membros;
drop policy if exists "remover" on public.membros;
create policy "ver" on public.membros for select to authenticated using (fazenda_id in (select public.minhas_fazendas()));
create policy "meu nome" on public.membros for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remover" on public.membros for delete to authenticated using (fazenda_id in (select public.minhas_fazendas()));
drop policy if exists "convites" on public.convites;
create policy "convites" on public.convites for all to authenticated using (fazenda_id in (select public.minhas_fazendas())) with check (fazenda_id in (select public.minhas_fazendas()));
revoke all on public.fazendas, public.membros, public.convites from anon, authenticated;
grant select on public.fazendas, public.membros to authenticated;
grant update (nome) on public.fazendas to authenticated;   -- só o nome; ninguém muda de fazenda por aqui
grant update (nome) on public.membros to authenticated;
grant delete on public.membros to authenticated;
grant select, insert, delete on public.convites to authenticated;

-- chamado pelo app ao entrar: aceita convites do e-mail, cria a fazenda de quem não tem nenhuma
-- e devolve as fazendas da pessoa
create or replace function public.entrar_fazenda() returns json
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  e text := lower(coalesce(auth.jwt()->>'email', ''));
  f uuid; n int := 0;
begin
  if u is null then raise exception 'sem login'; end if;
  if e <> '' then
    insert into public.membros (fazenda_id, user_id, email, via_convite)
      select c.fazenda_id, u, e, true from public.convites c where c.email = e
      on conflict (fazenda_id, user_id) do nothing;
    get diagnostics n = row_count;
    delete from public.convites c where c.email = e;
    -- entrou por convite: some a fazenda vazia que o app tinha criado sozinha para essa pessoa
    if n > 0 then
      delete from public.fazendas z where z.criada_por = u
        and not exists (select 1 from public.membros m where m.fazenda_id = z.id and m.user_id <> u)
        and not exists (select 1 from public.fechamentos x where x.fazenda_id = z.id)
        and not exists (select 1 from public.movimentos x where x.fazenda_id = z.id)
        and not exists (select 1 from public.desembolsos x where x.fazenda_id = z.id)
        and not exists (select 1 from public.engorda x where x.fazenda_id = z.id)
        and not exists (select 1 from public.estacoes x where x.fazenda_id = z.id)
        and not exists (select 1 from public.estoque_movs x where x.fazenda_id = z.id)
        and not exists (select 1 from public.insumos x where x.fazenda_id = z.id);
    end if;
  end if;
  if not exists (select 1 from public.membros m where m.user_id = u) then
    insert into public.fazendas (nome, criada_por) values ('Fazenda', u) returning id into f;
    insert into public.membros (fazenda_id, user_id, email) values (f, u, nullif(e, ''));
  end if;
  update public.membros m set email = e where m.user_id = u and e <> '' and m.email is distinct from e;
  return (select coalesce(json_agg(json_build_object('fazenda_id', m.fazenda_id, 'nome_fazenda', z.nome, 'via_convite', m.via_convite) order by m.created_at), '[]'::json)
    from public.membros m join public.fazendas z on z.id = m.fazenda_id where m.user_id = u);
end $$;

revoke all on function public.entrar_fazenda() from public, anon;
grant execute on function public.entrar_fazenda() to authenticated;
revoke all on function public.minhas_fazendas() from public, anon;
grant execute on function public.minhas_fazendas() to authenticated;
