"""SQLite + migrasi berversi. Tidak ada kolom password/token — hanya referensi rahasia (secure_secret_ref)."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterable, Optional

from .util import now, redact

MIGRATIONS = [
    # ---- v1 ----
    """
    CREATE TABLE allowed_sources(
        id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL,
        domain TEXT NOT NULL,
        permission_note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(platform, domain)
    );
    CREATE TABLE collections(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        source_job_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
    );
    CREATE TABLE scrape_jobs(
        id INTEGER PRIMARY KEY,
        source_platform TEXT NOT NULL,
        input_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_limit INTEGER,
        filters_json TEXT NOT NULL DEFAULT '{}',
        inputs_json TEXT NOT NULL DEFAULT '{}',
        options_json TEXT NOT NULL DEFAULT '{}',
        collection_id INTEGER REFERENCES collections(id),
        checkpoint_json TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_by TEXT DEFAULT 'local',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_summary TEXT
    );
    CREATE TABLE scrape_job_items(
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES scrape_jobs(id),
        input_url TEXT,
        product_url TEXT,
        canonical_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message_safe TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(job_id, canonical_id)
    );
    CREATE TABLE products(
        id INTEGER PRIMARY KEY,
        source_platform TEXT NOT NULL,
        source_product_id TEXT NOT NULL,
        source_url TEXT,
        title_original TEXT NOT NULL,
        description_original TEXT DEFAULT '',
        title_edited TEXT,
        description_edited TEXT,
        brand TEXT,
        source_category_path TEXT,
        price_original REAL,
        currency TEXT DEFAULT 'IDR',
        stock_original INTEGER,
        source_hash TEXT NOT NULL,
        raw_data_json TEXT NOT NULL,
        rights_status TEXT NOT NULL DEFAULT 'unverified',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_platform, source_product_id)
    );
    CREATE TABLE product_variants(
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        source_variant_id TEXT,
        option_values_json TEXT NOT NULL DEFAULT '{}',
        sku_source TEXT,
        price_original REAL,
        price_target REAL,
        stock_original INTEGER,
        weight_gram INTEGER
    );
    CREATE TABLE product_images(
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        local_path TEXT,
        sha256 TEXT,
        rights_status TEXT NOT NULL DEFAULT 'unverified',
        sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE collection_products(
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        selected INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY(collection_id, product_id)
    );
    CREATE TABLE product_edits(
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        before_value TEXT,
        after_value TEXT,
        rules_version TEXT,
        actor TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE category_mappings(
        id INTEGER PRIMARY KEY,
        source_platform TEXT NOT NULL,
        source_category TEXT NOT NULL,
        target_platform TEXT NOT NULL,
        target_category_id TEXT,
        target_category_label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE(source_platform, source_category, target_platform)
    );
    CREATE TABLE store_connections(
        id INTEGER PRIMARY KEY,
        target_platform TEXT NOT NULL,
        label TEXT NOT NULL,
        external_shop_id TEXT,
        auth_method TEXT NOT NULL DEFAULT 'none',
        secure_secret_ref TEXT,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        connection_status TEXT NOT NULL DEFAULT 'unvalidated',
        created_at TEXT NOT NULL,
        last_validated_at TEXT
    );
    CREATE TABLE upload_batches(
        id INTEGER PRIMARY KEY,
        collection_id INTEGER NOT NULL REFERENCES collections(id),
        target_platform TEXT NOT NULL,
        store_connection_id INTEGER REFERENCES store_connections(id),
        status TEXT NOT NULL,
        selection_json TEXT NOT NULL DEFAULT '{}',
        config_json TEXT NOT NULL DEFAULT '{}',
        preview_json TEXT,
        preview_hash TEXT,
        idempotency_key TEXT UNIQUE,
        requested_by TEXT DEFAULT 'local',
        confirmed_by TEXT,
        confirmed_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        finished_at TEXT
    );
    CREATE TABLE upload_items(
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        item_key TEXT NOT NULL,
        target_product_id TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        validation_errors_json TEXT NOT NULL DEFAULT '[]',
        target_response_code TEXT,
        safe_response_message TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, product_id)
    );
    CREATE TABLE job_events(
        id INTEGER PRIMARY KEY,
        job_type TEXT NOT NULL,
        job_id INTEGER,
        severity TEXT NOT NULL,
        event_code TEXT NOT NULL,
        message_redacted TEXT,
        details_json TEXT,
        timestamp TEXT NOT NULL
    );
    CREATE INDEX idx_events_job ON job_events(job_type, job_id);
    CREATE INDEX idx_cp_collection ON collection_products(collection_id);
    CREATE INDEX idx_items_job ON scrape_job_items(job_id);
    CREATE INDEX idx_uitems_batch ON upload_items(batch_id);
    """,
    # ---- v2: alur ala Qlobot (staging grab -> Save to Collections, metrik produk, Collection Settings) ----
    """
    ALTER TABLE products ADD COLUMN sold_count INTEGER;
    ALTER TABLE products ADD COLUMN rating REAL;
    ALTER TABLE products ADD COLUMN review_count INTEGER;
    ALTER TABLE products ADD COLUMN view_count INTEGER;
    ALTER TABLE products ADD COLUMN price_before_discount REAL;
    ALTER TABLE scrape_jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE collections ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE app_settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    """,
    # ---- v3: daftar kategori marketplace + saran otomatis, harga kompetitor, hasil pemeriksaan/olah gambar ----
    """
    ALTER TABLE category_mappings ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE category_mappings ADD COLUMN confidence REAL;
    CREATE TABLE marketplace_categories(
        marketplace TEXT NOT NULL,
        category_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY(marketplace, category_id)
    );
    CREATE TABLE competitor_prices(
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        price REAL NOT NULL,
        url TEXT,
        noted_at TEXT NOT NULL,
        PRIMARY KEY(product_id, label)
    );
    CREATE TABLE image_assets(
        image_id INTEGER PRIMARY KEY REFERENCES product_images(id) ON DELETE CASCADE,
        marketplace TEXT NOT NULL,
        local_path TEXT,
        width INTEGER, height INTEGER, bytes INTEGER,
        status TEXT NOT NULL,
        flags_json TEXT NOT NULL DEFAULT '[]',
        checked_by TEXT,
        updated_at TEXT NOT NULL
    );
    """,
    # ---- v4: edit stok (nilai asli tidak diubah) ----
    """
    ALTER TABLE products ADD COLUMN stock_edited INTEGER;
    ALTER TABLE product_variants ADD COLUMN stock_edited INTEGER;
    """,
    # ---- v5: foto per varian ----
    """
    ALTER TABLE product_variants ADD COLUMN image_url TEXT;
    """,
]


class DB:
    """Pembungkus sqlite3 yang aman antar-thread (satu koneksi + RLock)."""

    def __init__(self, path: str = ":memory:"):
        self.path = path
        self._backup_if_needed()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        if path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.lock = threading.RLock()
        self._migrate()

    # -- migrasi ---------------------------------------------------------
    def _current_version(self, conn: sqlite3.Connection) -> int:
        return conn.execute("PRAGMA user_version").fetchone()[0]

    def _backup_if_needed(self) -> None:
        if self.path == ":memory:" or not os.path.exists(self.path):
            return
        probe = sqlite3.connect(self.path)
        try:
            version = self._current_version(probe)
        finally:
            probe.close()
        if 0 < version < len(MIGRATIONS):
            shutil.copy2(self.path, f"{self.path}.bak-v{version}")

    def _migrate(self) -> None:
        with self.lock:
            version = self._current_version(self.conn)
            for i in range(version, len(MIGRATIONS)):
                self.conn.executescript(MIGRATIONS[i])
                self.conn.execute(f"PRAGMA user_version={i + 1}")
            self.conn.commit()

    @property
    def version(self) -> int:
        return self._current_version(self.conn)

    # -- akses -----------------------------------------------------------
    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self.lock:
            cur = self.conn.execute(sql, tuple(params))
            self.conn.commit()
            return cur

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    @contextmanager
    def tx(self):
        """Transaksi atomik; semua perubahan dibatalkan jika terjadi exception."""
        with self.lock:
            try:
                self.conn.execute("BEGIN")
                yield self.conn
                self.conn.commit()
            except BaseException:
                self.conn.rollback()
                raise

    # -- log -------------------------------------------------------------
    def event(self, job_type: str, job_id: Optional[int], severity: str, code: str,
              message: str = "", details: Optional[dict] = None) -> None:
        safe_details = redact(json.dumps(details, ensure_ascii=False), 2000) if details else None
        self.execute(
            "INSERT INTO job_events(job_type, job_id, severity, event_code, message_redacted, details_json, timestamp)"
            " VALUES(?,?,?,?,?,?,?)",
            (job_type, job_id, severity, code, redact(message), safe_details, now()),
        )

    def close(self) -> None:
        with self.lock:
            self.conn.close()
