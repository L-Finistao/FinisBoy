-- FinisBoy: banco no Neon (Postgres). Rode este arquivo uma vez no SQL Editor do Neon.
-- Cada linha de `docs` pertence a um usuário (user_id): a API sempre filtra pelo usuário do login.

create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

-- Um documento por registro do app (rotas, paradas, entregas, gastos, trajetos e configurações).
-- store: stops | deliveries | expenses | routes | tracks | kv
create sequence if not exists docs_seq;
create table if not exists docs (
  user_id   uuid   not null references users(id) on delete cascade,
  store     text   not null,
  doc_id    text   not null,
  data      jsonb,
  deleted   boolean not null default false,   -- apagado (a linha fica para os outros aparelhos saberem)
  client_ts bigint  not null default 0,       -- hora da última alteração no aparelho (vence a mais recente)
  seq       bigint  not null,                 -- ordem de chegada no servidor (usada para baixar só o que mudou)
  primary key (user_id, store, doc_id)
);
create index if not exists docs_user_seq on docs (user_id, seq);
