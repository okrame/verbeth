use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

use crate::db::models::EventCounts;
use crate::db::queries::{get_event_counts, get_last_processed_block};

use super::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub last_block: Option<i64>,
    pub uptime_seconds: u64,
    pub counts: EventCountsResponse,
}

#[derive(Serialize)]
pub struct EventCountsResponse {
    pub messages: i64,
    pub handshakes: i64,
    pub handshake_responses: i64,
}

impl From<EventCounts> for EventCountsResponse {
    fn from(c: EventCounts) -> Self {
        Self {
            messages: c.messages,
            handshakes: c.handshakes,
            handshake_responses: c.handshake_responses,
        }
    }
}

pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, StatusCode> {
    let conn = state.pool.get().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    let last_block = get_last_processed_block(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let counts = get_event_counts(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let status = if last_block.is_some() { "ok" } else { "syncing" };

    Ok(Json(HealthResponse {
        status,
        last_block,
        uptime_seconds: state.uptime_seconds(),
        counts: counts.into(),
    }))
}
