use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::Path;

use crate::error::Result;

pub mod models;
pub mod queries;
pub mod schema;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn create_pool(database_path: &str) -> Result<DbPool> {
    if let Some(parent) = Path::new(database_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let manager = SqliteConnectionManager::file(database_path);
    let pool = Pool::builder().max_size(4).build(manager)?;

    let conn = pool.get()?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;",
    )?;

    schema::run_migrations(&conn)?;

    Ok(pool)
}
