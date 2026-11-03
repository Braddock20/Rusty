use crate::{AppState, db, normalize};
use super::Outcome;
use serde_json::Value;
use std::time::Duration;

async fn get_json(s: &AppState, url: &str) -> anyhow::Result<Value> {
    let r=s.client.get(url).send().await?;
    let status=r.status();
    let body=r.text().await?;
    anyhow::ensure!(status.is_success(), "EAL HTTP {}: {}", status, body.chars().take(300).collect::<String>());
    let v:Value=serde_json::from_str(&body)?;
    anyhow::ensure!(!normalize::looks_like_error(&v), "EAL API error payload: {}", v);
    Ok(v)
}
pub async fn collect(s: &AppState, run_id: i64) -> Outcome {
    let mut total=0usize;
    let mut errs=Vec::new();
    for season in &s.cfg.eal_season_ids {
        // Season-addressable match hub returns fixtures, seasonList and live/unapproved records.
        let url=format!("{}/getMatchHub/{}.json",s.cfg.eal_base.trim_end_matches('/'),season);
        match get_json(s,&url).await {
            Ok(v)=>{
                if let Err(e)=db::save_raw(&s.pool,run_id,"eadriatic","match_hub",Some(season),&v).await { errs.push(e.to_string()); continue; }
                // LeagueRepublic nests fixtures under fixtureGroupList[].fixtures[].
                let rows = normalize::eal_fixture_rows(&v);
                if rows.is_empty() {
                    errs.push(format!("season {season}: no fixtures found in the match hub payload"));
                }
                for (group,row) in rows {
                    let id=normalize::fixture_id(row,&["fixtureID","fixtureId","id","matchID"]).unwrap_or_else(||format!("{}-{}",season,total));
                    let hs=normalize::text(row,&["homeScore","home_score"]);
                    let as_=normalize::text(row,&["roadScore","awayScore","away_score"]);
                    // Names come from the *_TeamName fields; homeTeam/roadTeam are numeric ids.
                    let home=normalize::text_str(row,&["homeTeamName","homeName"]);
                    let away=normalize::text_str(row,&["roadTeamName","awayName"]);
                    let competition=normalize::text_str(group,&["fixtureGroupDesc","fixtureGroupName","fixtureGroupDescription"]);
                    // fixtureDate is a timezone-less local string; the epoch field is unambiguous.
                    let kickoff=normalize::text(row,&["fixtureDateInMilliseconds","fixtureDate"]);
                    let status=normalize::text_str(row,&["fixtureStatusDesc","fixtureDateStatusDesc","fixtureStatus"]);
                    let home_id=normalize::text(row,&["homeTeam","homeTeamID"]);
                    let away_id=normalize::text(row,&["roadTeam","roadTeamID"]);
                    if let Err(e)=db::save_fixture(&s.pool,"eadriatic",&id,
                        competition.as_deref(),home.as_deref(),away.as_deref(),
                        kickoff.as_deref(),status.as_deref(),hs.as_deref(),as_.as_deref(),
                        home_id.as_deref(),away_id.as_deref(),row).await {
                        errs.push(format!("{id}: {e}"));
                        continue;
                    }
                    if let Err(e)=db::save_score(&s.pool,"eadriatic",&id,
                        status.as_deref(),hs.as_deref(),as_.as_deref(),row).await {
                        errs.push(format!("{id}: {e}"));
                        continue;
                    }
                    total+=1;
                }
            },
            Err(e)=>errs.push(format!("season {season}: {e}"))
        }
        tokio::time::sleep(Duration::from_millis(s.cfg.eal_min_interval_ms)).await;
    }
    Outcome{source:"eadriatic".into(),ok:errs.is_empty(),records:total,message:if errs.is_empty(){"match hub collected".into()}else{errs.join(" | ")}}
}
