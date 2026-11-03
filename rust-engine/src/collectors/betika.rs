use crate::{AppState, db, normalize};
use super::Outcome;
use serde_json::Value;

pub async fn collect(s: &AppState, run_id: i64) -> Outcome {
    let url=format!("{}?page=1&limit={}&sport_id={}&period_id={}",
        s.cfg.betika_base,s.cfg.betika_limit,s.cfg.betika_sport_id,s.cfg.betika_period_id);
    let result=async {
        let r=s.client.get(&url).send().await?;
        let status=r.status();
        let body=r.text().await?;
        anyhow::ensure!(status.is_success(),"Betika HTTP {}: {}",status,body.chars().take(250).collect::<String>());
        let v:Value=serde_json::from_str(&body)?;
        db::save_raw(&s.pool,run_id,"betika","matches",None,&v).await?;
        let rows=normalize::walk_records(&v);
        let mut n=0;
        for row in rows {
            if let Some(id)=normalize::fixture_id(row,&["match_id","game_id","id"]) {
                let hs=normalize::text(row,&["home_score","homeScore"]);
                let as_=normalize::text(row,&["away_score","awayScore"]);
                db::save_fixture(&s.pool,"betika",&id,
                    normalize::text(row,&["competition_name","category"]).as_deref(),
                    normalize::text(row,&["home_team"]).as_deref(),normalize::text(row,&["away_team"]).as_deref(),
                    normalize::text(row,&["start_time"]).as_deref(),None,hs.as_deref(),as_.as_deref(),None,None,row).await?;
                if let Some(odds)=row.get("odds").and_then(Value::as_array) {
                    for odd in odds {
                        let mut item=odd.clone();
                        if let Some(obj)=item.as_object_mut() {
                            obj.insert("market".into(),Value::String(normalize::text(odd,&["name","sub_type_name","sub_type_id"]).unwrap_or_else(||"unknown".into())));
                            obj.insert("selection".into(),Value::String(normalize::text(odd,&["odd_key","display"]).unwrap_or_else(||"unknown".into())));
                        }
                        db::save_odds(&s.pool,&id,&item).await?;
                    }
                }
                n+=1;
            }
        }
        Ok::<usize,anyhow::Error>(n)
    }.await;
    match result {
        Ok(n)=>Outcome{source:"betika".into(),ok:true,records:n,message:"current eSoccer feed and available odds collected; not a historical results endpoint".into()},
        Err(e)=>Outcome{source:"betika".into(),ok:false,records:0,message:e.to_string()}
    }
}
