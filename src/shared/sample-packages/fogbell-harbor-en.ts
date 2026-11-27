import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const fogbellHarborEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `The steam ferry’s whistle dies in the ice fog, swallowed by the swell. It’s the last ferry before the winter closure. The next supply steamer is due at dawn, seven nights from now.

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
  title: Current situation at Fogbell Harbor
  summary: The time, place, people present, and what awaits a response in the Fogbell Harbor investigation.
  aliases: []
background:
  Time: Day 1, dusk
  Place: Fogbell Harbor jetty (road to Fogbell Inn)
  Weather and isolation: Heavy ice fog and drifting floes; scheduled sailings out of the harbor are suspended
Present:
  - { $ref: character.fogbell-investigator }
  - { $ref: character.fogbell-colin }
  - { $ref: character.fogbell-mae }
Pending decision:
  Choice: How will the investigator respond to Colin’s request to sign the register? Will they settle in at the inn or stay on the jetty to ask questions?
  Scene: Colin holds out the damp landing register and dip pen; a few steps away, Mae holds a soup pail after quietly mentioning the three bell tolls and green light from the night before the investigator landed.
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
  Athletics: 55
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
Motive: Wants the investigator to sign off on two years of routine lamp-oil tallies and board the next steamer without digging into the old Seagull wreck.
Behavior: Courteous and hospitable on the surface; invokes winter safety rules whenever pressed about the lighthouse key or the old wreck, while quietly tracking the player's visits.
Knowledge:
  Knows: Keeper Bram questioned an irregular lamp-oil write-off from the year the Seagull sank, then vanished with the original logbook. Colin does not know where Bram went.
  Misreads: Assumes the green light on the night before the investigator landed came from a trespasser sheltering from the cold.
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
  Saw: Around 11:30 p.m. on the night before the investigator landed, in dead calm, the iron fogbell tolled three low notes while two short flashes of green light showed from the lighthouse lantern room.
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
  Limits: Does not know where Bram is hiding, though Bram borrowed a roll of waxed canvas and two tins of hardtack the week before the investigator landed.
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
Motive: Wants to verify the physical cause of the fogbell's calm-night tolling and worries about Bram, who helped haul her barometer a month before the investigator landed and mentioned hollow echoes beneath the lighthouse cellar.
Behavior: Direct and evidence-driven; gladly shares barograph strips, tide charts, and her brass telescope with anyone who trades firsthand observations.
Knowledge:
  Readings: Around 11:30 p.m. on the night before the investigator landed, during a sharp barometric drop, her recorder logged an 18 Hz pulse from the direction of Wreck Reef two seconds before the harbor fogbell resonated three times.
  Hypothesis: Suspects a submerged metal chamber or wrecked bell shares the fogbell's resonant frequency. She plans to consult the inn's tide table and check once the reef bed is exposed.
`,
  },
  {
    path: "world/characters/keeper.yaml",
    contents: `$document:
  id: character.fogbell-keeper
  ref: keeper
  title: Bram
  summary: The old lighthouse keeper, missing since three days before the investigator landed.
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
Use: Rest to recover Vigor and relieve Stress, trade rumors with Mae, review notes, or inspect the public oil ledgers Colin sends over.
Visible leads: The taproom noticeboard posts this month's tide table, a steamer notice, and the ten-year-old relief list from the Seagull wreck.
Public schedule:
  Day count: The investigator's landing is Day 1.
  Lowest tide: The Day 5 spring ebb is the lowest tide of the season and exposes the stone causeway to Wreck Reef from roughly midafternoon to early evening. It is the only chance during the closure to explore the reef bed on foot.
  Supply steamer: The next supply steamer arrives at Day 8 dawn, after seven nights of closure.
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
Lantern room: Three pages have been torn from the desk supply book. At the time of the investigator's landing, the green glass filter in the wall cabinet still bears fresh fingerprints, evidence of a visit before the landing.
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
Clues: The acoustic strip from the night before the investigator landed shows that the pulse originated underwater at Wreck Reef two seconds before the harbor bell rang. Sweeping the telescope across the stranded barge reveals a corner of dark-green waxed canvas, freshly lashed at the time of the investigator's landing (a Spot check confirms someone is living aboard).
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
  Bram's hand, written four days before the investigator landed: "Lamp did not
  fail—it was put out. Old bell lies below; look at low water."
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
Access:
  Skiff: Take Harlan as a guide or row the skiff through the nearshore ice. Use Mechanics to repair the rudder pin and Athletics if rowing through the floes is risky.
  Causeway: At the lowest tide shown on the inn's tide table, a slick stone causeway to the reef bed is exposed. Use an Athletics check for safe passage if surf, ice, or a turning tide presents a real risk.
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
Gathered leads:
  Missing keeper: Keeper Bram vanished three days before the investigator landed, leaving an unsigned supply handover slip.
  Calm-night toll and green light: At the landing, Mae quietly reported that the fogbell tolled three times in dead calm on the night before the investigator landed while a green light shone in the lighthouse.
Open questions:
  - Did Bram meet with an accident or go into hiding, and who lit the green lamp on the night before the investigator landed?
  - Why is Harbor Master Colin so eager to keep outsiders away from the old lighthouse?
  - What caused the iron fogbell to toll in dead calm?
Faction stances:
  Harbor Master Colin: Cordial at the landing; promised the ledgers at first light the next day and advised keeping clear of the old lighthouse
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
  title: Seagull wreck archive
  summary: Background record linking the Seagull wreck ten winters ago with harbor accounts and cargo markings.
  aliases: []
Facts:
  - Ten winters ago, the Seagull's insured copper cargo was quietly swapped for scrap iron by the cargo owners and Colin.
  - Colin sent the previous keeper away on a false repair errand and doused the main lighthouse lamp for half an hour so the vessel would ground on Wreck Reef, then ran the salvage write-off himself and used the payout to lock down the harbor's supply trade.
  - Before his disappearance, Bram uncovered an unburned carbon leaf of the original logbook while clearing the oil store. He went into hiding with the evidence after Colin sounded him out and threatened him.
Active plan: If the player has neither uncovered nor stopped the plan, Colin will send hired hands by skiff late on Day 3 to smash the double-stamped crate seals on Wreck Reef before the next supply steamer arrives.
`,
  },
  {
    path: "world/archives/keeper-logbook.yaml",
    contents: `$document:
  id: archive.fogbell-keeper-log
  ref: keeper-logbook
  title: Keeper Bram's original logbook
  summary: The original lighthouse logbook from the year of the Seagull wreck, with keeper Bram's observation notes.
  aliases: []
Location: Carried by Bram aboard the stranded barge on Wreck Reef.
Contents:
  Evidence leaf: Logs the exact 32-minute blackout and oil-level readings on the night the Seagull sank, disproving the official accident ruling.
  Anomaly notes: In the back pages, Bram logged over a dozen low-pressure cellar hums during the six months before he disappeared and sketched tidal marks behind the lighthouse cellar door. The marks indicate that the old bell can be seen when the lowest tide exposes the reef bed.
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
- Update @protagonist when Vigor, Stress, or Gear changes. For physical challenges, use the investigator's Athletics skill and set the difficulty from the circumstances. Track the current time at background / Time in @current-situation, update its body when the location changes, and keep its title stable. Record leads the player has gathered in @investigation-board and distinguish direct observations, attributed testimony, and verified findings. Date clues relative to fixed events such as the landing.

## On-Demand Reading & Seven-Day Cadence

- Use context_read for locations beyond the inn and for archives as the investigation needs them. Reveal secrets once the player's observations or evidence support them.
- Advance time through morning, afternoon, dusk, and late night across the seven days. Follow the public schedule in @fogbell-inn for the tide window and the steamer's arrival. Before advancing to the third night, use context_read to check the private plan and its conditions in @wreck-insurance-truth. Let the investigation determine whether it goes ahead, and stop when the player has a meaningful decision to make.
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
              label: "Gathered leads",
              document: "investigation-board",
              locator: ["Gathered leads"],
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
