-- Battleship initial schema.
-- Access pattern: server-only via service_role (bypasses RLS).
-- RLS is enabled on every table with NO policies -> deny-all for anon/authenticated.
-- Defense-in-depth: even if the anon key leaks, no rows are exposed.

create extension if not exists pgcrypto;

-- ============================================================
-- games
-- ============================================================
create table games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('ai', 'human')),
  state text not null default 'placing' check (state in ('placing', 'firing', 'ended')),
  current_turn_slot int check (current_turn_slot in (1, 2)),
  winner_slot int check (winner_slot in (1, 2)),
  ai_difficulty text check (ai_difficulty in ('easy', 'medium', 'hard', 'expert')),
  invite_code_hash bytea,
  invite_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint ai_difficulty_consistency check (
    (mode = 'ai' and ai_difficulty is not null) or
    (mode = 'human' and ai_difficulty is null)
  )
);

create index idx_games_state_active on games (state) where state <> 'ended';
create index idx_games_ended_at on games (ended_at desc) where ended_at is not null;

alter table games enable row level security;

-- ============================================================
-- players
-- ============================================================
create table players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  slot int not null check (slot in (1, 2)),
  session_token_hash bytea,
  is_ai boolean not null default false,
  ships_placed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (game_id, slot),
  constraint token_or_ai check (
    (is_ai = true and session_token_hash is null) or
    (is_ai = false and session_token_hash is not null)
  )
);

create index idx_players_game_id on players (game_id);

alter table players enable row level security;

-- ============================================================
-- ships
-- ============================================================
create table ships (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  ship_type text not null check (
    ship_type in ('carrier', 'battleship', 'cruiser', 'submarine', 'destroyer')
  ),
  length int not null check (length between 2 and 5),
  cells jsonb not null,
  hit_cells jsonb not null default '[]'::jsonb,
  sunk boolean not null default false,
  created_at timestamptz not null default now(),
  unique (player_id, ship_type)
);

create index idx_ships_player_id on ships (player_id);
create index idx_ships_player_unsunk on ships (player_id) where sunk = false;

alter table ships enable row level security;

-- ============================================================
-- shots
-- ============================================================
create table shots (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  shooter_player_id uuid not null references players(id),
  target_row int not null check (target_row between 0 and 9),
  target_col int not null check (target_col between 0 and 9),
  result text not null check (result in ('hit', 'miss', 'sunk')),
  ship_id uuid references ships(id),
  shot_at timestamptz not null default now(),
  unique (game_id, shooter_player_id, target_row, target_col)
);

create index idx_shots_game_shot_at on shots (game_id, shot_at);
create index idx_shots_shooter on shots (shooter_player_id);

alter table shots enable row level security;

-- ============================================================
-- updated_at trigger for games
-- ============================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger games_set_updated_at
  before update on games
  for each row
  execute function set_updated_at();
