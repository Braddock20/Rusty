/**
 * Upstream provider payloads that mirror the real API shapes exactly.
 * Verified live against api.gtleagues.com, api.leaguerepublic.com and api.betika.com.
 */

export const EAL_SEASON_ID = "656829288";

export function ealMatchHub() {
  return {
    seasonID: 656829288,
    seasonList: [{ seasonID: 656829288, seasonName: "FC26 SEASON 11" }],
    fixtureGroupList: [
      {
        fixtureGroupDesc: "FC26 SEASON 11",
        fixtureGroupIdentifier: 380566548,
        fixtureTypeID: 1,
        fixtures: [
          {
            fixtureID: 45539806,
            fixtureDate: "20261016 00:00",
            fixtureDateInMilliseconds: 1792105200000,
            fixtureStatus: 0,
            fixtureStatusDesc: "Normal",
            fixtureDateStatusDesc: "Normal / Scheduled",
            homeTeam: 928278216,
            homeTeamName: "Dominic (Cyber esport)",
            roadTeam: 724171548,
            roadTeamName: "Dexter (Eadriatic esport)",
            homeScore: "0",
            roadScore: "0",
            result: false,
            approved: true,
          },
          {
            fixtureID: 45179477,
            fixtureDate: "20260916 07:00",
            fixtureDateInMilliseconds: 1789538400000,
            fixtureStatus: 0,
            fixtureStatusDesc: "Normal",
            fixtureDateStatusDesc: "Normal / Scheduled",
            homeTeam: 199114147,
            homeTeamName: "Kai (Modrica esport)",
            roadTeam: 199114148,
            roadTeamName: "Rex (Eadriatic esport)",
            homeScore: "4",
            roadScore: "3",
            result: true,
            approved: true,
          },
          {
            fixtureID: 45179999,
            fixtureDate: "20260917 07:00",
            fixtureDateInMilliseconds: 1789624800000,
            fixtureStatus: 1,
            fixtureStatusDesc: "Cancelled",
            fixtureDateStatusDesc: "Normal / Scheduled",
            homeTeam: 199114149,
            homeTeamName: "Cancelled (Eadriatic esport)",
            roadTeam: 199114150,
            roadTeamName: "Other (Eadriatic esport)",
            homeScore: null,
            roadScore: null,
            result: false,
            approved: false,
          },
        ],
        standings: {
          standingsDesc: "FC26 SEASON 11",
          standingsLines: [
            {
              teamID: 928278216,
              teamName: "Dominic (Cyber esport)",
              position: 1,
              points: 96,
              overallPlayed: 310,
              overallWon: 96,
              overallTied: 19,
              overallLoss: 85,
              overallScoreFor: 605,
              overallScoreAgainst: 440,
              overallWinPercentage: 30.96,
              recentForm: "WDWWLWLWLW",
            },
          ],
        },
      },
    ],
  };
}

export function gtSports() {
  return [
    { id: 1, name: "FIFA20", tagId: "soccer" },
    { id: 2, name: "NBA 2k21", tagId: "basketball" },
    { id: 3, name: "FIFA21", tagId: "soccer" },
    { id: 4, name: "FIFA22", tagId: "soccer" },
    { id: 5, name: "FIFA23", tagId: "soccer" },
    { id: 6, name: "FC25", tagId: "soccer" },
  ];
}

export function gtSeasons() {
  return {
    data: [
      {
        id: 55,
        name: "eSoccer League",
        tournament: { category: { id: 1, name: "GT E-Sports G26", sport: { id: 1, name: "FIFA20" } } },
      },
    ],
  };
}

export function gtFixtures() {
  const season = {
    id: 55,
    name: "eSoccer League",
    status: 3,
    tournament: {
      id: 1,
      name: "Vol 1",
      category: { id: 1, name: "GT E-Sports G26", sportId: 1, sport: { id: 1, name: "FIFA20" } },
    },
  };
  return [
    {
      id: 9001,
      kickoff: "2026-11-20T20:00:00.000Z",
      status: 0,
      season,
      participants: [
        { id: "1", side: "home", participant: { id: "4", player: { id: 1001, name: " ", nickname: "Alpha" }, team: { id: 701, name: "Team Red", tagId: "soccer" } } },
        { id: "2", side: "away", participant: { id: "19", player: { id: 1002, name: " ", nickname: "Beta" }, team: { id: 702, name: "Team Blue", tagId: "soccer" } } },
      ],
      result: null,
    },
    {
      id: 9002,
      kickoff: "2026-11-05T20:00:00.000Z",
      status: 3,
      season,
      participants: [
        { id: "1", side: "home", participant: { id: "4", player: { id: 1001, name: " ", nickname: "Alpha" }, team: { id: 701, name: "Team Red", tagId: "soccer" } } },
        { id: "2", side: "away", participant: { id: "19", player: { id: 1002, name: " ", nickname: "Beta" }, team: { id: 702, name: "Team Blue", tagId: "soccer" } } },
      ],
      result: { id: "9002", stats: { home_score: 2, away_score: 0 } },
    },
    {
      id: 9003,
      kickoff: "2026-11-04T20:00:00.000Z",
      status: 3,
      season,
      participants: [
        { id: "1", side: "home", participant: { id: "5", player: { id: 1003, name: " ", nickname: "Gamma" }, team: { id: 703, name: "Team Green", tagId: "soccer" } } },
        { id: "2", side: "away", participant: { id: "20", player: { id: 1004, name: " ", nickname: "Delta" }, team: { id: 704, name: "Team Gold", tagId: "soccer" } } },
      ],
      result: { id: "9003", stats: { home_score: 1, away_score: 1 } },
    },
    {
      id: 9004,
      kickoff: "2026-11-06T20:00:00.000Z",
      status: 1,
      season,
      participants: [
        { id: "1", side: "home", participant: { id: "5", player: { id: 1003, name: " ", nickname: "Gamma" }, team: { id: 703, name: "Team Green", tagId: "soccer" } } },
        { id: "2", side: "away", participant: { id: "20", player: { id: 1004, name: " ", nickname: "Delta" }, team: { id: 704, name: "Team Gold", tagId: "soccer" } } },
      ],
      result: { id: "9004", stats: { home_score: 0, away_score: 0 } },
    },
  ];
}

export function betikaMatches() {
  return {
    data: [
      {
        match_id: "12015779",
        game_id: "12015779",
        competition_id: "44877",
        competition_name: "GT Sports",
        home_team: "Bodoe/Glimt (Hulk)",
        away_team: "Fenerbahce Istanbul (Vito)",
        start_time: "2026-11-03 23:15:00",
        sport_id: "105",
        sport_name: "eSoccer",
        is_esport: true,
        odds: [
          {
            sub_type_id: "1",
            name: "1X2",
            odds: [
              { display: "1", odd_key: "Bodoe/Glimt (Hulk)", odd_value: "2.28", outcome_id: "1" },
              { display: "X", odd_key: "Draw", odd_value: "3.50", outcome_id: "2" },
              { display: "2", odd_key: "Fenerbahce Istanbul (Vito)", odd_value: "3.10", outcome_id: "3" },
            ],
          },
        ],
      },
      {
        match_id: "12015800",
        game_id: "12015800",
        competition_id: "43822",
        competition_name: "eAdriatic",
        home_team: "Red Foxes",
        away_team: "Blue Sharks",
        start_time: "2026-11-04 20:00:00",
        sport_id: "105",
        sport_name: "eSoccer",
        is_esport: true,
        odds: [
          {
            sub_type_id: "1",
            name: "1X2",
            odds: [
              { display: "1", odd_key: "Red Foxes", odd_value: "1.93", outcome_id: "1" },
              { display: "2", odd_key: "Blue Sharks", odd_value: "4.20", outcome_id: "3" },
            ],
          },
        ],
      },
    ],
  };
}

/** Route an upstream URL to the right fixture payload. */
export function providerResponse(url: string): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  if (url.includes("leaguerepublic.com")) return json(ealMatchHub());
  if (url.includes("gtleagues.com/api/sports")) return json(gtSports());
  if (url.includes("gtleagues.com/api/seasons")) return json(gtSeasons());
  if (url.includes("gtleagues.com/api/fixtures")) return json(gtFixtures());
  if (url.includes("betika.com")) return json(betikaMatches());
  return json({ error: "unmocked upstream" }, 404);
}
