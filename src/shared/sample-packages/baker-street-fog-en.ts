import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const bakerStreetFogEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `A dense November fog has settled over London, turning the streetlamps into dull amber blurs. At 221B Baker Street, the gas jets are already lit, coal crackles in the grate, and hansom wheels roll muffled over the wet cobbles below.

You serve as a field assistant to Baker Street. Three folded notes in Sherlock Holmes’s crisp hand lie on the table, the ink barely dry—half an hour ago he and Dr. Watson hurried south of the Thames to watch a lead, leaving three seemingly separate London errands for you to verify.

Mrs. Hudson has just set down a pot of hot tea when brisk boots clatter up the stairs. Inspector Lestrade of Scotland Yard bursts in, shaking fog from his coat, and slaps an old gold sovereign stamped with a tiny anchor mark onto the table. “Holmes slipped out again? Good—you’ll do. A Whitechapel pawnbroker took this in this morning under the name of Arthur Finch, the shipping clerk who vanished last night. Only the pawnbroker swears the man who pawned it was missing half his left little finger—nothing like Finch!”

From the street below come two sharp whistles. Wiggins, leader of the Baker Street Irregulars, waves up through the mist holding a copied call slip from the British Museum Reading Room.

Lestrade wipes his hat brim and eyes you. “My cab’s waiting at the kerb. Want to read Holmes’s notes first, call Wiggins up with that museum slip, or ride straight to Whitechapel with me now?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.baker-street-fog
  ref: current-situation
  title: Three urgent leads in the fog
  summary: While Holmes and Watson watch a south-bank lead, three London threads converge on 221B Baker Street.
  aliases: []
background:
  Time: November, Wednesday 3:40 p.m. (Day 1 of the great fog)
  Place: Sitting room, 221B Baker Street
  London fog: Thickening rapidly; visibility near the docks and Whitechapel will drop by dusk
Present:
  - { $ref: character.bs-assistant }
  - { $ref: character.bs-lestrade }
  - { $ref: character.bs-hudson }
Awaiting a response:
  Speaker: { $ref: character.bs-lestrade }
  Words: My cab’s waiting at the kerb. Want to read Holmes’s notes first, call Wiggins up with that museum slip, or ride straight to Whitechapel with me now?
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
  Knows: Thames Shipping clerk Arthur Finch failed to return home last night; this morning a Whitechapel pawnshop received an anchor-marked sovereign from a man missing half his left little finger who gave Finch’s name.
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
  Saw: At noon today, a gentleman in a grey overcoat and heavy gloves lingered twenty minutes by the opposite newsstand watching 221B’s windows, leaving for the underground only after Holmes and Watson drove off.
  Routine: Keeps collected evidence safe, receives wires from Holmes and Watson, and notes any visitors calling at the door.
`,
  },
  {
    path: "world/characters/wiggins.yaml",
    contents: `$document:
  id: character.bs-wiggins
  ref: wiggins
  title: Wiggins
  summary: Sharp-eyed leader of the Baker Street Irregulars, with eyes along every London wharf and railway arch.
  aliases: []
Location: { $ref: location.bs-221b }
Motive: Earn honest shillings and a word of praise from Holmes.
Knowledge:
  Knows: An 1874 Thames Shoals & Tides Almanac was signed out of the British Museum Reading Room yesterday afternoon under “A. Finch” in an awkward left-handed scrawl and never returned; ready to set boys watching the docks or pawnshop.
`,
  },
  {
    path: "world/characters/holmes-watson.yaml",
    contents: `$document:
  id: character.bs-holmes-watson
  ref: holmes-watson
  title: Holmes & Watson
  summary: Watching a south-bank lead; reachable by wire and ready to compare deductions back at 221B by evening.
  aliases: [Holmes, Watson]
Location: { $ref: location.bs-dock-warehouse }
Field notes left on table:
  Note 1 (Shipping clerk): Check the last three marine insurance policy numbers handled by Arthur Finch at Thames Shipping.
  Note 2 (Whitechapel coin): Establish where the tiny anchor countermark on the gold sovereign originates.
  Note 3 (Museum almanac): Determine which chart or page in the 1874 almanac the borrower was after.
Partnership: Happy to trade telegrams or compare findings by the fire at 221B without stealing the player’s deductions.
`,
  },
  {
    path: "world/characters/finch.yaml",
    contents: `$document:
  id: character.bs-finch
  ref: finch
  title: Arthur Finch
  summary: Honest clerk of Thames Shipping who vanished last night—held locked in an upper loft at Blackwater Bend Wharf.
  aliases: [Finch]
Location: { $ref: location.bs-barge-wharf }
Condition: Unharmed but locked in the loft after spotting fraudulent total-loss insurance entries made by his deputy manager (see @insurance-ring-truth).
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
Use: Read Holmes’s three notes, inspect physical evidence under a lens, ask Mrs. Hudson about the watcher across the street, dispatch Wiggins, or wire Holmes and Watson.
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
Clues: The broker confirms the man who pawned the anchor sovereign lacked half his left little finger, wore red sealing-wax dust and coal soot on his cuffs, spoke like a Thames lighterman, and bought a river ferry ticket east toward Blackwater Bend (see @anchor-coin-origin).
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
Clues: The call slip proves “A. Finch” signed left-handed and requested an estuary shoal chart alongside the 1874 almanac; the attendant remembers the borrower asking about high-tide depth off the disused Blackwater Bend barge wharf (see @almanac-cipher).
`,
  },
  {
    path: "world/locations/dock-warehouse.yaml",
    contents: `$document:
  id: location.bs-dock-warehouse
  ref: dock-warehouse
  title: Thames Shipping counting house & wharf
  summary: Red-brick dockside office where Arthur Finch’s desk still stands untouched.
  aliases: []
Clues: Blotting paper in Finch’s drawer holds reverse impressions of three “total-loss” marine policy numbers alongside deputy manager Marcus Vale’s private seal; a dock porter saw Vale speaking privately with a finger-maimed lighterman last evening (see @insurance-ring-truth).
`,
  },
  {
    path: "world/locations/barge-wharf.yaml",
    contents: `$document:
  id: location.bs-barge-wharf
  ref: barge-wharf
  title: Blackwater Bend barge wharf
  summary: Fog-shrouded disused river wharf holding a false-flagged lighter and a two-story timber loft.
  aliases: []
Scene: Arthur Finch is locked in the upper loft while the barge below loads prime tea and porcelain secretly stripped from an insured freighter; the maimed lighterman and Marcus Vale plan to slip out on tonight’s fog tide.
`,
  },
  {
    path: "world/case/case-ledger.yaml",
    contents: `$document:
  id: case.bs-ledger
  ref: case-ledger
  title: London case ledger
  summary: Records only physical evidence, leads, and informant ties the player has actually verified.
  aliases: []
Verified evidence:
  Anchor-marked sovereign: Brought by Lestrade from a Whitechapel pawnshop; pawned under Arthur Finch’s name by a man missing half his left little finger.
  Museum call slip: Copied by Wiggins, pointing to an unreturned 1874 maritime almanac at the British Museum.
Open leads:
  - Read Holmes’s three folded field notes on the table
  - Question the Whitechapel pawnbroker about the pledger’s description and destination
  - Inspect Arthur Finch’s last paperwork at Thames Shipping
Informants & ties:
  Inspector Lestrade: Eager to close the case, offering his cab now
  Wiggins (Irregulars): Ready to tail suspects or watch any London wharf
  Mrs. Hudson: Keeping 221B and noting callers outside
`,
  },
  {
    path: "world/archives/anchor-coin-origin.yaml",
    contents: `$document:
  id: archive.bs-anchor-coin
  ref: anchor-coin-origin
  title: Origin of the anchor-marked sovereign
  summary: Second-layer physical lead, read on demand only when checking the pawnshop, examining the coin, or consulting Holmes.
  aliases: []
Discovery condition: The player questions the Whitechapel pawnbroker closely, examines the countermark at 221B, or wires Holmes.
Truth:
  - Old sovereigns countermarked with a microscopic anchor serve as retainer tokens issued by Thames Shipping deputy manager Marcus Vale to crooked lightermen, redeemable for full pay at Blackwater Bend Wharf.
  - The maimed lighterman pawned one for drink money and impulsively gave the name of their captive clerk, Finch—handing Scotland Yard and Baker Street their first break.
`,
  },
  {
    path: "world/archives/almanac-cipher.yaml",
    contents: `$document:
  id: archive.bs-almanac-cipher
  ref: almanac-cipher
  title: The 1874 almanac & Blackwater channel
  summary: Second-layer lead, read on demand only when visiting the British Museum Reading Room or checking call slips.
  aliases: []
Discovery condition: The player inspects the call slip and questions the Reading Room attendant about the missing 1874 almanac.
Truth:
  - Page 88 of the 1874 Thames Shoals & Tides Almanac charts an abandoned deep channel off Blackwater Bend that lets a barge bypass customs launches on a foggy high tide.
  - Vale’s confederate borrowed the volume under Finch’s name to time tonight’s smuggling run.
`,
  },
  {
    path: "world/archives/insurance-ring-truth.yaml",
    contents: `$document:
  id: archive.bs-insurance-ring
  ref: insurance-ring-truth
  title: Truth of the Thames Shipping insurance plot
  summary: Endgame truth, read on demand only when checking the counting house, freeing Finch, or comparing all three threads with Holmes.
  aliases: []
Discovery condition: The player reads the blotting paper at Thames Shipping, compares notes with Holmes and Watson, or reaches Blackwater Bend Wharf.
Truth:
  Mastermind: Deputy manager Marcus Vale colluded with river smugglers to offload insured tea and porcelain onto a hidden lighter in tonight’s fog, then ground the stripped freighter to collect a fraudulent total-loss payout.
  Abduction: Honest clerk Arthur Finch spotted the discrepancy in the policy ledger and was seized by the maimed lighterman to frame him as a runaway embezzler once the ship went down.
Resolutions: Raid the wharf with Lestrade, set a fog-tide ambush with Holmes and Watson to catch Vale red-handed, or slip Finch out first with Wiggins’s help before exposing Vale publicly.
`,
  },
  ...storyControlFiles(
    "en",
    "baker-street-221b",
    `# A Study in Grey Fog (Long-Form Detective Interactive Fiction)

Run this as a pure narrative Victorian London investigation driven by observation, questioning, physical cross-checks, and smart use of informants rather than dice rolls. Keep the brisk dialogue, sharp deduction, and fog-bound atmosphere of Conan Doyle’s canon.

## Information Discipline & Long-Form Case Tracking

- Record only verified evidence and attributed witness accounts in @case-ledger; never leak unvisited locations or the mastermind’s identity early to the player or Lestrade.
- Update @current-situation as London hours, districts, and fog visibility shift; record lasting trust shifts in @relationships and active plans or surveillance assignments in @pending-matters.

## On-Demand Reading & Multi-Thread Investigation

- Beyond the @baker-street-221b hub, read the other four London locations and the three archive dossiers (@anchor-coin-origin, @almanac-cipher, @insurance-ring-truth) on demand via context_read only when the player investigates them.
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
              id: "verified-evidence",
              label: "Verified evidence",
              document: "case-ledger",
              locator: ["Verified evidence"],
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
