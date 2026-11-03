use std::env;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub internal_token: String,
    pub eal_base: String,
    pub eal_season_ids: Vec<String>,
    pub eal_enabled: bool,
    pub eal_min_interval_ms: u64,
    pub gt_base: String,
    pub gt_origin: String,
    pub gt_referer: String,
    pub gt_enabled: bool,
    pub gt_page_size: usize,
    pub gt_max_pages: usize,
    pub gt_delay_ms: u64,
    pub betika_base: String,
    pub betika_enabled: bool,
    pub betika_limit: usize,
    pub betika_sport_id: String,
    pub betika_period_id: String,
}
fn val(k: &str, d: &str) -> String { env::var(k).unwrap_or_else(|_| d.into()) }
fn flag(k: &str, d: bool) -> bool { env::var(k).map(|v| v=="true" || v=="1").unwrap_or(d) }
fn num<T: std::str::FromStr>(k: &str, d: &str) -> T where T::Err: std::fmt::Debug { val(k,d).parse().expect("invalid numeric env var") }

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let db = val("DATABASE_URL", "");
        let token = val("INTERNAL_TOKEN", "");
        anyhow::ensure!(!db.is_empty(), "DATABASE_URL is required");
        anyhow::ensure!(!token.is_empty(), "INTERNAL_TOKEN is required");
        Ok(Self {
            port: num("PORT","8080"), database_url: db, internal_token: token,
            eal_base: val("EAL_API_BASE","https://api.leaguerepublic.com/json"),
            eal_season_ids: val("EAL_SEASON_IDS","").split(',').filter(|x| !x.trim().is_empty()).map(|x|x.trim().into()).collect(),
            eal_enabled: flag("EAL_ENABLED",true), eal_min_interval_ms: num("EAL_MIN_INTERVAL_MS","2200"),
            gt_base: val("GT_API_BASE","https://api.gtleagues.com/api"),
            gt_origin: val("GT_ORIGIN","https://www.gtleagues.com"), gt_referer: val("GT_REFERER","https://www.gtleagues.com/"),
            gt_enabled: flag("GT_ENABLED",true), gt_page_size: num::<usize>("GT_PAGE_SIZE","200").min(200).max(1),
            gt_max_pages: num("GT_MAX_PAGES_PER_RUN","10"), gt_delay_ms: num("GT_DELAY_MS","1100"),
            betika_base: val("BETIKA_API_BASE","https://api.betika.com/v1/uo/matches"),
            betika_enabled: flag("BETIKA_ENABLED",true), betika_limit: num("BETIKA_LIMIT","200"),
            betika_sport_id: val("BETIKA_SPORT_ID","105"), betika_period_id: val("BETIKA_PERIOD_ID","-1"),
        })
    }
}
