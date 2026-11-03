#[derive(thiserror::Error, Debug)]
pub enum EngineError {
    #[error("upstream HTTP {status}: {body}")]
    Upstream { status: u16, body: String },
    #[error("database: {0}")]
    Database(#[from] sqlx::Error),
    #[error("HTTP: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}
pub type Result<T> = std::result::Result<T, EngineError>;
