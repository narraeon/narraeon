import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const fogbellHarborEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `The steam ferry’s whistle dies in the ice fog, swallowed by the swell. It is the last boat before winter drift seals the cove; the next supply steamer will not return for seven nights—until dawn on Day 8.

The shipping guild hired you to audit the old lighthouse ledger after the keeper vanished three days ago, leaving only an unsigned handover slip. A storm lantern swings at the end of the jetty. High above the quay, the iron fogbell hangs motionless in the mist.

Harbor Master Colin steps forward in a heavy wool coat, holding out a damp landing register. “Welcome to Fogbell Harbor. I’ll have the books sent to the inn at first light. Rough weather ahead—best settle in at the Fogbell Inn tonight and keep clear of the lighthouse.”

A few paces back, Mae from the inn lowers her gaze from the headland. While Colin fumbles for his pen, she gives you the slightest shake of her head and murmurs, “Dead calm last night, and the fogbell tolled three times on its own. Saw a green light up in the lantern room, too.”

Colin looks up and offers the pen. “Just a signature to start. Heading straight to the inn, or is there something you’d like to ask first?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.fogbell-harbor
  ref: current-situation
  title: First night of the ice seal
  summary: The investigator steps onto Fogbell Harbor's jetty as the harbor master and innkeeper give conflicting advice.
  aliases: []
background:
  Time: Day 1, dusk (7 nights until the steamer returns at dawn on Day 8)
  Place: Fogbell Harbor jetty (road to Fogbell Inn)
  Weather and isolation: Heavy ice fog and drifting floes; no vessel can leave for seven days
Present:
  - { $ref: character.fogbell-investigator }
  - { $ref: character.fogbell-colin }
  - { $ref: character.fogbell-mae }
Awaiting a response:
  Speaker: { $ref: character.fogbell-colin }
  Words: Just a signature to start. Heading straight to the inn, or is there something you’d like to ask first?
  Scene: Colin holds out the damp landing register and dip pen; a few steps away, Mae holds a soup pail after quietly mentioning last night's three bell tolls and green lantern light.
Seven-day clock:
  Day: 1
  Period: Dusk
  Upcoming shifts:
    Day 3 night: Unless spotted or stopped, Colin sends hired hands to Wreck Reef to destroy old crate seals.
    Day 5 spring ebb: The lowest tide exposes the resonance cavity beneath Wreck Reef—the only walkable window.
    Day 8 dawn: The supply steamer returns after seven sealed nights.
`,
  },
  {
    path: "world/characters/investigator.yaml",
    contents: `$document:
  id: character.fogbell-investigator
  ref: protagonist
  title: The investigator
  summary: Outside auditor hired by the shipping guild to check the old lighthouse books; name and past are open to the player.
  aliases: []
Condition:
  Vigor: 10 / 10 (Uninjured)
  Stress: 0 / 10 (Steady)
Skills:
  Spot: 65
  Persuade: 60
  Lore: 55
  Mechanics: 50
  Stealth: 45
  Resolve: 60
Gear:
  - Guild audit warrant (wax-sealed)
  - Storm lantern and windproof matches
  - Field notebook and pencil
Authority: May audit public lighthouse supply records and interview townsfolk; holds no police power to force entry or detain anyone.
`,
  },
  {
    path: "world/characters/harbor-master.yaml",
    contents: `$document:
  id: character.fogbell-colin
  ref: harbor-master
  title: Harbor Master Colin
  summary: Polished harbor official determined to keep the audit confined to recent oil receipts.
  aliases: [Colin]
Motive: Wants the investigator to sign off on two years of routine lamp-oil tallies and board the next steamer without uncovering the ten-year-old Seagull wreck insurance scheme.
Behavior: Courteous and hospitable on the surface; invokes winter safety rules whenever pressed about the lighthouse key or the old wreck, while quietly tracking the player's visits.
Knowledge:
  Knows: Keeper Bram questioned an irregular ten-year-old lamp-oil write-off shortly before vanishing with the original logbook. Colin does not know Bram is hiding in the stranded barge off Wreck Reef.
  Misreads: Assumes last night's green light was a trespasser sheltering from the cold, unaware Bram is signaling with an old green lens filter.
`,
  },
  {
    path: "world/characters/innkeeper.yaml",
    contents: `$document:
  id: character.fogbell-mae
  ref: innkeeper
  title: Mae
  summary: Proprietor of the Fogbell Inn and the harbor's sharpest listener, uneasy over Bram's disappearance.
  aliases: []
Motive: Knows Bram is too conscientious to vanish without a word; wants an outsider to learn the truth without openly crossing Colin, who controls winter supply allocations.
Behavior: Guarded in public, candid behind the inn counter. Will introduce the player to Harlan at the boatyard and Vera at the weather station.
Knowledge:
  Saw: Around 11:30 p.m. last night, in dead calm, the iron fogbell tolled three low notes while two short flashes of green light showed from the lighthouse lantern room.
  Heard: Knows shipwright Harlan repaired the Seagull's lifeboat ten years ago and stopped talking about that night ever since.
`,
  },
  {
    path: "world/characters/shipwright.yaml",
    contents: `$document:
  id: character.fogbell-shipwright
  ref: shipwright
  title: Harlan
  summary: Veteran shipwright at the boatyard, taciturn and cautious, with a stout ice-sheathed skiff.
  aliases: []
Motive: Wants to protect his yard and young apprentice from losing spring timber permits controlled by Colin; will speak honestly if shown real good faith or a way to shield his apprentice.
Behavior: Suspicious of strangers; planes timber and changes the subject when the Seagull comes up, but respects practical craft and kept promises.
Knowledge:
  Knows: On the night the Seagull struck Wreck Reef ten years ago, the lighthouse main lamp went dark half an hour early; salvaged crates bore double lot stamps. Two pages of his yard ledger were sliced out by Colin himself.
  Limits: Does not know where Bram is hiding, though Bram borrowed a roll of waxed canvas and two tins of hardtack last week.
`,
  },
  {
    path: "world/characters/meteorologist.yaml",
    contents: `$document:
  id: character.fogbell-meteorologist
  ref: meteorologist
  title: Vera
  summary: Young researcher staffing the cliff weather station, tracking the harbor's anomalous low-frequency hum.
  aliases: []
Motive: Wants to verify the physical cause of the fogbell's calm-night tolling and worries about Bram, who helped haul her barometer last month and mentioned hollow echoes beneath the lighthouse cellar.
Behavior: Direct and evidence-driven; gladly shares barograph strips, tide charts, and her brass telescope with anyone who trades firsthand observations.
Knowledge:
  Readings: Around 11:30 p.m. last night, during a sharp barometric drop, her recorder logged an 18 Hz pulse from the direction of Wreck Reef two seconds before the harbor fogbell resonated three times.
  Hypothesis: Suspects a submerged metal chamber or wrecked bell shares the fogbell's resonant frequency, verifiable only at the Day 5 spring ebb.
`,
  },
  {
    path: "world/characters/keeper.yaml",
    contents: `$document:
  id: character.fogbell-keeper
  ref: keeper
  title: Bram
  summary: The missing lighthouse keeper, hiding inside a stranded barge on the north side of Wreck Reef.
  aliases: []
Location: { $ref: location.fogbell-wreck-reef }
Condition: Sheltering under waxed canvas with hardtack and the original ten-year-old lighthouse logbook; stiff from the cold but clear-headed.
Motive: Wants to hand the original logbook directly to a trustworthy guild auditor (see @keeper-logbook) and warn them about the sealed cellar beneath the lighthouse.
Action: Slips back to the lighthouse lantern room on select nights to flash a green filter toward the inn, testing whether an honest outsider has arrived.
`,
  },
  {
    path: "world/locations/fogbell-inn.yaml",
    contents: `$document:
  id: location.fogbell-inn
  ref: fogbell-inn
  title: Fogbell Inn
  summary: The harbor's sole inn and investigative hub, with a warm hearth and evening sailor gossip.
  aliases: []
Layout: A hearthside taproom below; seaward rooms upstairs overlook both the old lighthouse lantern room and the iron fogbell frame.
Use: Rest to recover Vigor and Stress, trade rumors with Mae, review notes, or inspect the public oil ledgers Colin sends over.
Visible leads: The taproom noticeboard posts this month's tide table (marking Day 5 as the season's lowest spring ebb) and a ten-year-old relief list from the Seagull wreck.
`,
  },
  {
    path: "world/locations/old-lighthouse.yaml",
    contents: `$document:
  id: location.fogbell-lighthouse
  ref: old-lighthouse
  title: Old lighthouse
  summary: Stone tower on the headland, padlocked shut, with a boarded-over cellar door at its base.
  aliases: []
Access: The front door wears a fresh brass padlock fitted by Colin (requires a key, persuasion, or a Mechanics/Stealth check); a seaward vent grate is rusted loose.
Lantern room: Three pages have been torn from the desk supply book, and a green glass filter in the wall cabinet bears fresh fingerprints—proof someone visited recently.
Boarded cellar: A low hum slightly out of step with the surf vibrates behind the planks; prying them open takes tools and a check, revealing an older observation stele tied to Wreck Reef (see @resonance-chamber).
`,
  },
  {
    path: "world/locations/boatyard.yaml",
    contents: `$document:
  id: location.fogbell-boatyard
  ref: boatyard
  title: Boatyard
  summary: Half-covered slipway stacked with pine planks and rusted chain, worked by Harlan and his apprentice.
  aliases: []
Resources: An iron-sheathed skiff sits on the ways; with Harlan's backing or a repaired rudder pin it can cross the floes to Wreck Reef.
Clues: A ten-year-old repair ledger sits on the shed shelf with two November pages sliced clean out, but carbon impressions on the following sheet still read "Seagull / double lead seals / signed Colin" (a Spot check makes them out).
`,
  },
  {
    path: "world/locations/weather-station.yaml",
    contents: `$document:
  id: location.fogbell-weather-station
  ref: weather-station
  title: Cliff weather station
  summary: Timber observation hut overlooking the cove where Vera logs wind, pressure, and tides.
  aliases: []
Equipment: High-power brass telescope (clear line of sight to the lighthouse lantern room and the stranded barge on Wreck Reef), drum barograph, and low-frequency acoustic strip recorder.
Clues: The acoustic strip proves the pulse originated underwater at Wreck Reef two seconds before the harbor bell rang; sweeping the telescope across the stranded barge reveals a corner of freshly lashed dark-green waxed canvas (a Spot check confirms someone is living aboard).
`,
  },
  {
    path: "world/locations/sailors-chapel.yaml",
    contents: `$document:
  id: location.fogbell-chapel
  ref: sailors-chapel
  title: Sailors' chapel
  summary: Small stone hillside chapel lined with brass plaques for lost ships.
  aliases: []
Clues: >-
  Tucked inside the prayer book beneath the Seagull plaque is a penciled note in
  Bram's hand from four days ago: "Lamp did not fail—it was put out. Old bell
  lies below; look at low water."
Routine: Unattended by day and quiet at dusk—a safe spot for private meetings.
`,
  },
  {
    path: "world/locations/wreck-reef.yaml",
    contents: `$document:
  id: location.fogbell-wreck-reef
  ref: wreck-reef
  title: Wreck Reef
  summary: Offshore shoal holding a half-rotted stranded barge on its north shelf and the Seagull wreck below.
  aliases: []
Access: Normally reachable only by skiff through drifting ice (Mechanics/Vigor check or Harlan's help); on the Day 5 spring ebb, a slick stone causeway uncovers for foot crossing.
Stranded barge: Bram's shelter, curtained with waxed canvas and hiding the original logbook (@keeper-logbook).
Submerged wreck and cavity: At spring ebb, the Seagull's split hold reveals double-stamped smuggling crates alongside a massive older bronze bell wedged deep in the reef fissure (@resonance-chamber).
`,
  },
  {
    path: "world/case/investigation-board.yaml",
    contents: `$document:
  id: case.fogbell-board
  ref: investigation-board
  title: Investigation board
  summary: Records only observations, testimony, and faction stances the player has actually established.
  aliases: []
Confirmed clues:
  Missing keeper: Keeper Bram vanished three days ago, leaving an unsigned supply handover slip.
  Calm-night toll and green light: Mae quietly reported that the fogbell tolled three times in dead calm last night while a green light shone in the lighthouse.
Open questions:
  - Did Bram meet with an accident or go into hiding, and who lit the green lamp?
  - Why is Harbor Master Colin so eager to keep outsiders away from the old lighthouse?
  - What caused the iron fogbell to toll in dead calm?
Faction stances:
  Harbor Master Colin: Cordial on the surface, quietly watchful
  Innkeeper Mae: Friendly, willing to help privately
  Shipwright Harlan: Not yet met
  Researcher Vera: Not yet met
`,
  },
  {
    path: "world/archives/wreck-insurance-truth.yaml",
    contents: `$document:
  id: archive.fogbell-wreck-truth
  ref: wreck-insurance-truth
  title: Truth of the Seagull insurance wreck
  summary: What happened ten winters ago when the Seagull sank and Colin's active plan.
  aliases: []
Facts:
  - Ten winters ago, the Seagull's insured copper cargo was quietly swapped for scrap iron by the cargo owners and Colin.
  - Colin sent the previous keeper away on a false repair errand and doused the main lighthouse lamp for half an hour so the vessel would ground on Wreck Reef, then ran the salvage write-off himself and used the payout to lock down the harbor's supply trade.
  - Bram uncovered an unburned carbon leaf of the original logbook while clearing the oil store, drew Colin's suspicion, and went into hiding with the evidence.
Active plan: Unless intercepted, Colin intends to send hired hands on Day 3 night to smash the double-stamped crate seals on Wreck Reef before the Day 8 dawn steamer arrives.
`,
  },
  {
    path: "world/archives/keeper-logbook.yaml",
    contents: `$document:
  id: archive.fogbell-keeper-log
  ref: keeper-logbook
  title: Keeper Bram's original logbook
  summary: Physical logbook carried by Bram inside his waxed-canvas bundle on the stranded barge.
  aliases: []
Location: Carried by Bram aboard the stranded barge on Wreck Reef.
Contents:
  Evidence leaf: Logs the exact 32-minute blackout and oil-level readings on the night the Seagull sank, disproving the official accident ruling.
  Anomaly notes: In the back pages, Bram logged over a dozen low-pressure cellar hums over the past six months and sketched tidal marks behind the lighthouse cellar door pointing to an "old bell visible at Day 5 spring ebb."
`,
  },
  {
    path: "world/archives/resonance-chamber.yaml",
    contents: `$document:
  id: archive.fogbell-resonance
  ref: resonance-chamber
  title: The fogbell resonance cavity and stele
  summary: Physical origin of the calm-night bell tolls and the inscription inside the lighthouse cellar.
  aliases: []
Facts:
  Mechanism and history: The harbor's iron fogbell was cast two centuries ago as half of a tidal warning pair; its larger bronze twin fell into the reef fissure during an earlier ice slide and wedged across a sea cave running beneath the lighthouse foundation.
  Resonance effect: When severe low pressure coincides with a spring ebb, surge through the sea cave generates an 18 Hz infrasonic standing wave that sets both bells tolling in dead calm, loosening stone and causing vertigo or auditory hallucinations up close.
  Old stele: An older stone marker in the lighthouse cellar explains how to wedge the vent shaft closed to silence the hum, or leave it open as a natural storm warning.
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "d100" }),
  ...storyControlFiles(
    "en",
    "fogbell-inn",
    `# Seven Days at Fogbell Harbor (d100 Long-Form Investigation)

Run this as a seven-day coastal tabletop sandbox with a grounded gothic atmosphere and clear investigative pacing. Let the player choose where to go each period, how to investigate, whom to trust, and how to resolve the harbor's secrets.

## d100 Resolution & State Tracking

- Narrate routine conversation and obvious observations without rolling. Call for a d100 check only when there is genuine risk, time pressure, or opposition (forcing a lock, sneaking into the tower, pressing a guarded witness, rowing through floes, reading faint carbon impressions, or steadying nerves against infrasonic resonance), referencing @protagonist's Skills and stating the target clearly.
- Always fail forward: a failed roll should never dead-end the mystery; instead spend extra time, inflict Vigor or Stress loss, alert Colin's watchers, or force an alternate route to the clue.
- Update @protagonist whenever Vigor, Stress, or Gear changes; update @current-situation whenever time, place, or the seven-day clock advances; record only verified player discoveries in @investigation-board.

## On-Demand Reading & Seven-Day Cadence

- Beyond the @fogbell-inn hub, read the other five locations and the three archive files (@wreck-insurance-truth, @keeper-logbook, @resonance-chamber) on demand via context_read only when the player visits or probes those leads—never spoil them early.
- Advance time in Morning, Afternoon, and Night periods across seven days; let Day 3 night, Day 5 spring ebb, and Day 8 dawn shift the situation naturally, pausing wherever the player can make a meaningful decision.
`,
    ["investigation-board"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "investigator-sheet",
          title: "Investigator",
          items: [
            {
              id: "vitality",
              label: "Condition",
              document: "protagonist",
              locator: ["Condition"],
            },
            {
              id: "skills",
              label: "Skills (d100)",
              document: "protagonist",
              locator: ["Skills"],
            },
            {
              id: "gear",
              label: "Gear",
              document: "protagonist",
              locator: ["Gear"],
            },
          ],
        },
        {
          id: "investigation-progress",
          title: "Investigation",
          items: [
            {
              id: "confirmed-clues",
              label: "Confirmed clues",
              document: "investigation-board",
              locator: ["Confirmed clues"],
            },
            {
              id: "open-mysteries",
              label: "Open questions",
              document: "investigation-board",
              locator: ["Open questions"],
            },
            {
              id: "factions",
              label: "Faction stances",
              document: "investigation-board",
              locator: ["Faction stances"],
            },
          ],
        },
      ],
    },
  ),
];
