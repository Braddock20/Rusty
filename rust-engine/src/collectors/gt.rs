use crate::{AppState, db, normalize};
use super::Outcome;
use serde_json::Value;
use std::time::Duration;

pub async fn collect(s: &AppState, run_id: i64) -> Outcome {
    let mut total=0usize;
    let mut errors=Vec::new();
    // Broad fixture feed; keep each run bounded. Increase MAX_PAGES only after verifying load.
    for page in 0..s.cfg.gt_max_pages {
        let offset=page*s.cfg.gt_page_size;
        let url=format!("{}/fixtures?offset={}&limit={}&xtc=true",s.cfg.gt_base.trim_end_matches('/'),offset,s.cfg.gt_page_size);
        let response=s.client.get(&url).header("Origin",&s.cfg.gt_origin).header("Referer",&s.cfg.gt_referer)
            .header("Accept","application/json, text/plain, */*").send().await;
        let response=match response {Ok(r)=>r,Err(e)=>{errors.push(e.to_string());break;}};
        let status=response.status();
        let body=match response.text().await {Ok(b)=>b,Err(e)=>{errors.push(e.to_string());break;}};
        if status.as_u16()!=200 { errors.push(format!("GT HTTP {}: {}",status,body.chars().take(250).collect::<String>())); break; }
        let v:Value=match serde_json::from_str(&body){Ok(v)=>v,Err(e)=>{errors.push(e.to_string());break;}};
        let rows=normalize::walk_records(&v);
        if rows.is_empty() { break; }
        if let Err(e)=db::save_raw(&s.pool,run_id,"gt","fixtures_page",Some(&offset.to_string()),&v).await { errors.push(e.to_string());break; }
        let n=rows.len();
        for row in rows {
            let id=normalize::fixture_id(row,&["id","fixtureId","fixture_id","_id"]).unwrap_or_else(||format!("offset-{offset}-row-{total}"));
            let hs=normalize::text(row,&["homeScore","home_score","scoreHome"]);
            let as_=normalize::text(row,&["awayScore","away_score","scoreAway"]);
            let _=db::save_fixture(&s.pool,"gt",&id,
                normalize::text(row,&["seasonName","competition","sportName"]).as_deref(),
                normalize::text(row,&["homePlayerName","homeTeamName","home","player1"]).as_deref(),
                normalize::text(row,&["awayPlayerName","awayTeamName","away","player2"]).as_deref(),
                normalize::text(row,&["kickoff","date","startTime"]).as_deref(),
                normalize::text(row,&["status","fixtureStatus"]).as_deref(),
                hs.as_deref(),as_.as_deref(),row).await;
            let _=db::save_score(&s.pool,"gt",&id,normalize::text(row,&["status","fixtureStatus"]).as_deref(),hs.as_deref(),as_.as_deref(),row).await;
            total+=1;
        }
        if n<s.cfg.gt_page_size { break; }
        tokio::time::sleep(Duration::from_millis(s.cfg.gt_delay_ms)).await;
    }
    Outcome{source:"gt".into(),ok:errors.is_empty(),records:total,message:if errors.is_empty(){"bounded fixture pages collected".into()}else{errors.join(" | ")}}
}
