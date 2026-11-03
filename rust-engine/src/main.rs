mod api;
mod collectors;
mod config;
mod db;
mod error;
mod normalize;

use axum::{extract::State, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{error, info};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<config::Config>,
    pub pool: sqlx::PgPool,
    pub client: reqwest::Client,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter(
        std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into())
    ).init();

    let cfg = Arc::new(config::Config::from_env()?);
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("EsportsDataEngine/0.1 (+respectful public-data collector)")
        .build()?;

    let state = AppState { cfg: cfg.clone(), pool, client };
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"ok":true,"service":"rust-engine"})) }))
        .route("/health/db", get(health_db))
        .route("/internal/collect", post(collect))
        .route("/api/v1/health", get(api::health))
        .route("/api/v1/fixtures", get(api::fixtures))
        .route("/api/v1/runs", get(api::runs))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("0.0.0.0:{}", cfg.port).parse()?;
    info!("listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_db(State(s): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&s.pool).await {
        Ok(_) => (StatusCode::OK, Json(json!({"ok":true,"database":"reachable"}))),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok":false,"error":e.to_string()}))),
    }
}

async fn collect(State(s): State<AppState>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    let expected = format!("Bearer {}", s.cfg.internal_token);
    if headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok":false,"error":"unauthorized"})));
    }
    let run_id = match db::start_run(&s.pool).await {
        Ok(id) => id,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok":false,"error":e.to_string()}))),
    };
    let mut outcomes = Vec::new();
    if s.cfg.eal_enabled {
        outcomes.push(collectors::eal::collect(&s, run_id).await);
    }
    if s.cfg.gt_enabled {
        outcomes.push(collectors::gt::collect(&s, run_id).await);
    }
    if s.cfg.betika_enabled {
        outcomes.push(collectors::betika::collect(&s, run_id).await);
    }
    let failures = outcomes.iter().filter(|o| !o.ok).count();
    let status = if failures == 0 { "success" } else if failures == outcomes.len() { "failed" } else { "partial" };
    if let Err(e) = db::finish_run(&s.pool, run_id, status, &outcomes).await {
        error!("failed to finalize run: {e}");
    }
    // With no collector enabled there is nothing to report as a successful run.
    if outcomes.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok":false,"run_id":run_id,"error":"NO_SOURCES_CONFIGURED","sources":outcomes})));
    }
    let code = if failures == outcomes.len() { StatusCode::BAD_GATEWAY } else { StatusCode::OK };
    (code, Json(json!({"ok":failures==0,"run_id":run_id,"status":status,"sources":outcomes})))
}


