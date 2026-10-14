// Postgres access. The rest of the server only uses { query, exec, tx, close },
// so the same code runs against Neon (via node-postgres) and, in tests,
// against an in-memory Postgres (PGlite).

const SCHEMA = `
  create table if not exists shipments (
    tracking_number text primary key,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    status       text not null,
    service      text not null default '',
    from_location text not null default '',
    to_location  text not null default '',
    eta          text not null default 'TBD',
    weight       text not null default '0 kg',
    description  text not null default '',
    metrics      jsonb not null default '{}',
    customer     jsonb not null default '{}',
    details      jsonb not null default '{}',
    image_data   text not null default ''
  );

  create table if not exists shipment_stops (
    id              uuid primary key,
    tracking_number text not null references shipments(tracking_number) on delete cascade,
    position        integer not null,
    location        text not null,
    note            text not null default '',
    eta             text not null default '',
    status          text not null default 'upcoming'
                    check (status in ('upcoming', 'arrived', 'departed')),
    arrived_at      timestamptz,
    departed_at     timestamptz
  );
  create index if not exists shipment_stops_by_shipment
    on shipment_stops (tracking_number, position);

  create table if not exists tracking_events (
    seq             bigserial primary key,
    id              uuid not null unique,
    tracking_number text not null references shipments(tracking_number) on delete cascade,
    time            timestamptz not null default now(),
    type            text not null,
    title           text not null,
    location        text not null default '',
    description     text not null default '',
    status          text,
    stop_id         uuid
  );
  create index if not exists tracking_events_by_shipment
    on tracking_events (tracking_number, seq);

  -- Tracking history is append-only: rows can never be edited, and are only
  -- removed when the whole shipment they belong to is deleted.
  create or replace function tracking_events_append_only() returns trigger
  language plpgsql as $$
  begin
    if tg_op = 'DELETE'
       and not exists (select 1 from shipments where tracking_number = old.tracking_number) then
      return old;
    end if;
    raise exception 'tracking history is append-only';
  end $$;

  create or replace trigger tracking_events_append_only
    before update or delete on tracking_events
    for each row execute function tracking_events_append_only();

  create table if not exists quotes (
    id              text primary key,
    created_at      timestamptz not null default now(),
    status          text not null default 'pending',
    service         text not null default '',
    notes           text not null default '',
    sender          jsonb not null default '{}',
    recipient       jsonb not null default '{}',
    package         jsonb not null default '{}',
    tracking_number text
  );

  create table if not exists messages (
    id         uuid primary key,
    created_at timestamptz not null default now(),
    first_name text not null default '',
    last_name  text not null default '',
    email      text not null,
    phone      text not null default '',
    topic      text not null default '',
    message    text not null
  );
`;

function fromPool(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (t, p) => client.query(t, p) });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function fromPGlite(pg) {
  return {
    query: (text, params) => pg.query(text, params),
    exec: (text) => pg.exec(text),
    tx: (fn) => pg.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
    close: () => pg.close(),
  };
}

function connect(connectionString) {
  const { Pool } = require("pg");
  // node-postgres already treats sslmode=require as full certificate
  // verification but warns about it; say so explicitly (Neon's certs verify).
  const url = new URL(connectionString);
  if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode"))) {
    url.searchParams.set("sslmode", "verify-full");
  }
  // Fail fast if the database can't be reached, rather than hanging startup.
  const pool = new Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 10000 });
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  return fromPool(pool);
}

async function migrate(db) {
  await db.exec(SCHEMA);
}

module.exports = { connect, fromPool, fromPGlite, migrate };
