use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum IndexerError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("pool error: {0}")]
    Pool(#[from] r2d2::Error),

    #[error("RPC error: {0}")]
    Rpc(#[from] alloy::transports::TransportError),

    #[error("config error: {0}")]
    Config(String),

    #[error("event decode error: {0}")]
    Decode(String),

    #[error("block not found: {0}")]
    BlockNotFound(u64),

    #[error("task join error: {0}")]
    Join(#[from] tokio::task::JoinError),
}

pub type Result<T> = std::result::Result<T, IndexerError>;
