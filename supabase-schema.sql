-- Caderno da Fazenda: tabelas do Supabase
-- Cole tudo no SQL Editor do projeto "fazenda" e clique em Run.
-- Cada tabela guarda os mesmos registros do app: colunas para o que se filtra
-- (data, mês, tipo) e um campo "dados" (jsonb) com o resto do registro.
-- Segurança: só quem está logado e é o dono do registro lê e grava (RLS).

create table if not exists public.config (
  owner uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  dados jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- fechamentos mensais do rebanho (id = AAAA-MM)
create table if not exists public.fechamentos (
  id text not null,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mes text not null check (mes ~ '^\d{4}-\d{2}$'),
  dados jsonb not null default '{}'::jsonb,   -- cats: {categoria:{cab,peso}}
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

-- nascimentos, compras, vendas, mortes, mudanças de categoria
create table if not exists public.movimentos (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data date not null,
  tipo text not null check (tipo in ('nascimento','compra','venda','morte','transferencia')),
  categoria text,
  cab numeric,
  valor numeric,
  dados jsonb not null default '{}'::jsonb,   -- para, pesoMedio, precoArroba, obs
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

-- custos / desembolsos (centro: geral, cria, recria, engorda; lote_id quando for de um lote)
create table if not exists public.desembolsos (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data date not null,
  valor numeric not null,
  item text,
  grupo text,
  centro text not null default 'geral' check (centro in ('geral','cria','recria','engorda')),
  lote_id text,
  tipo text not null default 'custeio' check (tipo in ('custeio','investimento')),
  dados jsonb not null default '{}'::jsonb,   -- descricao
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists public.estacoes (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text,
  dados jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

-- lotes da engorda
create table if not exists public.engorda (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text,
  data_entrada date,
  data_saida date,
  dados jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists public.insumos (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  unidade text,
  dados jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

-- entradas, saídas e fornecimentos de insumos
create table if not exists public.estoque_movs (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  insumo_id text,
  data date not null,
  tipo text not null check (tipo in ('entrada','saida')),
  qtd numeric,
  valor numeric,
  fase text,
  dados jsonb not null default '{}'::jsonb,   -- fornecimento, cab, dias, peso
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists public.formulacoes (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null,
  tipo text,
  dados jsonb not null default '{}'::jsonb,   -- ingredientes: [{nome,pct,preco}]
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists public.adaptacoes (
  id text not null default gen_random_uuid()::text,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text,
  tipo text,
  inicio date,
  fase text,
  dados jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

-- índices para os períodos de análise
create index if not exists movimentos_data_idx on public.movimentos (owner, data);
create index if not exists desembolsos_data_idx on public.desembolsos (owner, data);
create index if not exists estoque_movs_data_idx on public.estoque_movs (owner, data);

-- segurança: cada tabela só deixa o dono (usuário logado) ver e mexer nos seus registros
do $$
declare t text;
begin
  foreach t in array array['config','fechamentos','movimentos','desembolsos','estacoes','engorda','insumos','estoque_movs','formulacoes','adaptacoes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dono" on public.%I', t);
    execute format('create policy "dono" on public.%I for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
