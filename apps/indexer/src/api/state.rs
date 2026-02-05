use std::sync::Arc;
use std::time::Instant;

use crate::config::Config;
use crate::db::DbPool;

#[derive(Clone)]
pub struct AppState {
    pub pool: DbPool,
    pub config: Arc<Config>,
    pub start_time: Instant,
}

impl AppState {
    pub fn new(pool: DbPool, config: Config) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            start_time: Instant::now(),
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }
}
