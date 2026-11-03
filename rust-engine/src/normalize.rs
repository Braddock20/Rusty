use serde_json::Value;

pub fn text(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(x)=v.get(*k) {
            if let Some(s)=x.as_str() { if !s.is_empty() { return Some(s.to_string()); } }
            if x.is_number() { return Some(x.to_string()); }
        }
    }
    None
}

/// String-valued lookup only. Team names must never be taken from a numeric id field.
pub fn text_str(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(x)=v.get(*k) {
            if let Some(s)=x.as_str() { if !s.is_empty() { return Some(s.to_string()); } }
        }
    }
    None
}
pub fn fixture_id(v: &Value, keys: &[&str]) -> Option<String> { text(v,keys) }
pub fn walk_records(v: &Value) -> Vec<&Value> {
    for key in ["data","fixtures","results","items","matches","records"] {
        if let Some(a)=v.get(key).and_then(Value::as_array) { return a.iter().collect(); }
    }
    if let Some(a)=v.as_array() { return a.iter().collect(); }
    Vec::new()
}
pub fn looks_like_error(v: &Value) -> bool { v.get("error").is_some() }

/// LeagueRepublic nests fixtures under fixtureGroupList[].fixtures[], so the flat
/// top-level record walk found nothing and the collector ingested zero rows.
pub fn eal_fixture_rows(v: &Value) -> Vec<(&Value, &Value)> {
    let mut out = Vec::new();
    if let Some(groups) = v.get("fixtureGroupList").and_then(Value::as_array) {
        for g in groups {
            if let Some(fixtures) = g.get("fixtures").and_then(Value::as_array) {
                for f in fixtures { out.push((g, f)); }
            }
        }
    }
    out
}

/// Participant display name and explicit team id for one side of a GT fixture.
pub fn gt_side(v: &Value, side: &str) -> Option<(String, Option<String>)> {
    let parts = v.get("participants")?.as_array()?;
    for p in parts {
        let matches = p.get("side").and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case(side)).unwrap_or(false);
        if !matches { continue; }
        let participant = p.get("participant")?;
        let name = participant.get("player")
            .and_then(|pl| pl.get("nickname").or_else(|| pl.get("name")))
            .and_then(Value::as_str)
            .or_else(|| participant.get("team").and_then(|t| t.get("name")).and_then(Value::as_str))
            .map(|s| s.to_string());
        let team_id = participant.get("team").and_then(|t| t.get("id")).map(|v| v.to_string());
        return name.map(|n| (n, team_id));
    }
    None
}

/// GT keeps the score under result.stats.home_score / away_score.
pub fn gt_score(v: &Value, side: &str) -> Option<String> {
    let stats = v.get("result")?.get("stats")?;
    let key = if side == "home" { "home_score" } else { "away_score" };
    stats.get(key).map(|x| x.to_string())
}

/// GT football competitions are FIFA/FC sports tagged "soccer"; NBA 2k21 is basketball.
pub fn gt_is_soccer(v: &Value) -> bool {
    let category = v.get("season").and_then(|s| s.get("tournament")).and_then(|t| t.get("category"));
    let Some(category) = category else { return false; };
    let sport = category.get("sport");
    if let Some(tag) = sport.and_then(|s| s.get("tagId")).and_then(Value::as_str) {
        return tag.eq_ignore_ascii_case("soccer") || tag.eq_ignore_ascii_case("football");
    }
    let name = sport.and_then(|s| s.get("name")).and_then(Value::as_str).unwrap_or("").to_lowercase();
    if name.contains("nba") || name.contains("basketball") { return false; }
    if name.contains("fifa") || name.starts_with("fc") || name.contains("e-soccer") || name.contains("esoccer") {
        return true;
    }
    let category_name = category.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
    category_name.contains("e-sports") || category_name.contains("esports")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn league_republic_fixtures_are_nested_under_fixture_groups() {
        let hub = json!({
            "fixtureGroupList": [
                {"fixtureGroupDesc": "FC26 SEASON 11",
                 "fixtures": [{"fixtureID": 1}, {"fixtureID": 2}]},
                {"fixtureGroupDesc": "R511",
                 "fixtures": [{"fixtureID": 3}]}
            ]
        });
        let rows = eal_fixture_rows(&hub);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].1["fixtureID"], json!(1));
        assert_eq!(rows[2].0["fixtureGroupDesc"], json!("R511"));
    }

    #[test]
    fn team_names_are_never_taken_from_a_numeric_id_field() {
        let fixture = json!({"homeTeam": 928278216, "homeTeamName": "Dominic (Cyber esport)"});
        assert_eq!(text(&fixture, &["homeTeam", "homeTeamName"]), Some("928278216".into()));
        assert_eq!(text_str(&fixture, &["homeTeam", "homeTeamName"]), Some("Dominic (Cyber esport)".into()));
    }

    #[test]
    fn gt_football_is_accepted_and_basketball_is_rejected() {
        let football = json!({"season":{"tournament":{"category":{"name":"GT E-Sports G26","sport":{"id":1,"name":"FIFA20"}}}}});
        let basketball = json!({"season":{"tournament":{"category":{"name":"GT NBA","sport":{"id":2,"name":"NBA 2k21"}}}}});
        let tagged = json!({"season":{"tournament":{"category":{"sport":{"id":1,"name":"FC25","tagId":"soccer"}}}}});
        assert!(gt_is_soccer(&football));
        assert!(!gt_is_soccer(&basketball));
        assert!(gt_is_soccer(&tagged));
        assert!(!gt_is_soccer(&json!({})));
    }

    #[test]
    fn gt_participants_and_scores_are_read_from_the_nested_shape() {
        let fixture = json!({
            "status": 3,
            "result": {"stats": {"home_score": 2, "away_score": 1}},
            "participants": [
                {"side": "away", "participant": {"player": {"id": 20, "nickname": "val"}, "team": {"id": 19, "name": "AC Milan"}}},
                {"side": "home", "participant": {"player": {"id": 4, "nickname": "Samson"}, "team": {"id": 3, "name": "Chelsea"}}}
            ]
        });
        let (home, home_id) = gt_side(&fixture, "home").unwrap();
        assert_eq!(home, "Samson");
        assert_eq!(home_id, Some("3".into()));
        let (away, away_id) = gt_side(&fixture, "away").unwrap();
        assert_eq!(away, "val");
        assert_eq!(away_id, Some("19".into()));
        assert_eq!(gt_score(&fixture, "home"), Some("2".into()));
        assert_eq!(gt_score(&fixture, "away"), Some("1".into()));
    }

    #[test]
    fn top_level_record_walk_still_finds_flat_feeds() {
        assert_eq!(walk_records(&json!({"data": [1, 2]})).len(), 2);
        assert_eq!(walk_records(&json!([1, 2, 3])).len(), 3);
        assert_eq!(walk_records(&json!({"other": 1})).len(), 0);
    }
}
