use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};

pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    Ok(PgPoolOptions::new().max_connections(8).connect(url).await?)
}
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    // Apply the same additive migration set the Worker relies on. Every statement is
    // idempotent, so re-running against an already migrated database is safe.
    for statement in [
        include_str!("../migrations/0001_init.sql"),
        include_str!("../migrations/0002_worker_collection.sql"),
        include_str!("../migrations/0003_prediction_engine.sql"),
        include_str!("../migrations/0004_intelligence_foundation.sql"),
        include_str!("../migrations/0005_collection_reliability.sql"),
        include_str!("../migrations/0006_production_hardening.sql"),
    ] {
        sqlx::raw_sql(statement).execute(pool).await?;
    }
    Ok(())
}
pub async fn start_run(pool: &PgPool) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("INSERT INTO collection_runs(status) VALUES('running') RETURNING id")
        .fetch_one(pool).await?)
}
pub async fn finish_run(pool: &PgPool, id: i64, status: &str, outcome: &Vec<crate::collectors::Outcome>) -> anyhow::Result<()> {
    let v = serde_json::to_value(outcome)?;
    sqlx::query("UPDATE collection_runs SET finished_at=now(), status=$2, summary=$3 WHERE id=$1")
        .bind(id).bind(status).bind(v).execute(pool).await?;
    Ok(())
}
pub async fn save_raw(pool: &PgPool, run_id: i64, source: &str, dataset: &str, external_id: Option<&str>, payload: &Value) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO raw_snapshots(run_id,source,dataset,external_id,payload) VALUES($1,$2,$3,$4,$5)")
        .bind(run_id).bind(source).bind(dataset).bind(external_id).bind(payload)
        .execute(pool).await?;
    Ok(())
}
pub async fn save_fixture(pool: &PgPool, source: &str, id: &str, competition: Option<&str>, home: Option<&str>, away: Option<&str>, kickoff: Option<&str>, status: Option<&str>, hs: Option<&str>, as_: Option<&str>, home_team_id: Option<&str>, away_team_id: Option<&str>, payload: &Value) -> anyhow::Result<()> {
    sqlx::query(r#"INSERT INTO fixtures(source,external_id,competition,home_name,away_name,kickoff_raw,status_raw,home_score_raw,away_score_raw,payload,home_team_external_id,away_team_external_id,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      ON CONFLICT(source,external_id) DO UPDATE SET competition=EXCLUDED.competition,home_name=EXCLUDED.home_name,away_name=EXCLUDED.away_name,kickoff_raw=EXCLUDED.kickoff_raw,status_raw=EXCLUDED.status_raw,home_score_raw=EXCLUDED.home_score_raw,away_score_raw=EXCLUDED.away_score_raw,payload=EXCLUDED.payload,home_team_external_id=COALESCE(EXCLUDED.home_team_external_id,fixtures.home_team_external_id),away_team_external_id=COALESCE(EXCLUDED.away_team_external_id,fixtures.away_team_external_id),updated_at=now()"#)
      .bind(source).bind(id).bind(competition).bind(home).bind(away).bind(kickoff).bind(status).bind(hs).bind(as_)
      .bind(payload).bind(home_team_id).bind(away_team_id)
      .execute(pool).await?;
    Ok(())
}
pub async fn save_score(pool: &PgPool, source: &str, id: &str, status: Option<&str>, hs: Option<&str>, as_: Option<&str>, payload: &Value) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO score_observations(source,external_id,status_raw,home_score_raw,away_score_raw,payload) VALUES($1,$2,$3,$4,$5,$6)")
      .bind(source).bind(id).bind(status).bind(hs).bind(as_).bind(payload).execute(pool).await?;
    Ok(())
}
pub async fn save_odds(pool: &PgPool, id: &str, payload: &Value) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO odds_observations(source,external_fixture_id,market,selection,odds_raw,payload) VALUES('betika',$1,$2,$3,$4,$5)")
      .bind(id).bind(payload.get("market").and_then(Value::as_str).unwrap_or("unknown"))
      .bind(payload.get("selection").and_then(Value::as_str).unwrap_or("unknown"))
      .bind(payload.get("odd_value").map(|v|v.to_string()).unwrap_or_default())
      .bind(payload).execute(pool).await?;
    Ok(())
}
