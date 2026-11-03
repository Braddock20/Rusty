use axum::{extract::{Query,State}, Json};
use serde::Deserialize;
use serde_json::{json,Value};
use crate::AppState;

pub async fn health(State(s):State<AppState>)->Json<Value>{
    let db=sqlx::query_scalar::<_,i32>("SELECT 1").fetch_one(&s.pool).await.is_ok();
    Json(json!({"ok":db,"database":if db {"reachable"} else {"unavailable"}}))
}
#[derive(Deserialize)]
pub struct Q { pub source:Option<String>, pub limit:Option<i64> }
pub async fn fixtures(State(s):State<AppState>,Query(q):Query<Q>)->Json<Value>{
    let limit=q.limit.unwrap_or(100).clamp(1,500);
    let rows=sqlx::query_as::<_,(String,String,Option<String>,Option<String>,Option<String>,Option<String>)>(
        "SELECT source,external_id,competition,home_name,away_name,kickoff_raw FROM fixtures WHERE ($1::text IS NULL OR source=$1) ORDER BY updated_at DESC LIMIT $2")
        .bind(q.source).bind(limit).fetch_all(&s.pool).await.unwrap_or_default();
    let data:Vec<Value>=rows.into_iter().map(|r|json!({"source":r.0,"external_id":r.1,"competition":r.2,"home":r.3,"away":r.4,"kickoff":r.5})).collect();
    Json(json!({"count":data.len(),"fixtures":data}))
}
pub async fn runs(State(s):State<AppState>)->Json<Value>{
    let rows=sqlx::query_as::<_,(i64,String,chrono::DateTime<chrono::Utc>,Option<chrono::DateTime<chrono::Utc>>,Option<Value>)>(
        "SELECT id,status,started_at,finished_at,summary FROM collection_runs ORDER BY id DESC LIMIT 50")
        .fetch_all(&s.pool).await.unwrap_or_default();
    let data:Vec<Value>=rows.into_iter().map(|r|json!({"id":r.0,"status":r.1,"started_at":r.2,"finished_at":r.3,"summary":r.4})).collect();
    Json(json!({"runs":data}))
}
