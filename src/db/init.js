// src/db/init.js — создаёт таблицы при первом запуске
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function init() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        username      TEXT NOT NULL,
        tokens_balance BIGINT DEFAULT 0,
        tokens_used    BIGINT DEFAULT 0,
        own_api_key   TEXT DEFAULT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
        yookassa_id     TEXT UNIQUE,
        amount_rub      NUMERIC(10,2) NOT NULL,
        tokens_granted  BIGINT NOT NULL,
        status          TEXT DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        paid_at         TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS saves (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        slot       INT NOT NULL CHECK (slot >= 0 AND slot < 10),
        name       TEXT NOT NULL,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, slot)
      );

      CREATE TABLE IF NOT EXISTS token_log (
        id         BIGSERIAL PRIMARY KEY,
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        tokens_in  INT DEFAULT 0,
        tokens_out INT DEFAULT 0,
        model      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_saves_user ON saves(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_token_log_user ON token_log(user_id);

      -- Миграция: добавить own_api_key если таблица уже существовала
      ALTER TABLE users ADD COLUMN IF NOT EXISTS own_api_key TEXT DEFAULT NULL;
    `);
    console.log('✅ База данных инициализирована');
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch(e => { console.error('❌ Ошибка инициализации БД:', e.message); process.exit(1); });

module.exports = pool;
