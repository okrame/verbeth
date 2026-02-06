use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::Path;

use crate::error::Result;

pub mod models;
pub mod queries;
pub mod schema;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn create_pool(database_path: &str, sync_mode: &str) -> Result<DbPool> {
    if let Some(parent) = Path::new(database_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let manager = SqliteConnectionManager::file(database_path);
    let pool = Pool::builder().max_size(4).build(manager)?;

    let conn = pool.get()?;
    let pragmas = format!(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous={}; PRAGMA foreign_keys=ON;",
        sync_mode
    );
    conn.execute_batch(&pragmas)?;

    tracing::info!("SQLite initialized with synchronous={}", sync_mode);

    schema::run_migrations(&conn)?;

    Ok(pool)
}
