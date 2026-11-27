import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const bakerStreetFogEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `A dense November fog has settled over London, turning the streetlamps into dull amber blurs. At 221B Baker Street, the gas jets are already lit, coal crackles in the grate, and hansom wheels roll muffled over the wet cobbles below. It is twenty to four in the afternoon on Wednesday, 15 November.

You serve as a field assistant to Baker Street. Three folded notes in Sherlock Holmes’s crisp hand lie on the table, the ink barely dry—half an hour ago he and Dr. Watson hurried south of the Thames to watch a lead, leaving three seemingly separate London errands for you to verify.

Your landlady, Mrs. Hudson, has just set down a pot of hot tea when brisk boots clatter up the stairs. Inspector Lestrade of Scotland Yard bursts in, shaking fog from his coat, and slaps an old gold sovereign stamped with a tiny anchor mark on its rim onto the table. “Holmes slipped out again? Good—you’ll do. A Whitechapel pawnbroker took this in this morning under the name of Arthur Finch, the shipping clerk who vanished last night. Only the pawnbroker swears the man who pawned it was missing half his left little finger—nothing like Finch!”

From the street below come two sharp whistles. Wiggins, leader of the Baker Street Irregulars, waves up through the mist holding a copied call slip from the British Museum Reading Room.

Lestrade wipes his hat brim and eyes you. “My cab’s waiting at the kerb. Want to read Holmes’s notes first, call Wiggins up with that museum slip, or ride straight to Whitechapel with me now?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.baker-street-fog
  ref: current-situation
  title: Current situation
  summary: Tracks the investigation’s immediate setting and decisions still awaiting the player.
  aliases: []
background:
  Time: Wednesday, 15 November, 3:40 p.m. (Day 1 of the great fog)
  Place: Sitting room, 221B Baker Street
  London fog: Thickening rapidly; visibility near the docks and Whitechapel will drop by dusk
Present:
  - { $ref: character.bs-assistant }
  - { $ref: character.bs-lestrade }
  - { $ref: character.bs-hudson }
Pending decision:
  Asked by: { $ref: character.bs-lestrade }
  Choice: Read Holmes’s folded notes, invite Wiggins up to examine his copied slip, or take Lestrade’s waiting cab to the Whitechapel pawnshop.
  Scene: Holmes’s three folded field notes and Lestrade’s anchor-stamped sovereign sit on the table; outside, Wiggins waves a British Museum call slip from the street.
`,
  },
  {
    path: "world/characters/assistant.yaml",
    contents: `$document:
  id: character.bs-assistant
  ref: protagonist
  title: Baker Street field assistant
  summary: Field investigator assisting Holmes and Watson across London; name and background are open to the player.
  aliases: []
Standing: Acts with Holmes’s signed letter of introduction; can dispatch the Baker Street Irregulars for street surveillance or accompany Lestrade under Scotland Yard authority.
Carrying:
  - Holmes’s wax-sealed introduction and pocket lens
  - Pocket map of London and stout notebook
  - Cab fare and shillings for informants
`,
  },
  {
    path: "world/characters/lestrade.yaml",
    contents: `$document:
  id: character.bs-lestrade
  ref: lestrade
  title: Inspector Lestrade
  summary: Tenacious, pragmatic Scotland Yard inspector investigating the missing shipping clerk.
  aliases: [Lestrade]
Motive: Close the clerk’s disappearance before the papers turn it into a City scandal; though prickly about Baker Street’s methods, he respects solid results.
Behavior: Prefers making an early arrest unless shown a clear chain of evidence justifying a quieter trap.
Knowledge:
  Knows: Thames Shipping clerk Arthur Finch failed to return home on the night of Tuesday, 14 November. On Wednesday morning, 15 November, the Whitechapel pawnbroker told Lestrade that a man missing half his left little finger had pledged an anchor-marked sovereign under Finch’s name.
  Limits: Has not connected the pawnshop coin to the British Museum almanac or the dockside counting house.
`,
  },
  {
    path: "world/characters/hudson.yaml",
    contents: `$document:
  id: character.bs-hudson
  ref: hudson
  title: Mrs. Hudson
  summary: Landlady of 221B Baker Street, observant and quietly reliable.
  aliases: []
Knowledge:
  Saw: On Wednesday, 15 November, a gentleman in a grey overcoat and heavy gloves watched the doors and windows of 221B from the newsstand opposite for about twenty minutes, from 2:50 p.m. until Holmes and Watson drove off around 3:10 p.m. He then headed for the Underground station.
  Routine: Keeps collected evidence safe, receives wires from Holmes and Watson, and notes any visitors calling at the door.
`,
  },
  {
    path: "world/characters/wiggins.yaml",
    contents: `$document:
  id: character.bs-wiggins
  ref: wiggins
  title: Wiggins
  summary: Sharp-eyed leader of the Baker Street Irregulars.
  aliases: []
Location: { $ref: location.bs-221b }
Motive: Earn honest shillings and a word of praise from Holmes.
Knowledge:
  Knows: On the afternoon of Tuesday, 14 November, someone signed the 1874 Thames Shoals & Tides Almanac out of the British Museum Reading Room under “A. Finch” in an awkward scrawl that looks left-handed. It was still out when Wiggins copied the call slip on Wednesday, 15 November.
Help: Ready to set the Irregulars watching the docks or pawnshop.
`,
  },
  {
    path: "world/characters/holmes-watson.yaml",
    contents: `$document:
  id: character.bs-holmes-watson
  ref: holmes-watson
  title: Holmes & Watson
  summary: Investigative partners who work from 221B Baker Street.
  aliases: [Holmes, Watson]
Location: South of the Thames, watching a separate lead at an unspecified site.
Departure: Left 221B by cab around 3:10 p.m. on Wednesday, 15 November.
Field notes left on table:
  Note 1 (Shipping clerk): Check the last three marine insurance policy numbers handled by Arthur Finch at Thames Shipping.
  Note 2 (Whitechapel coin): Establish where the tiny anchor countermark on the gold sovereign originates.
  Note 3 (Museum almanac): Determine which chart or page the borrower wanted from the 1874 almanac and whether it was copied or removed.
Partnership: They can trade telegrams with the player and expect to compare findings by the fire at 221B on the evening of Wednesday, 15 November. They leave deductions to the player.
`,
  },
  {
    path: "world/characters/finch.yaml",
    contents: `$document:
  id: character.bs-finch
  ref: finch
  title: Missing shipping clerk
  summary: Person whose disappearance prompted the inquiry.
  aliases: []
Identity: Arthur Finch, a conscientious clerk at Thames Shipping.
Location: { $ref: location.bs-barge-wharf }
Condition: At 3:40 p.m. on Wednesday, 15 November, Finch is unharmed and locked in the upper loft at the wharf. He disappeared the previous night, Tuesday, 14 November, after spotting fraudulent total-loss insurance entries made by his deputy manager (see @shipping-records).
`,
  },
  {
    path: "world/locations/baker-street-221b.yaml",
    contents: `$document:
  id: location.bs-221b
  ref: baker-street-221b
  title: 221B Baker Street
  summary: Warm, cluttered investigative hub lined with scrapbooks, chemical apparatus, and telegraph forms.
  aliases: []
Use: Read Holmes’s three notes, examine evidence with the lens or chemical apparatus, ask Mrs. Hudson about any visitors or activity she has noticed, dispatch Wiggins, or wire Holmes and Watson.
`,
  },
  {
    path: "world/locations/whitechapel-pawnshop.yaml",
    contents: `$document:
  id: location.bs-pawnshop
  ref: whitechapel-pawnshop
  title: Whitechapel pawnshop
  summary: Narrow fog-bound shop whose meticulous broker logs every pledge and face.
  aliases: []
Clues: The broker says that on the morning of Wednesday, 15 November, the man who pawned the anchor sovereign lacked half his left little finger, wore red sealing-wax dust and coal soot on his cuffs, spoke like a Thames lighterman, and bought a ferry ticket east toward Blackwater Bend (see @pledge-records).
`,
  },
  {
    path: "world/locations/british-museum-room.yaml",
    contents: `$document:
  id: location.bs-museum
  ref: british-museum-room
  title: British Museum Reading Room
  summary: Quiet domed reading room where attendants preserve every call slip and return ledger.
  aliases: []
Clues: The call slip for Tuesday afternoon, 14 November, gives the name “A. Finch” and records a request for an estuary shoal chart alongside the 1874 almanac. The attendant saw the borrower sign left-handed and remembers him asking about high-tide depth off the disused Blackwater Bend barge wharf (see @reading-room-records).
`,
  },
  {
    path: "world/locations/dock-warehouse.yaml",
    contents: `$document:
  id: location.bs-dock-warehouse
  ref: dock-warehouse
  title: Dockside counting house & warehouse
  summary: Red-brick commercial premises in London’s dock district.
  aliases: []
Clues: At the Thames Shipping counting house, Arthur Finch’s desk remains untouched at the start of the inquiry on Wednesday, 15 November. Blotting paper in his drawer holds reverse impressions of three marine policy numbers marked for total-loss claims alongside deputy manager Marcus Vale’s private seal. A dock porter saw Vale speaking privately with a lighterman missing part of his left little finger on the evening of Tuesday, 14 November (see @shipping-records).
`,
  },
  {
    path: "world/locations/barge-wharf.yaml",
    contents: `$document:
  id: location.bs-barge-wharf
  ref: barge-wharf
  title: Old barge wharf
  summary: Disused landing and timber loft on a bend of the Thames.
  aliases: []
Name: Blackwater Bend barge wharf.
Scene at 3:40 p.m. on 15 November: Arthur Finch is already locked in the upper loft. A lighter flying a false cargo flag is moored below.
Plan for the night of 15 November: The lighterman missing part of his left little finger and Marcus Vale plan to load fine tea and porcelain stripped from the insured freighter, then depart on the night’s high tide under cover of fog.
`,
  },
  {
    path: "world/case/case-ledger.yaml",
    contents: `$document:
  id: case.bs-ledger
  ref: case-ledger
  title: London case ledger
  summary: Tracks the evidence, attributed testimony, open leads, and contacts the player knows about.
  aliases: []
Evidence in hand:
  Anchor-marked sovereign: Old gold coin with a tiny anchor on its rim, placed on the table by Lestrade at 221B.
Reported testimony:
  Missing shipping clerk: At 3:40 p.m. on Wednesday, 15 November, Lestrade said the clerk had disappeared on the night of Tuesday, 14 November.
  Whitechapel pledge: At the same meeting on 15 November, Lestrade relayed the pawnbroker’s account. That morning, a man missing half his left little finger pledged the coin and gave the missing clerk’s name.
Open leads:
  - Read Holmes’s three unopened field notes on the table
  - Call Wiggins up to examine his unread copy of a British Museum Reading Room call slip
  - Question the Whitechapel pawnbroker about the pledger’s description and destination
Informants & ties:
  Inspector Lestrade: Scotland Yard inspector who offered a ride to Whitechapel at 221B.
  Wiggins: Leader of the Baker Street Irregulars.
  Mrs. Hudson: Landlady of 221B Baker Street.
`,
  },
  {
    path: "world/archives/anchor-coin-origin.yaml",
    contents: `$document:
  id: archive.bs-anchor-coin
  ref: pledge-records
  title: Pledge records
  summary: Reference notes on a Whitechapel pawnshop transaction.
  aliases: []
Facts:
  Token purpose: Old sovereigns countermarked with a microscopic anchor on the rim serve as retainer tokens issued by Thames Shipping deputy manager Marcus Vale to crooked lightermen, redeemable for full pay at Blackwater Bend Wharf.
  Pawnshop slip: On the morning of Wednesday, 15 November, the lighterman missing part of his left little finger pawned one for drink money and impulsively gave the name of their captive clerk, Arthur Finch.
`,
  },
  {
    path: "world/archives/almanac-cipher.yaml",
    contents: `$document:
  id: archive.bs-almanac-cipher
  ref: reading-room-records
  title: Reading Room records
  summary: Reference notes on a British Museum loan.
  aliases: []
Facts:
  Almanac chart: Page 88 of the 1874 Thames Shoals & Tides Almanac charts an abandoned deep channel off Blackwater Bend that lets a barge bypass customs launches on a foggy high tide.
  Borrower: On the afternoon of Tuesday, 14 November, Vale’s confederate borrowed the volume under Finch’s name to time the smuggling run planned for the night of Wednesday, 15 November.
`,
  },
  {
    path: "world/archives/insurance-ring-truth.yaml",
    contents: `$document:
  id: archive.bs-insurance-ring
  ref: shipping-records
  title: Shipping records
  summary: Reference notes on dockside business and paperwork.
  aliases: []
Facts:
  Mastermind: Thames Shipping deputy manager Marcus Vale colluded with river smugglers. Under cover of fog on the night of Wednesday, 15 November, they plan to offload fine tea and porcelain from a heavily insured freighter onto a hidden lighter at Blackwater Bend for resale, then ground the stripped freighter to collect a fraudulent total-loss payout.
  Abduction: On the night of Tuesday, 14 November, Vale sent the lighterman missing part of his left little finger to seize Arthur Finch after Finch spotted the discrepancy in the policy ledger. Finch was locked in the loft at Blackwater Bend. Vale plans to pass him off as a runaway embezzler after the grounding.
`,
  },
  ...storyControlFiles(
    "en",
    "baker-street-221b",
    `# A Study in Grey Fog (Long-Form Detective Interactive Fiction)

Run this as a pure narrative Victorian London investigation driven by observation, questioning, physical cross-checks, and smart use of informants rather than dice rolls. Keep the brisk dialogue, sharp deduction, and fog-bound atmosphere of Conan Doyle’s canon.

## Information Discipline & Long-Form Case Tracking

- In @case-ledger, record examined evidence, attributed accounts, and still-unexamined leads under their separate headings. Add only what the player has learned and remove leads from the open list when resolved. Keep any undiscovered details, including the mastermind’s identity, out of player-facing narration and the ledger.
- Update the body of @current-situation as London hours, districts, and fog visibility shift. Keep its catalog title and summary usable across scenes, and clear decisions once answered. Record lasting trust shifts in @relationships and active plans or surveillance assignments in @pending-matters.

## On-Demand Reading & Multi-Thread Investigation

- Beyond the @baker-street-221b hub, read the other London locations, people, and archival records on demand via context_read when the player’s investigation reaches them. A catalog entry or a private account does not establish what the player or other characters know.
- Let the player tackle the three leads in any order, send Wiggins on surveillance, wire Holmes and Watson, and assemble the full case at their own pace.
`,
    ["case-ledger"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "london-case-board",
          title: "Case & evidence",
          items: [
            {
              id: "evidence-in-hand",
              label: "Evidence in hand",
              document: "case-ledger",
              locator: ["Evidence in hand"],
            },
            {
              id: "reported-testimony",
              label: "Reported testimony",
              document: "case-ledger",
              locator: ["Reported testimony"],
            },
            {
              id: "pending-leads",
              label: "Open leads",
              document: "case-ledger",
              locator: ["Open leads"],
            },
            {
              id: "informants",
              label: "Informants & ties",
              document: "case-ledger",
              locator: ["Informants & ties"],
            },
          ],
        },
      ],
    },
  ),
];
